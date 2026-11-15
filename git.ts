// The git object core: SHA-1 object ids, loose-object bytes, tree/commit/tag codecs, packfile
// read/write (with OFS/REF delta resolution), pkt-line framing, ancestry walks and tree diffs.
// Pure functions over an ObjectLookup; the store (store.ts) owns the maps these read from.
// No git binary is ever invoked: everything is computed here from the object bytes themselves.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 object id of a typed payload: sha1("<type> <len>\0<data>"). */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries (mode as written, e.g. "100644" or "40000"). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('corrupt tree: no mode terminator');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree: truncated entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories compare as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** Serialize entries into a tree object, in git's canonical order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Whether a tree entry mode names a subtree. */
export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Flatten a tree (recursively) into path -> {oid, mode}; paths use '/'. */
export function flattenTree(lookup: ObjectLookup, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, base: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (isTreeMode(entry.mode)) walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build a (nested) tree object from a flattened path map; returns the root tree's oid via `put`. */
export function buildTreeFromFlat(
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
  put: (type: ObjType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ------------------------------------------------------------------ commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parsed commits are memoized by buffer identity: stored object bytes never change. */
const commitParseCache = new WeakMap<Buffer, CommitView>();

export function parseCommit(data: Buffer): CommitView {
  const cached = commitParseCache.get(data);
  if (cached) return cached;
  const parsed = parseCommitFresh(data);
  commitParseCache.set(data, parsed);
  return parsed;
}

function parseCommitFresh(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

/** The committer/author timestamp (epoch seconds) out of an identity line, or 0. */
export function identityTime(identity: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(identity.trim());
  return match ? Number(match[1]) : 0;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

/** Peel an oid through tag objects to the commit it ultimately names (or null). */
export function peelToCommit(lookup: ObjectLookup, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Peel an oid through tag objects to the non-tag object it names (or null). */
export function peelTag(lookup: ObjectLookup, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return null;
}

// ------------------------------------------------------------------ graph walks

/** Every commit reachable from `tip` (tip included), following parents. */
export function ancestorsOf(lookup: ObjectLookup, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorsOf(lookup, descendant).has(ancestor);
}

/** The full object closure of the given tips: commits, their trees/blobs, and tag chains. */
export function collectReachable(lookup: ObjectLookup, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** A best common ancestor of two commits (deepest shared commit), or null when unrelated. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = ancestorsOf(lookup, a);
  if (ancestorsA.has(b)) return b;
  if (ancestorsOf(lookup, b).has(a)) return a;
  // BFS from b; the first shared commit at the shallowest depth from b, preferring the one
  // deepest in a's own ancestry (approximated by its distance from a's root side).
  const distA = new Map<string, number>();
  {
    const queue: Array<[string, number]> = [[a, 0]];
    distA.set(a, 0);
    while (queue.length) {
      const [oid, dist] = queue.shift() as [string, number];
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distA.has(parent)) {
          distA.set(parent, dist + 1);
          queue.push([parent, dist + 1]);
        }
      }
    }
  }
  const seen = new Set<string>([b]);
  const queue: Array<[string, number]> = [[b, 0]];
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (queue.length) {
    const [oid, dist] = queue.shift() as [string, number];
    if (dist > bestScore) break;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    if (distA.has(oid)) {
      const score = dist + (distA.get(oid) as number);
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
      continue;
    }
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push([parent, dist + 1]);
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ deltas

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ------------------------------------------------------------------ packfiles

/** Inflate the zlib stream starting at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

interface PackEntry {
  offset: number;
  /** The object's own type, or the delta kind while its base (and so its type) is unresolved. */
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile into resolved objects. Delta bases are taken from the pack itself or, for a
 * REF_DELTA naming an object the pack does not carry, from `external` (the receiving store:
 * that is what makes a thin push pack whole). Throws on any structural problem.
 */
export function readPack(pack: Buffer, external?: ObjectLookup): Map<string, GitObject> {
  if (pack.length < 12 + 20) throw new Error('pack is shorter than a header plus trailer');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum does not match its bytes');

  const entries: PackEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= pack.length - 20) throw new Error('pack is truncated in an object header');
    let byte = pack[offset++] as number;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++] as number;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry, in git's offset encoding.
      byte = pack[offset++] as number;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++] as number;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error(`pack object at ${entryOffset} inflates to ${inflated.data.length}, header says ${size}`);
    offset = inflated.next;
    if (typeCode === 6) {
      entries.push({ offset: entryOffset, type: 'ofs-delta', data: inflated.data, baseOffset });
    } else if (typeCode === 7) {
      entries.push({ offset: entryOffset, type: 'ref-delta', data: inflated.data, baseOid });
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`pack object at ${entryOffset} has unknown type code ${typeCode}`);
      entries.push({ offset: entryOffset, type, data: inflated.data });
    }
  }

  // Resolve deltas iteratively: an entry is done when it is a plain object or its base is done.
  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolved = new Map<number, GitObject>();
  const resolvedByOid = new Map<string, GitObject>();
  const pending = new Set(entries);
  const finish = (entry: PackEntry, object: GitObject): void => {
    resolved.set(entry.offset, object);
    resolvedByOid.set(hashObject(object.type, object.data), object);
    pending.delete(entry);
  };
  for (const entry of entries) {
    if (entry.baseOffset === undefined && entry.baseOid === undefined) {
      finish(entry, { type: entry.type as ObjType, data: entry.data });
    }
  }
  let progress = true;
  while (pending.size && progress) {
    progress = false;
    for (const entry of [...pending]) {
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) base = resolved.get(entry.baseOffset);
      else if (entry.baseOid !== undefined) base = resolvedByOid.get(entry.baseOid) ?? external?.(entry.baseOid);
      if (!base) continue;
      const data = applyDelta(base.data, entry.data);
      finish(entry, { type: base.type, data });
      progress = true;
    }
  }
  if (pending.size) throw new Error('pack has deltas whose bases are missing');
  return resolvedByOid;
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), in the caller's order. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ------------------------------------------------------------------ pkt-lines

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** One pkt-line: 4 hex digits of total length, then the payload. */
export function pktEncode(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error('pkt-line payload too large');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };


/**
 * Parse a whole pkt-line request section (commands/arguments), NOT stopping after a flush:
 * returns every packet including flush/delim markers, and the offset of the first byte after
 * the terminating flush (where a packfile would begin).
 */
export function parsePktSection(buffer: Buffer, offset = 0): { packets: PktPacket[]; next: number } {
  const packets: PktPacket[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const head = buffer.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length at ${at}: ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      return { packets, next: at };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) throw new Error(`pkt-line at ${at} overruns the buffer`);
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, next: at };
}
