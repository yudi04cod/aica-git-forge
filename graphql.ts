// The GraphQL v4 surface at /api/graphql: a small parser and executor covering the schema the
// suite speaks — Query.viewer/repository/node/__type, Repository issue/pull connections with
// cursor pagination, and the create/close/merge/comment mutations — backed by the same store
// as REST, so an object made over one surface reads back over the other. Global ids are opaque
// base64 and stable across reads; node(id) round-trips them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeError,
  Store,
  VIEWER,
  nowIso,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface HttpCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Buffer;
}

export interface GraphQLHelpers {
  sendJson: (ctx: HttpCtx, status: number, value: unknown) => void;
  repoJson: (repo: RepoRec) => Record<string, unknown>;
  issueJson: (repo: RepoRec, issue: IssueRec) => Record<string, unknown>;
  pullJson: (repo: RepoRec, pull: PullRec) => Record<string, unknown>;
  commentJson: (repo: RepoRec, issueNumber: number, comment: { id: number; body: string; createdAt: string; updatedAt: string }) => Record<string, unknown>;
  userJson: () => Record<string, unknown>;
}

class GqlError extends Error {}

// ------------------------------------------------------------------ global ids

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ lexer

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Tok {
  kind: TokKind;
  value: string;
}

function tokenize(source: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      toks.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GqlError('Unterminated block string');
        toks.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' } as Record<string, string>)[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlError('Unterminated string');
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      toks.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let kind: TokKind = 'int';
      if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') {
        kind = 'float';
        if (source[j] === '.') {
          j += 1;
          while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
        }
        if (source[j] === 'e' || source[j] === 'E') {
          j += 1;
          if (source[j] === '+' || source[j] === '-') j += 1;
          while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
        }
      }
      toks.push({ kind, value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`Unexpected character ${JSON.stringify(c)}`);
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  name: string;
  alias?: string;
  args: Map<string, Value>;
  selectionSet?: Selection[];
}

type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition?: string; selectionSet: Selection[] };

interface OperationDef {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: Selection[];
}

interface FragmentDef {
  typeCondition: string;
  selectionSet: Selection[];
}

class Parser {
  private readonly toks: Tok[];
  private at = 0;

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok {
    return this.toks[this.at] as Tok;
  }

  private next(): Tok {
    const tok = this.toks[this.at] as Tok;
    this.at += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new GqlError(`Expected "${value}", found "${tok.value}"`);
  }

  private skipPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new GqlError(`Expected a name, found "${tok.value}"`);
    return tok.value;
  }

  parseDocument(): { operations: OperationDef[]; fragments: Map<string, FragmentDef> } {
    const operations: OperationDef[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ type: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ type: tok.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new GqlError('Expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new GqlError(`Unexpected token "${tok.value}" at the top level`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue(true);
      this.parseDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue(false));
    }
    return args;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const tok = this.peek();
    if (tok.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args = new Map<string, Value>();
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.parseDirectives();
    let selectionSet: Selection[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', field: { name, alias, args, selectionSet } };
  }

  private parseValue(constant: boolean): Value {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      if (constant) throw new GqlError('Variables are not allowed in constant values');
      return { kind: 'var', name: this.expectName() };
    }
    if (tok.kind === 'int') return { kind: 'int', value: parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: parseFloat(tok.value) };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'bool', value: true };
      if (tok.value === 'false') return { kind: 'bool', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: Value[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue(constant));
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.skipPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.set(key, this.parseValue(constant));
      }
      return { kind: 'object', fields };
    }
    throw new GqlError(`Unexpected value token "${tok.value}"`);
  }
}

// ------------------------------------------------------------------ value resolution

type Vars = Record<string, unknown>;

function resolveValue(value: Value, variables: Vars): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, variables);
      return out;
    }
  }
}

function resolveArgs(args: Map<string, Value>, variables: Vars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of args) out[key] = resolveValue(value, variables);
  return out;
}

// ------------------------------------------------------------------ wrappers

type Wrapper = { __type: string; [key: string]: unknown };

const wrap = (type: string, fields: Record<string, unknown>): Wrapper => ({ __type: type, ...fields });

function repoWrapper(repo: RepoRec): Wrapper {
  return wrap('Repository', { repo });
}

function issueWrapper(repo: RepoRec, issue: IssueRec): Wrapper {
  return wrap('Issue', { repo, issue });
}

function pullWrapper(repo: RepoRec, pull: PullRec): Wrapper {
  return wrap('PullRequest', { repo, pull });
}

function commentWrapper(repo: RepoRec, issueNumber: number, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Wrapper {
  return wrap('IssueComment', { repo, issueNumber, comment });
}

function userWrapper(): Wrapper {
  return wrap('User', { login: VIEWER.login, id: globalId('User', String(VIEWER.id)), databaseId: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
}

// ------------------------------------------------------------------ connections

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionSpec {
  type: string;
  items: Wrapper[];
}

function connection(spec: ConnectionSpec, args: Record<string, unknown>): Wrapper {
  const firstRaw = typeof args.first === 'number' ? Math.floor(args.first as number) : 100;
  const first = Math.max(0, Math.min(1000, firstRaw));
  const afterIndex = decodeCursor(args.after);
  const start = afterIndex + 1;
  const page = spec.items.slice(start, start + first);
  const edges = page.map((node, i) => wrap('Edge', { node, cursor: encodeCursor(start + i) }));
  const endCursor = page.length > 0 ? encodeCursor(start + page.length - 1) : null;
  const pageInfo = wrap('PageInfo', {
    hasNextPage: start + page.length < spec.items.length,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? encodeCursor(start) : null,
    endCursor,
  });
  return wrap(spec.type, { nodes: page, edges, pageInfo, totalCount: spec.items.length });
}

// ------------------------------------------------------------------ schema tables (introspection)

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'url',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled',
    'issue', 'issues', 'issueOrPullRequest', 'pullRequest', 'pullRequests', 'labels',
    'createdAt', 'updatedAt', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'closed', 'author', 'repository',
    'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'author', 'repository',
    'files', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'isDraft', 'url',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'authoredDate', 'tree'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFilesConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  Edge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'used', 'nodeCount'],
  Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  TypeField: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  Schema: ['types', 'queryType', 'mutationType', 'directives'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

function typeWrapper(name: string): Wrapper | null {
  if (Object.hasOwn(OBJECT_FIELDS, name)) {
    return wrap('Type', { kind: 'OBJECT', name, description: null, enumNames: null, fieldNames: OBJECT_FIELDS[name] });
  }
  if (Object.hasOwn(ENUM_VALUES, name)) {
    return wrap('Type', { kind: 'ENUM', name, description: null, enumNames: ENUM_VALUES[name], fieldNames: null });
  }
  if (['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime', 'GitObjectID'].includes(name)) {
    return wrap('Type', { kind: 'SCALAR', name, description: null, enumNames: null, fieldNames: null });
  }
  return null;
}

// ------------------------------------------------------------------ execution context

interface ExecCtx {
  store: Store;
  variables: Vars;
  fragments: Map<string, FragmentDef>;
}

function findRepoByDatabaseId(store: Store, databaseId: number): RepoRec | null {
  for (const repo of store.repos.values()) {
    if (repo.id === databaseId) return repo;
  }
  return null;
}

function nodeById(store: Store, id: string): Wrapper | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.type === 'Repository') {
    const repo = findRepoByDatabaseId(store, Number(parsed.key));
    return repo ? repoWrapper(repo) : null;
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const [repoId, number] = parsed.key.split(':').map(Number);
    const repo = repoId !== undefined ? findRepoByDatabaseId(store, repoId) : null;
    if (!repo || number === undefined) return null;
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue ? issueWrapper(repo, issue) : null;
    }
    const pull = repo.pulls.get(number);
    return pull ? pullWrapper(repo, pull) : null;
  }
  if (parsed.type === 'IssueComment') {
    const entry = store.commentIndex.get(Number(parsed.key));
    return entry ? commentWrapper(entry.repo, entry.issueNumber, entry.comment) : null;
  }
  if (parsed.type === 'User') {
    return Number(parsed.key) === VIEWER.id ? userWrapper() : null;
  }
  return null;
}

// ------------------------------------------------------------------ field resolvers

type Resolver = (source: Wrapper, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

function issueState(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function orderIssues(issues: IssueRec[], args: Record<string, unknown>): IssueRec[] {
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const sorted = [...issues];
  if (!orderBy) {
    sorted.sort((a, b) => a.number - b.number);
    return sorted;
  }
  const sign = orderBy.direction === 'DESC' ? -1 : 1;
  sorted.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return (a.createdAt < b.createdAt ? -1 : 1) * sign;
    return (a.number - b.number) * sign;
  });
  return sorted;
}

function filterIssuesByStates(issues: IssueRec[], args: Record<string, unknown>): IssueRec[] {
  const states = args.states;
  if (!Array.isArray(states) || states.length === 0) return issues;
  const wanted = new Set(states.map((state) => String(state).toLowerCase()));
  return issues.filter((issue) => wanted.has(issue.state));
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userWrapper(),
    repository: (_source, args, ctx) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoWrapper(repo) : null;
    },
    node: (_source, args, ctx) => (typeof args.id === 'string' ? nodeById(ctx.store, args.id) : null),
    rateLimit: () => wrap('RateLimit', { limit: 5000, cost: 1, remaining: 4999, resetAt: '2099-01-01T00:00:00Z', used: 1, nodeCount: 0 }),
    __type: (_source, args) => (typeof args.name === 'string' ? typeWrapper(args.name) : null),
    __schema: () => wrap('Schema', {
      types: Object.keys(OBJECT_FIELDS).map((name) => typeWrapper(name)),
      queryType: typeWrapper('Query'),
      mutationType: typeWrapper('Mutation'),
      directives: [],
    }),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed?.type === 'Repository' ? findRepoByDatabaseId(ctx.store, Number(parsed.key)) : null;
      if (!repo) throw new GqlError('Repository not found for createIssue');
      const issue = ctx.store.createIssue(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      return wrap('CreateIssuePayload', { issue: issueWrapper(repo, issue), clientMutationId: input.clientMutationId ?? null });
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = typeof input.issueId === 'string' ? nodeById(ctx.store, input.issueId) : null;
      if (!target || target.__type !== 'Issue') throw new GqlError('Issue not found for closeIssue');
      const repo = target.repo as RepoRec;
      const issue = target.issue as IssueRec;
      issue.state = 'closed';
      issue.closedAt = nowIso();
      return wrap('CloseIssuePayload', { issue: issueWrapper(repo, issue), clientMutationId: input.clientMutationId ?? null });
    },
    reopenIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = typeof input.issueId === 'string' ? nodeById(ctx.store, input.issueId) : null;
      if (!target || target.__type !== 'Issue') throw new GqlError('Issue not found for reopenIssue');
      const repo = target.repo as RepoRec;
      const issue = target.issue as IssueRec;
      issue.state = 'open';
      issue.closedAt = null;
      return wrap('CloseIssuePayload', { issue: issueWrapper(repo, issue), clientMutationId: input.clientMutationId ?? null });
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed?.type === 'Repository' ? findRepoByDatabaseId(ctx.store, Number(parsed.key)) : null;
      if (!repo) throw new GqlError('Repository not found for createPullRequest');
      try {
        const pull = ctx.store.createPull(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
          draft: input.draft === true,
        });
        return wrap('CreatePullRequestPayload', { pullRequest: pullWrapper(repo, pull), clientMutationId: input.clientMutationId ?? null });
      } catch (err) {
        if (err instanceof ForgeError) throw new GqlError(err.message);
        throw err;
      }
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = typeof input.pullRequestId === 'string' ? nodeById(ctx.store, input.pullRequestId) : null;
      if (!target || target.__type !== 'PullRequest') throw new GqlError('Pull request not found for mergePullRequest');
      const repo = target.repo as RepoRec;
      const pull = target.pull as PullRec;
      const method = input.mergeMethod === 'MERGE' ? 'merge' : 'squash';
      try {
        ctx.store.mergePull(repo, pull, method);
      } catch (err) {
        if (err instanceof ForgeError) throw new GqlError(err.message);
        throw err;
      }
      return wrap('MergePullRequestPayload', { pullRequest: pullWrapper(repo, pull), clientMutationId: input.clientMutationId ?? null });
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = typeof input.subjectId === 'string' ? nodeById(ctx.store, input.subjectId) : null;
      if (!target || (target.__type !== 'Issue' && target.__type !== 'PullRequest')) {
        throw new GqlError('Subject not found for addComment');
      }
      const repo = target.repo as RepoRec;
      const subject = (target.__type === 'Issue' ? target.issue : target.pull) as IssueRec | PullRec;
      const comment = ctx.store.addComment(repo, subject, String(input.body ?? ''));
      const node = commentWrapper(repo, subject.number, comment);
      return wrap('AddCommentPayload', {
        commentEdge: wrap('CommentEdge', { node, cursor: encodeCursor(comment.id) }),
        clientMutationId: input.clientMutationId ?? null,
        subject: target,
      });
    },
  },
  Repository: {
    id: (source) => globalId('Repository', String((source.repo as RepoRec).id)),
    databaseId: (source) => (source.repo as RepoRec).id,
    name: (source) => (source.repo as RepoRec).name,
    nameWithOwner: (source) => `${(source.repo as RepoRec).owner}/${(source.repo as RepoRec).name}`,
    owner: () => userWrapper(),
    description: (source) => (source.repo as RepoRec).description,
    isPrivate: (source) => (source.repo as RepoRec).isPrivate,
    url: (source) => `https://github.local/${(source.repo as RepoRec).owner}/${(source.repo as RepoRec).name}`,
    createdAt: (source) => (source.repo as RepoRec).createdAt,
    updatedAt: (source) => (source.repo as RepoRec).updatedAt,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    stargazerCount: () => 0,
    forkCount: () => 0,
    defaultBranchRef: (source, _args, ctx) => {
      const repo = source.repo as RepoRec;
      const oid = ctx.store.resolveRef(repo, `refs/heads/${repo.defaultBranch}`);
      if (!oid) return null;
      return wrap('Ref', {
        name: repo.defaultBranch,
        prefix: 'refs/heads/',
        target: wrap('Commit', { oid }),
      });
    },
    issue: (source, args) => {
      const repo = source.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueWrapper(repo, issue) : null;
    },
    issues: (source, args) => {
      const repo = source.repo as RepoRec;
      const filtered = filterIssuesByStates([...repo.issues.values()], args);
      const ordered = orderIssues(filtered, args);
      return connection({ type: 'IssueConnection', items: ordered.map((issue) => issueWrapper(repo, issue)) }, args);
    },
    issueOrPullRequest: (source, args) => {
      const repo = source.repo as RepoRec;
      const number = Number(args.number);
      const issue = repo.issues.get(number);
      if (issue) return issueWrapper(repo, issue);
      const pull = repo.pulls.get(number);
      return pull ? pullWrapper(repo, pull) : null;
    },
    pullRequest: (source, args) => {
      const repo = source.repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullWrapper(repo, pull) : null;
    },
    pullRequests: (source, args) => {
      const repo = source.repo as RepoRec;
      let pulls = [...repo.pulls.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state)));
        pulls = pulls.filter((pull) => wanted.has(pullState(pull)));
      }
      pulls.sort((a, b) => a.number - b.number);
      return connection({ type: 'PullRequestConnection', items: pulls.map((pull) => pullWrapper(repo, pull)) }, args);
    },
    labels: (source, args) => {
      const repo = source.repo as RepoRec;
      const labels = [...repo.labels.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((label) => wrap('Label', { id: globalId('Label', `${repo.id}:${label.name}`), name: label.name, color: label.color, description: label.description }));
      return connection({ type: 'LabelConnection', items: labels }, args);
    },
  },
  Issue: {
    id: (source) => globalId('Issue', `${(source.repo as RepoRec).id}:${(source.issue as IssueRec).number}`),
    databaseId: (source) => (source.issue as IssueRec).id,
    number: (source) => (source.issue as IssueRec).number,
    title: (source) => (source.issue as IssueRec).title,
    body: (source) => (source.issue as IssueRec).body,
    state: (source) => issueState(source.issue as IssueRec),
    closed: (source) => (source.issue as IssueRec).state === 'closed',
    author: () => userWrapper(),
    repository: (source) => repoWrapper(source.repo as RepoRec),
    createdAt: (source) => (source.issue as IssueRec).createdAt,
    updatedAt: (source) => (source.issue as IssueRec).updatedAt,
    closedAt: (source) => (source.issue as IssueRec).closedAt,
    url: (source) => `https://github.local/${(source.repo as RepoRec).owner}/${(source.repo as RepoRec).name}/issues/${(source.issue as IssueRec).number}`,
    labels: (source, args) => {
      const repo = source.repo as RepoRec;
      const issue = source.issue as IssueRec;
      const labels = issue.labels
        .map((name) => source.repo && (source.repo as RepoRec).labels.get(name.toLowerCase()))
        .filter((label) => label !== undefined)
        .map((label) => wrap('Label', { id: globalId('Label', `${repo.id}:${(label as { name: string }).name}`), name: (label as { name: string }).name, color: (label as { color: string }).color, description: (label as { description: string | null }).description }));
      return connection({ type: 'LabelConnection', items: labels }, args);
    },
    comments: (source, args) => {
      const repo = source.repo as RepoRec;
      const issue = source.issue as IssueRec;
      return connection({ type: 'IssueCommentConnection', items: issue.comments.map((comment) => commentWrapper(repo, issue.number, comment)) }, args);
    },
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', `${(source.repo as RepoRec).id}:${(source.pull as PullRec).number}`),
    databaseId: (source) => (source.pull as PullRec).id,
    number: (source) => (source.pull as PullRec).number,
    title: (source) => (source.pull as PullRec).title,
    body: (source) => (source.pull as PullRec).body,
    state: (source) => pullState(source.pull as PullRec),
    merged: (source) => (source.pull as PullRec).merged,
    mergedAt: (source) => (source.pull as PullRec).mergedAt,
    mergeCommit: (source) => {
      const pull = source.pull as PullRec;
      return pull.mergeCommitSha ? wrap('Commit', { oid: pull.mergeCommitSha }) : null;
    },
    headRefName: (source) => (source.pull as PullRec).headRef,
    baseRefName: (source) => (source.pull as PullRec).baseRef,
    headRefOid: (source, _args, ctx) => ctx.store.resolveRef(source.repo as RepoRec, `refs/heads/${(source.pull as PullRec).headRef}`),
    baseRefOid: (source, _args, ctx) => ctx.store.resolveRef(source.repo as RepoRec, `refs/heads/${(source.pull as PullRec).baseRef}`),
    mergeable: (source, _args, ctx) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      if (pull.state !== 'open') return 'UNKNOWN';
      return ctx.store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    author: () => userWrapper(),
    repository: (source) => repoWrapper(source.repo as RepoRec),
    createdAt: (source) => (source.pull as PullRec).createdAt,
    updatedAt: (source) => (source.pull as PullRec).updatedAt,
    closedAt: (source) => ((source.pull as PullRec).state === 'closed' ? (source.pull as PullRec).updatedAt : null),
    isDraft: (source) => (source.pull as PullRec).draft,
    url: (source) => `https://github.local/${(source.repo as RepoRec).owner}/${(source.repo as RepoRec).name}/pull/${(source.pull as PullRec).number}`,
    files: (source, args, ctx) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      const changeType = (status: string): string => (status === 'added' ? 'ADDED' : status === 'removed' ? 'DELETED' : 'MODIFIED');
      const items = ctx.store.pullFiles(repo, pull).map((file) => wrap('PullRequestFile', {
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: changeType(file.status),
      }));
      return connection({ type: 'PullRequestFilesConnection', items }, args);
    },
    comments: (source, args) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      return connection({ type: 'IssueCommentConnection', items: pull.comments.map((comment) => commentWrapper(repo, pull.number, comment)) }, args);
    },
  },
  IssueComment: {
    id: (source) => globalId('IssueComment', String((source.comment as { id: number }).id)),
    databaseId: (source) => (source.comment as { id: number }).id,
    body: (source) => (source.comment as { body: string }).body,
    author: () => userWrapper(),
    createdAt: (source) => (source.comment as { createdAt: string }).createdAt,
    updatedAt: (source) => (source.comment as { updatedAt: string }).updatedAt,
    url: (source) => `https://github.local/${(source.repo as RepoRec).owner}/${(source.repo as RepoRec).name}/issues/${source.issueNumber as number}#issuecomment-${(source.comment as { id: number }).id}`,
  },
  Type: {
    fields: (source) => {
      const names = source.fieldNames as string[] | null;
      if (!names) return null;
      return names.map((name) => wrap('TypeField', {
        name,
        description: null,
        args: [],
        type: wrap('Type', { kind: 'SCALAR', name: 'String', description: null, enumNames: null, fieldNames: null }),
        isDeprecated: false,
        deprecationReason: null,
      }));
    },
    enumValues: (source) => {
      const names = source.enumNames as string[] | null;
      if (!names) return null;
      return names.map((name) => wrap('EnumValue', { name, description: null, isDeprecated: false, deprecationReason: null }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
    specifiedByURL: () => null,
  },
};

// ------------------------------------------------------------------ executor

function isWrapper(value: unknown): value is Wrapper {
  return typeof value === 'object' && value !== null && typeof (value as Wrapper).__type === 'string';
}

function executeSelectionSet(typeName: string, source: Wrapper | null, selections: Selection[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) throw new GqlError(`Unknown fragment "${selection.name}"`);
      if (fragment.typeCondition === typeName || fragment.typeCondition === 'Node' || fragment.typeCondition === 'UniformResourceLocatable') {
        Object.assign(out, executeSelectionSet(typeName, source, fragment.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (!selection.typeCondition || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(typeName, source, selection.selectionSet, ctx));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[field.name];
    const knownFields = OBJECT_FIELDS[typeName];
    let raw: unknown;
    if (resolver) {
      raw = resolver(source as Wrapper, resolveArgs(field.args, ctx.variables), ctx);
    } else if (source && knownFields?.includes(field.name)) {
      raw = source[field.name];
    } else if (typeName === 'Query' || typeName === 'Mutation' || knownFields) {
      throw new GqlError(`Field '${field.name}' doesn't exist on type '${typeName}'`);
    } else if (source) {
      raw = source[field.name];
    } else {
      throw new GqlError(`Field '${field.name}' doesn't exist on type '${typeName}'`);
    }
    out[key] = completeValue(raw, field, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (isWrapper(value)) {
    if (!field.selectionSet) return value;
    return executeSelectionSet(value.__type, value, field.selectionSet, ctx);
  }
  return value;
}

function executeOperation(store: Store, query: string, variables: Vars, operationName?: string): Record<string, unknown> {
  const { operations, fragments } = new Parser(tokenize(query)).parseDocument();
  const operation = operationName
    ? operations.find((candidate) => candidate.name === operationName) ?? operations[0]
    : operations[0];
  if (!operation) throw new GqlError('No operation found in the document');
  const ctx: ExecCtx = { store, variables, fragments };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, wrap(rootType, {}), operation.selectionSet, ctx);
  return { data };
}

// ------------------------------------------------------------------ HTTP entry

export function handleGraphQL(ctx: HttpCtx, store: Store, helpers: GraphQLHelpers): void {
  if (ctx.req.method !== 'POST') {
    helpers.sendJson(ctx, 405, { errors: [{ message: 'GraphQL only accepts POST' }] });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    helpers.sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object') return { errors: [{ message: 'Invalid GraphQL request' }] };
    const request = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof request.query !== 'string') return { errors: [{ message: 'A query string is required' }] };
    const variables = (request.variables !== null && typeof request.variables === 'object' && !Array.isArray(request.variables)
      ? request.variables
      : {}) as Vars;
    try {
      return executeOperation(store, request.query, variables, typeof request.operationName === 'string' ? request.operationName : undefined);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL execution failed' }] };
    }
  };
  if (Array.isArray(parsed)) {
    helpers.sendJson(ctx, 200, parsed.map(runOne));
    return;
  }
  helpers.sendJson(ctx, 200, runOne(parsed));
}
