// The forge's store: every repository, its git objects and refs, its issues, pull requests,
// labels and comments, held in memory and shared by all four surfaces (git smart HTTP, REST,
// GraphQL, MCP) so an object made on one reads back identically on the others.
//
// Time comes from MAKEFUN_TRIAL_NOW when the trial provides it (plus a millisecond tick so
// creation order is always visible in timestamps), else from the wall clock. Ids are plain
// counters: stable across reads, identical across a trial's two passes.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  collectReachable,
  flattenTree,
  hashObject,
  mergeBase,
  parseCommit,
  peelToCommit,
  type GitObject,
  type ObjType,
} from './git.ts';

/** The login the trial's bearer token names (the suite's scenario viewer). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

// ------------------------------------------------------------------ time and ids

const trialNowMs = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
})();
let tick = 0;

/** The current trial instant: the trial's opening time plus a per-call millisecond tick. */
export function nowDate(): Date {
  const at = new Date(trialNowMs + tick);
  tick += 1;
  return at;
}

/** ISO-8601 UTC with second precision, the shape GitHub's REST API uses. */
export function nowIso(): string {
  return nowDate().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A git identity line for the viewer at the current trial instant. */
export function viewerIdentity(): string {
  const seconds = Math.floor(nowDate().getTime() / 1000);
  return `${VIEWER.name} <${VIEWER.email}> ${seconds} +0000`;
}

// ------------------------------------------------------------------ records

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  draft: boolean;
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
}

export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------ the store

export class Store {
  readonly repos = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  /** Global comment id -> where the comment lives (for GraphQL node lookups). */
  readonly commentIndex = new Map<number, { repo: RepoRec; issueNumber: number; comment: CommentRec }>();

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  requireRepo(owner: string, name: string): RepoRec {
    const repo = this.getRepo(owner, name);
    if (!repo) throw new ForgeError(404, 'Not Found');
    return repo;
  }

  createRepo(name: string, options: { description?: string; isPrivate?: boolean; autoInit?: boolean }): RepoRec {
    if (this.repos.has(Store.key(VIEWER.login, name))) {
      throw new ForgeError(422, 'Repository creation failed: name already exists on this account');
    }
    const stamp = nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId++,
      owner: VIEWER.login,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      createdAt: stamp,
      updatedAt: stamp,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(Store.key(repo.owner, repo.name), repo);
    if (options.autoInit) {
      const readme = `# ${name}\n`;
      this.commitFiles(repo, repo.defaultBranch, new Map([['README.md', Buffer.from(readme, 'utf8')]]), 'Initial commit', null);
    }
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    const repo = this.requireRepo(owner, name);
    for (const issue of repo.issues.values()) {
      for (const comment of issue.comments) this.commentIndex.delete(comment.id);
    }
    for (const pull of repo.pulls.values()) {
      for (const comment of pull.comments) this.commentIndex.delete(comment.id);
    }
    this.repos.delete(Store.key(owner, name));
  }

  // -------------------------------------------------------------- git plumbing on a repo

  lookup(repo: RepoRec): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  putObject(repo: RepoRec, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The oid a ref name (short branch, tag, or full ref) resolves to, or null. */
  resolveRef(repo: RepoRec, ref: string): string | null {
    if (ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    const candidates = ref.startsWith('refs/')
      ? [ref]
      : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/${ref}`];
    for (const candidate of candidates) {
      const oid = repo.refs.get(candidate);
      if (oid) return oid;
    }
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  /** The tree oid at a commit oid. */
  treeOfCommit(repo: RepoRec, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** The flattened file map at a ref (or commit oid), or null when it does not resolve. */
  flatAt(repo: RepoRec, refOrOid: string): Map<string, { oid: string; mode: string }> | null {
    const oid = this.resolveRef(repo, refOrOid) ?? (/^[0-9a-f]{40}$/.test(refOrOid) ? refOrOid : null);
    if (!oid) return null;
    const commitOid = peelToCommit(this.lookup(repo), oid);
    if (!commitOid) return null;
    const tree = this.treeOfCommit(repo, commitOid);
    if (!tree) return null;
    return flattenTree(this.lookup(repo), tree);
  }

  /**
   * Commit a set of path writes (Buffer content, or null to delete the path) onto a branch,
   * creating the branch from the default branch's tip (or from nothing) when it is unborn.
   * `expectTip` (the caller's view of the branch tip) guards against lost updates when given.
   */
  commitFiles(
    repo: RepoRec,
    branch: string,
    writes: ReadonlyMap<string, Buffer | null>,
    message: string,
    expectTip: string | null,
  ): { commitOid: string; treeOid: string } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref) ?? null;
    if (tip === null && branch !== repo.defaultBranch) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (expectTip !== null && (tip ?? ZERO_OID) !== expectTip) {
      throw new ForgeError(409, 'Conflict: the branch moved since the read');
    }
    const flat = tip ? (this.flatAt(repo, tip) ?? new Map()) : new Map<string, { oid: string; mode: string }>();
    for (const [path, content] of writes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { oid: this.putObject(repo, 'blob', content), mode: '100644' });
    }
    const treeOid = buildTreeFromFlat(flat, (type, data) => this.putObject(repo, type, data));
    const identity = viewerIdentity();
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: tip ? [tip] : [],
        author: identity,
        committer: identity,
        message,
      }),
    );
    repo.refs.set(ref, commitOid);
    repo.updatedAt = nowIso();
    return { commitOid, treeOid };
  }

  // -------------------------------------------------------------- labels, issues, comments

  createLabel(repo: RepoRec, name: string, color = 'ededed', description: string | null = null): LabelRec {
    const key = name.toLowerCase();
    const existing = repo.labels.get(key);
    if (existing) throw new ForgeError(422, `Label "${name}" already exists`);
    const label: LabelRec = { id: this.nextLabelId++, name, color: color.replace(/^#/, ''), description };
    repo.labels.set(key, label);
    return label;
  }

  getLabel(repo: RepoRec, name: string): LabelRec | undefined {
    return repo.labels.get(name.toLowerCase());
  }

  createIssue(repo: RepoRec, input: { title: string; body?: string; labels?: readonly string[] }): IssueRec {
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!this.getLabel(repo, name)) {
        throw new ForgeError(422, `Label "${name}" does not exist in this repository`);
      }
    }
    const stamp = nowIso();
    const issue: IssueRec = {
      number: repo.nextNumber++,
      id: this.nextIssueId++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: labels.map((name) => (this.getLabel(repo, name) as LabelRec).name),
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: null,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: RepoRec, target: IssueRec | PullRec, body: string): CommentRec {
    const stamp = nowIso();
    const comment: CommentRec = { id: this.nextCommentId++, body, createdAt: stamp, updatedAt: stamp };
    target.comments.push(comment);
    this.commentIndex.set(comment.id, { repo, issueNumber: target.number, comment });
    return comment;
  }

  // -------------------------------------------------------------- pull requests and merges

  createPull(
    repo: RepoRec,
    input: { title: string; body?: string; head: string; base: string; draft?: boolean },
  ): PullRec {
    const headOid = repo.refs.get(`refs/heads/${input.head}`);
    if (!headOid) throw new ForgeError(422, `Head branch "${input.head}" does not exist`);
    const baseOid = repo.refs.get(`refs/heads/${input.base}`);
    if (!baseOid) throw new ForgeError(422, `Base branch "${input.base}" does not exist`);
    if (input.head === input.base) throw new ForgeError(422, 'Head and base are the same branch');
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) {
        throw new ForgeError(422, `A pull request already exists for ${input.head} into ${input.base}`);
      }
    }
    const stamp = nowIso();
    const pull: PullRec = {
      number: repo.nextNumber++,
      id: this.nextIssueId++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      draft: input.draft ?? false,
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  pullComments(pull: PullRec): CommentRec[] {
    return pull.comments;
  }

  /** The merge-base commit of a pull request's head and base branches, or null. */
  pullMergeBase(repo: RepoRec, pull: PullRec): string | null {
    const head = repo.refs.get(`refs/heads/${pull.headRef}`);
    const base = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!head || !base) return null;
    return mergeBase(this.lookup(repo), head, base);
  }

  /** The changed files of a pull request: merge-base tree versus head tree. */
  pullFiles(repo: RepoRec, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string | null }> {
    const baseOid = this.pullMergeBase(repo, pull);
    const headOid = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!headOid) return [];
    const before = baseOid ? (this.flatAt(repo, baseOid) ?? new Map()) : new Map();
    const after = this.flatAt(repo, headOid) ?? new Map();
    return diffFlats(repo, before, after);
  }

  /** Whether a pull request merges cleanly into the current base tip. */
  pullMergeable(repo: RepoRec, pull: PullRec): boolean {
    if (pull.state !== 'open') return false;
    return this.tryMergeTrees(repo, pull) !== null;
  }

  /**
   * The tree a merge of `pull` into its base would produce, or null on conflict.
   * Three-way over flattened path maps: ancestor = merge-base tree, ours = base tip tree,
   * theirs = head tip tree.
   */
  tryMergeTrees(repo: RepoRec, pull: PullRec): Map<string, { oid: string; mode: string }> | null {
    const lookup = this.lookup(repo);
    const headOid = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headOid || !baseOid) return null;
    const ancestorOid = mergeBase(lookup, headOid, baseOid);
    const ancestor = ancestorOid ? (this.flatAt(repo, ancestorOid) ?? new Map()) : new Map();
    const ours = this.flatAt(repo, baseOid) ?? new Map();
    const theirs = this.flatAt(repo, headOid) ?? new Map();
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
    const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
      x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode;
    for (const path of paths) {
      const a = ancestor.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      let chosen: { oid: string; mode: string } | undefined;
      if (same(t, a)) chosen = o;
      else if (same(o, a)) chosen = t;
      else if (same(o, t)) chosen = o;
      else return null;
      if (chosen) merged.set(path, chosen);
    }
    // A file and a directory cannot share a path prefix.
    for (const path of merged.keys()) {
      const slash = path.indexOf('/');
      if (slash > 0 && merged.has(path.slice(0, slash))) return null;
    }
    return merged;
  }

  /**
   * Merge a pull request into its base branch. Squash lands one commit holding the merged
   * tree on top of the base tip; merge lands a two-parent commit. Returns the new tip sha.
   */
  mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge' | 'rebase'): string {
    if (pull.merged) throw new ForgeError(405, 'Pull Request is not mergeable: it is already merged');
    if (pull.state !== 'open') throw new ForgeError(405, 'Pull Request is not mergeable: it is closed');
    const mergedFlat = this.tryMergeTrees(repo, pull);
    if (mergedFlat === null) throw new ForgeError(405, 'Pull Request is not mergeable: conflicts must be resolved first');
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseTip = repo.refs.get(baseRef) as string;
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) as string;
    const treeOid = buildTreeFromFlat(mergedFlat, (type, data) => this.putObject(repo, type, data));
    const identity = viewerIdentity();
    let message: string;
    let parents: string[];
    if (method === 'merge') {
      message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
      parents = [baseTip, headTip];
    } else {
      message = `${pull.title} (#${pull.number})`;
      parents = [baseTip];
    }
    const commitOid = this.putObject(repo, 'commit', buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message }));
    repo.refs.set(baseRef, commitOid);
    const stamp = nowIso();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = stamp;
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = stamp;
    repo.updatedAt = stamp;
    return commitOid;
  }
}

// ------------------------------------------------------------------ tree diffs

/** Line counts of a blob's content (a trailing newline does not add a phantom line). */
export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** An LCS-based line diff count between two blob contents. */
export function lineDiff(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  if (a[a.length - 1] === '') a.pop();
  if (b[b.length - 1] === '') b.pop();
  // LCS over lines; inputs here are small (suite files are a few hundred lines at most).
  const m = a.length;
  const n = b.length;
  if (m * n > 4_000_000) {
    // Very large inputs: fall back to a whole-file approximation rather than a quadratic blow-up.
    return { additions: n, deletions: m };
  }
  const dp = new Uint32Array(n + 1);
  for (let i = m - 1; i >= 0; i -= 1) {
    let prev = 0;
    for (let j = n - 1; j >= 0; j -= 1) {
      const saved = dp[j] as number;
      dp[j] = a[i] === b[j] ? prev + 1 : Math.max(dp[j] as number, dp[j + 1] as number);
      prev = saved;
    }
  }
  const lcs = dp[0] as number;
  return { additions: n - lcs, deletions: m - lcs };
}

/** The file-level diff between two flattened trees, in GitHub's pull-files shape. */
export function diffFlats(
  repo: RepoRec,
  before: ReadonlyMap<string, { oid: string; mode: string }>,
  after: ReadonlyMap<string, { oid: string; mode: string }>,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string | null }> {
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string | null }> = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const a = before.get(path);
    const b = after.get(path);
    if (a && b && a.oid === b.oid) continue;
    if (a && !b) {
      const data = repo.objects.get(a.oid)?.data ?? Buffer.alloc(0);
      const deletions = lineCount(data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: null });
    } else if (!a && b) {
      const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const additions = lineCount(data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: b.oid });
    } else if (a && b) {
      const beforeData = repo.objects.get(a.oid)?.data ?? Buffer.alloc(0);
      const afterData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const { additions, deletions } = lineDiff(beforeData, afterData);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: b.oid });
    }
  }
  return out;
}

/** Every object reachable from the repo's current refs (used to bound pack contents). */
export function reachableFromRefs(repo: RepoRec): Set<string> {
  return collectReachable((oid) => repo.objects.get(oid), repo.refs.values());
}
