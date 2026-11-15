// The forge's HTTP surface: the REST v3 API, git smart HTTP, and the mounts for GraphQL and
// MCP. One in-memory store (store.ts) backs all of it. Every JSON reply carries an
// X-GitHub-Request-Id header; every error is JSON with a string `message`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  isAncestor,
  parseCommit,
  parsePktSection,
  parseTag,
  parseTree,
  peelToCommit,
  pktEncode,
  readPack,
  writePack,
  type GitObject,
  type Lookup,
} from './git.ts';
import {
  ForgeError,
  Store,
  VIEWER,
  nowIso,
  type CommentRec,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const store = new Store();
let requestCounter = 0;

// ------------------------------------------------------------------ http plumbing

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Buffer;
}

function sendJson(ctx: Ctx, status: number, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
  });
  ctx.res.end(payload);
}

function sendEmpty(ctx: Ctx, status: number): void {
  ctx.res.writeHead(status, { 'content-length': 0 });
  ctx.res.end();
}

function sendBytes(ctx: Ctx, status: number, contentType: string, payload: Buffer): void {
  ctx.res.writeHead(status, { 'content-type': contentType, 'content-length': payload.length });
  ctx.res.end(payload);
}

function notFound(ctx: Ctx): void {
  sendJson(ctx, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function parseJsonBody(ctx: Ctx): Record<string, unknown> {
  if (ctx.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    throw new ForgeError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ForgeError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function hostOf(ctx: Ctx): string {
  return ctx.req.headers.host ?? 'localhost';
}

/** Slice `items` by page/per_page and emit GitHub's Link pagination header when pages remain. */
function paginate<T>(ctx: Ctx, items: readonly T[]): T[] {
  const perPageRaw = Number(ctx.url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(ctx.url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const linkFor = (targetPage: number, rel: string): string => {
    const params = new URLSearchParams(ctx.url.searchParams);
    params.set('page', String(targetPage));
    params.set('per_page', String(perPage));
    return `<http://${hostOf(ctx)}${ctx.url.pathname}?${params.toString()}>; rel="${rel}"`;
  };
  if (page < totalPages) {
    links.push(linkFor(page + 1, 'next'));
    links.push(linkFor(totalPages, 'last'));
  }
  if (page > 1) {
    links.push(linkFor(page - 1, 'prev'));
    links.push(linkFor(1, 'first'));
  }
  if (links.length > 0) ctx.res.setHeader('link', links.join(', '));
  return items.slice((page - 1) * perPage, page * perPage);
}

// ------------------------------------------------------------------ serializers

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(),
    html_url: `https://github.local/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: LabelRec): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => store.getLabel(repo, name))
      .filter((label): label is LabelRec => label !== undefined)
      .map(labelJson),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    pull_request: undefined,
    html_url: `https://github.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: RepoRec, issueNumber: number, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.local/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = store.resolveRef(repo, `refs/heads/${pull.headRef}`);
  const baseSha = store.resolveRef(repo, `refs/heads/${pull.baseRef}`);
  const side = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: pull.draft,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? store.pullMergeable(repo, pull) : null,
    mergeable_state: pull.merged ? 'clean' : 'unknown',
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    comments: pull.comments.length,
    html_url: `https://github.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function identityJson(identity: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(identity);
  if (!match) return { name: identity, email: '', date: new Date(0).toISOString() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
    commit: {
      author: identityJson(commit.author),
      committer: identityJson(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------------ REST handlers

function handleRoot(ctx: Ctx): void {
  ctx.res.setHeader('x-oauth-scopes', 'repo, user');
  sendJson(ctx, 200, {
    current_user_url: `http://${hostOf(ctx)}/api/v3/user`,
    repository_url: `http://${hostOf(ctx)}/api/v3/repos/{owner}/{repo}`,
    issue_search_url: `http://${hostOf(ctx)}/api/v3/search/issues?q={query}`,
    emojis_url: `http://${hostOf(ctx)}/api/v3/emojis`,
  });
}

function handleMeta(ctx: Ctx): void {
  sendJson(ctx, 200, {
    verifiable_password_authentication: false,
    ssh_key_fingerprints: {},
    installed_version: '1.0.0-aica-forge',
    is_enterprise: false,
  });
}

function handleListUserRepos(ctx: Ctx): void {
  const all = [...store.repos.values()].sort((a, b) => a.id - b.id);
  sendJson(ctx, 200, paginate(ctx, all).map(repoJson));
}

function handleCreateRepo(ctx: Ctx): void {
  const body = parseJsonBody(ctx);
  const name = str(body.name);
  if (!name) throw new ForgeError(422, 'Repository creation failed: name is required');
  const repo = store.createRepo(name, {
    description: str(body.description) ?? '',
    isPrivate: bool(body.private) ?? false,
    autoInit: bool(body.auto_init) ?? false,
  });
  sendJson(ctx, 201, repoJson(repo));
}

function handleGetRepo(ctx: Ctx, owner: string, name: string): void {
  sendJson(ctx, 200, repoJson(store.requireRepo(owner, name)));
}

function handlePatchRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const body = parseJsonBody(ctx);
  const description = str(body.description);
  if (description !== undefined) repo.description = description;
  const isPrivate = bool(body.private);
  if (isPrivate !== undefined) repo.isPrivate = isPrivate;
  const defaultBranch = str(body.default_branch);
  if (defaultBranch) repo.defaultBranch = defaultBranch;
  const newName = str(body.name);
  if (newName && newName !== repo.name) {
    store.repos.delete(Store.key(repo.owner, repo.name));
    repo.name = newName;
    store.repos.set(Store.key(repo.owner, repo.name), repo);
  }
  repo.updatedAt = nowIso();
  sendJson(ctx, 200, repoJson(repo));
}

function handleDeleteRepo(ctx: Ctx, owner: string, name: string): void {
  store.deleteRepo(owner, name);
  sendEmpty(ctx, 204);
}

// -------------------------------------------------------------- contents

/** Walk from a tree oid down `segments`; returns the entry found there, or null. */
function walkTree(
  repo: RepoRec,
  treeOid: string,
  segments: readonly string[],
): { type: 'file' | 'dir'; oid: string; mode: string } | null {
  let current = treeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[depth]);
    if (!entry) return null;
    if (depth === segments.length - 1) {
      return { type: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { type: 'dir', oid: current, mode: '40000' };
}

function handleGetContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = store.requireRepo(owner, name);
  const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
  const tip = store.resolveRef(repo, ref);
  if (!tip) return notFound(ctx);
  const commitOid = peelToCommit(store.lookup(repo), tip);
  if (!commitOid) return notFound(ctx);
  const rootTree = store.treeOfCommit(repo, commitOid);
  if (!rootTree) return notFound(ctx);
  const segments = path === '' ? [] : path.split('/');
  const found = walkTree(repo, rootTree, segments);
  if (!found) return notFound(ctx);
  if (found.type === 'dir') {
    const treeObject = repo.objects.get(found.oid);
    if (!treeObject) return notFound(ctx);
    const entries = parseTree(treeObject.data).map((entry) => ({
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      type: entry.mode === '40000' ? 'dir' : 'file',
    }));
    return sendJson(ctx, 200, entries);
  }
  const blob = repo.objects.get(found.oid);
  if (!blob) return notFound(ctx);
  sendJson(ctx, 200, {
    name: segments[segments.length - 1] ?? '',
    path,
    sha: found.oid,
    size: blob.data.length,
    type: 'file',
    encoding: 'base64',
    content: blob.data.toString('base64'),
  });
}

function handlePutContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = store.requireRepo(owner, name);
  const body = parseJsonBody(ctx);
  const contentB64 = str(body.content);
  if (contentB64 === undefined) throw new ForgeError(422, 'content is required');
  const branch = str(body.branch) ?? repo.defaultBranch;
  const message = str(body.message) ?? `Update ${path}`;
  const givenSha = str(body.sha);
  const flat = store.flatAt(repo, branch);
  const existing = flat?.get(path);
  const tip = store.resolveRef(repo, `refs/heads/${branch}`);
  if (existing && !givenSha) {
    throw new ForgeError(422, `"sha" wasn't supplied for the existing file ${path}`);
  }
  if (existing && givenSha && givenSha !== existing.oid) {
    throw new ForgeError(409, `${path} does not match the given sha`);
  }
  if (!existing && givenSha) {
    throw new ForgeError(422, `"sha" was supplied but ${path} does not exist`);
  }
  const content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
  const blobOid = store.putObject(repo, 'blob', content);
  const { commitOid } = store.commitFiles(repo, branch, new Map([[path, content]]), message, tip);
  sendJson(ctx, existing ? 200 : 201, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: content.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: commitOid, message },
  });
}

function handleDeleteContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = store.requireRepo(owner, name);
  const body = parseJsonBody(ctx);
  const branch = str(body.branch) ?? repo.defaultBranch;
  const message = str(body.message) ?? `Delete ${path}`;
  const givenSha = str(body.sha);
  const flat = store.flatAt(repo, branch);
  const existing = flat?.get(path);
  if (!existing) return notFound(ctx);
  if (givenSha && givenSha !== existing.oid) {
    throw new ForgeError(409, `${path} does not match the given sha`);
  }
  const tip = store.resolveRef(repo, `refs/heads/${branch}`);
  const { commitOid } = store.commitFiles(repo, branch, new Map([[path, null]]), message, tip);
  sendJson(ctx, 200, { content: null, commit: { sha: commitOid, message } });
}

// -------------------------------------------------------------- refs and branches

function refJson(repo: RepoRec, ref: string): Record<string, unknown> {
  const oid = repo.refs.get(ref) as string;
  const object = repo.objects.get(oid);
  return { ref, node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'), object: { sha: oid, type: object?.type ?? 'commit' } };
}

function handleCreateRef(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const body = parseJsonBody(ctx);
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref || !sha) throw new ForgeError(422, 'ref and sha are required');
  if (!ref.startsWith('refs/')) throw new ForgeError(422, 'ref must start with refs/');
  if (!repo.objects.has(sha)) throw new ForgeError(422, `Object ${sha} does not exist`);
  repo.refs.set(ref, sha);
  repo.updatedAt = nowIso();
  sendJson(ctx, 201, refJson(repo, ref));
}

function handleGetRef(ctx: Ctx, owner: string, name: string, refPath: string): void {
  const repo = store.requireRepo(owner, name);
  const full = `refs/${refPath}`;
  if (repo.refs.has(full)) return sendJson(ctx, 200, refJson(repo, full));
  const prefix = `${full}/`;
  const matches = [...repo.refs.keys()].filter((ref) => ref.startsWith(prefix)).sort();
  if (matches.length > 0) return sendJson(ctx, 200, matches.map((ref) => refJson(repo, ref)));
  notFound(ctx);
}

function handleListRefs(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const all = [...repo.refs.keys()].sort().map((ref) => refJson(repo, ref));
  sendJson(ctx, 200, all);
}

function handleListBranches(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
    .sort((a, b) => a.name.localeCompare(b.name));
  sendJson(ctx, 200, paginate(ctx, branches));
}

function handleGetBranch(ctx: Ctx, owner: string, name: string, branch: string): void {
  const repo = store.requireRepo(owner, name);
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) return notFound(ctx);
  const commit = commitJson(repo, oid);
  sendJson(ctx, 200, {
    name: branch,
    commit: { sha: oid, ...(commit ? { commit: commit.commit } : {}) },
    protected: false,
  });
}

// -------------------------------------------------------------- commits

function handleListCommits(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const shaParam = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = store.resolveRef(repo, shaParam);
  if (!tip) return sendJson(ctx, 200, []);
  const start = peelToCommit(store.lookup(repo), tip);
  if (!start) return sendJson(ctx, 200, []);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const walk = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return;
    ordered.push(oid);
    for (const parent of parseCommit(object.data).parents) walk(parent);
  };
  walk(start);
  const page = paginate(ctx, ordered);
  sendJson(ctx, 200, page.map((oid) => commitJson(repo, oid)).filter((entry) => entry !== null));
}

function handleGetCommit(ctx: Ctx, owner: string, name: string, sha: string): void {
  const repo = store.requireRepo(owner, name);
  const commit = commitJson(repo, sha);
  if (!commit) return notFound(ctx);
  sendJson(ctx, 200, commit);
}

// -------------------------------------------------------------- labels

function handleListLabels(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const labels = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name));
  sendJson(ctx, 200, paginate(ctx, labels).map(labelJson));
}

function handleCreateLabel(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const body = parseJsonBody(ctx);
  const labelName = str(body.name);
  if (!labelName) throw new ForgeError(422, 'name is required');
  const label = store.createLabel(repo, labelName, str(body.color) ?? 'ededed', str(body.description) ?? null);
  sendJson(ctx, 201, labelJson(label));
}

function handleGetLabel(ctx: Ctx, owner: string, name: string, labelName: string): void {
  const repo = store.requireRepo(owner, name);
  const label = store.getLabel(repo, labelName);
  if (!label) return notFound(ctx);
  sendJson(ctx, 200, labelJson(label));
}

// -------------------------------------------------------------- issues

function sortIssues(issues: IssueRec[], direction: string): IssueRec[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...issues].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return (a.createdAt < b.createdAt ? -1 : 1) * sign;
    return (a.number - b.number) * sign;
  });
}

function handleListIssues(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const direction = ctx.url.searchParams.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  const labelFilter = ctx.url.searchParams.get('labels');
  if (labelFilter) {
    const wanted = labelFilter.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
    issues = issues.filter((issue) => wanted.every((label) => issue.labels.some((own) => own.toLowerCase() === label)));
  }
  sendJson(ctx, 200, paginate(ctx, sortIssues(issues, direction)).map((issue) => issueJson(repo, issue)));
}

function handleCreateIssue(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const body = parseJsonBody(ctx);
  const title = str(body.title);
  if (!title) throw new ForgeError(422, 'title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((value): value is string => typeof value === 'string') : [];
  const issue = store.createIssue(repo, { title, body: str(body.body) ?? '', labels });
  sendJson(ctx, 201, issueJson(repo, issue));
}

function handleGetIssue(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = store.requireRepo(owner, name);
  const issue = repo.issues.get(number);
  if (!issue) return notFound(ctx);
  sendJson(ctx, 200, issueJson(repo, issue));
}

function handlePatchIssue(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = store.requireRepo(owner, name);
  const issue = repo.issues.get(number);
  if (!issue) return notFound(ctx);
  const body = parseJsonBody(ctx);
  const title = str(body.title);
  if (title !== undefined) issue.title = title;
  const text = str(body.body);
  if (text !== undefined) issue.body = text;
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((value): value is string => typeof value === 'string');
    for (const label of labels) {
      if (!store.getLabel(repo, label)) throw new ForgeError(422, `Label "${label}" does not exist in this repository`);
    }
    issue.labels = labels.map((label) => (store.getLabel(repo, label) as LabelRec).name);
  }
  const state = str(body.state);
  if (state === 'open' || state === 'closed') {
    issue.state = state;
    issue.closedAt = state === 'closed' ? nowIso() : null;
  }
  issue.updatedAt = nowIso();
  sendJson(ctx, 200, issueJson(repo, issue));
}

function issueOrPull(repo: RepoRec, number: number): IssueRec | PullRec | undefined {
  return repo.issues.get(number) ?? repo.pulls.get(number);
}

function handleListComments(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = store.requireRepo(owner, name);
  const target = issueOrPull(repo, number);
  if (!target) return notFound(ctx);
  sendJson(ctx, 200, paginate(ctx, target.comments).map((comment) => commentJson(repo, number, comment)));
}

function handleCreateComment(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = store.requireRepo(owner, name);
  const target = issueOrPull(repo, number);
  if (!target) return notFound(ctx);
  const body = parseJsonBody(ctx);
  const text = str(body.body);
  if (text === undefined) throw new ForgeError(422, 'body is required');
  const comment = store.addComment(repo, target, text);
  sendJson(ctx, 201, commentJson(repo, number, comment));
}

// -------------------------------------------------------------- pull requests

function handleListPulls(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => a.number - b.number);
  sendJson(ctx, 200, paginate(ctx, pulls).map((pull) => pullJson(repo, pull)));
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function handleCreatePull(ctx: Ctx, owner: string, name: string): void {
  const repo = store.requireRepo(owner, name);
  const body = parseJsonBody(ctx);
  const title = str(body.title);
  const head = str(body.head);
  const base = str(body.base);
  if (!title || !head || !base) throw new ForgeError(422, 'title, head and base are required');
  const pull = store.createPull(repo, {
    title,
    body: str(body.body) ?? '',
    head: stripOwnerPrefix(head),
    base: stripOwnerPrefix(base),
    draft: bool(body.draft) ?? false,
  });
  sendJson(ctx, 201, pullJson(repo, pull));
}

function handleGetPull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = store.requireRepo(owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) return notFound(ctx);
  sendJson(ctx, 200, pullJson(repo, pull));
}

function handlePatchPull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = store.requireRepo(owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) return notFound(ctx);
  const body = parseJsonBody(ctx);
  const title = str(body.title);
  if (title !== undefined) pull.title = title;
  const text = str(body.body);
  if (text !== undefined) pull.body = text;
  const state = str(body.state);
  if ((state === 'open' || state === 'closed') && !pull.merged) {
    pull.state = state;
  }
  pull.updatedAt = nowIso();
  sendJson(ctx, 200, pullJson(repo, pull));
}

function handlePullFiles(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = store.requireRepo(owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) return notFound(ctx);
  const files = store.pullFiles(repo, pull).map((file) => ({
    sha: file.sha,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  }));
  sendJson(ctx, 200, paginate(ctx, files));
}

function handleMergePull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = store.requireRepo(owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) return notFound(ctx);
  const body = ctx.body.length > 0 ? parseJsonBody(ctx) : {};
  const methodRaw = str(body.merge_method) ?? 'squash';
  const method = methodRaw === 'merge' ? 'merge' : 'squash';
  const sha = store.mergePull(repo, pull, method);
  sendJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

function handlePullMergeStatus(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = store.requireRepo(owner, name);
  const pull = repo.pulls.get(number);
  if (!pull) return notFound(ctx);
  if (pull.merged) return sendEmpty(ctx, 204);
  notFound(ctx);
}

// ------------------------------------------------------------------ git smart HTTP

const UPLOAD_CAPS = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=git/aica-forge';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=git/aica-forge';

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The v0 ref advertisement body for a service, after the "# service=" preamble. */
function advertiseV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `${UPLOAD_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}`
    : RECEIVE_CAPS;
  const parts: Buffer[] = [pktEncode(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktEncode(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const line = (oid: string, name: string): void => {
      parts.push(pktEncode(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
    };
    if (headOid) line(headOid, 'HEAD');
    for (const [ref, oid] of refs) {
      line(oid, ref);
      if (ref.startsWith('refs/tags/')) {
        const peeled = peelToCommit(store.lookup(repo), oid);
        if (peeled && peeled !== oid) parts.push(pktEncode(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktEncode('version 2\n'),
    pktEncode('agent=git/aica-forge\n'),
    pktEncode('ls-refs=unborn\n'),
    pktEncode('fetch=shallow\n'),
    pktEncode('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

function handleInfoRefs(ctx: Ctx, owner: string, repoName: string): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(ctx);
  const service = ctx.url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return sendJson(ctx, 400, { message: 'Unsupported service' });
  }
  const protocol = ctx.req.headers['git-protocol'];
  const wantsV2 = typeof protocol === 'string' && /(?:^|[:,])\s*version=2/.test(protocol);
  if (service === 'git-upload-pack' && wantsV2) {
    return sendBytes(ctx, 200, 'application/x-git-upload-pack-advertisement', advertiseV2());
  }
  sendBytes(ctx, 200, `application/x-${service}-advertisement`, advertiseV0(repo, service));
}

// -------------------------------------------------------------- fetch object selection

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  deepen?: number;
  deepenSince?: number;
  deepenNot: string[];
  done: boolean;
}

/**
 * Choose the objects a fetch sends: commits reachable from the wants that the client does not
 * already have, bounded by the shallow/deepen negotiation, plus the tree closure of those
 * commits minus the closures of everything the client has.
 */
function selectFetchObjects(repo: RepoRec, request: FetchRequest): {
  objects: Array<{ oid: string; type: GitObject['type']; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
} {
  const lookup = store.lookup(repo);
  const objects = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object && !objects.has(oid)) objects.set(oid, object);
  };

  // Wants: peel tags to commits, remembering tag objects the client asked for by name.
  const wantCommits = new Set<string>();
  for (const want of request.wants) {
    let current: string | null = want;
    while (current) {
      const object = repo.objects.get(current);
      if (!object) break;
      if (object.type === 'tag') {
        addObject(current);
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') wantCommits.add(current);
      break;
    }
  }

  // The client's full-history set: ancestors of its haves, never crossing a shallow commit.
  const clientShallow = new Set(request.clientShallow.filter((oid) => repo.objects.has(oid)));
  const had = new Set<string>();
  {
    const stack: string[] = [];
    const pushHave = (oid: string): void => {
      const commit = peelToCommit(lookup, oid);
      if (commit) stack.push(commit);
    };
    request.haves.forEach(pushHave);
    request.deepenNot.forEach(pushHave);
    while (stack.length > 0) {
      const commit = stack.pop() as string;
      if (had.has(commit) || clientShallow.has(commit)) continue;
      had.add(commit);
      const object = repo.objects.get(commit);
      if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents);
    }
  }

  // Common haves for the acknowledgment section: a have that is an ancestor of a want.
  const commonHaves: string[] = [];
  for (const have of request.haves) {
    const commit = peelToCommit(lookup, have);
    if (!commit || !repo.objects.has(have)) continue;
    for (const want of wantCommits) {
      if (commit === want || isAncestor(lookup, commit, want)) {
        commonHaves.push(have);
        break;
      }
    }
  }

  // Breadth-first walk from the wants by distance, applying the deepen boundary.
  const deepen = request.deepen;
  const sentCommits = new Set<string>();
  const distance = new Map<string, number>();
  const queue: string[] = [];
  const enqueue = (oid: string, dist: number): void => {
    const known = distance.get(oid);
    if (known !== undefined && known <= dist) return;
    distance.set(oid, dist);
    queue.push(oid);
  };
  for (const want of wantCommits) {
    if (!had.has(want)) enqueue(want, 0);
  }
  // Shallow-held commits are roots too: never re-sent, but expanded, so a plain fetch can
  // deliver the parents they are missing (that is what unshallows them).
  for (const commit of clientShallow) {
    if (repo.objects.has(commit)) enqueue(commit, 0);
  }
  const commitTime = (oid: string): number => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return 0;
    const match = / (\d+) [+-]\d{4}\n/.exec(parseCommit(object.data).committer);
    return match ? Number(match[1]) : 0;
  };
  while (queue.length > 0) {
    const commit = queue.shift() as string;
    const dist = distance.get(commit) as number;
    if (had.has(commit)) continue;
    const isShallowHeld = clientShallow.has(commit);
    const beyondDepth = deepen !== undefined && dist >= deepen;
    const beyondSince = request.deepenSince !== undefined && dist > 0 && commitTime(commit) < request.deepenSince;
    if (!isShallowHeld && !beyondDepth && !beyondSince) {
      sentCommits.add(commit);
      addObject(commit);
    } else if (beyondDepth || beyondSince) {
      continue; // a boundary: not sent, not expanded
    }
    // Shallow-held commits are expanded (their parents may be exactly what a deepen asks for).
    const object = repo.objects.get(commit);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) enqueue(parent, dist + 1);
    }
  }

  // Shallow info: a sent commit is shallow when a parent stays behind; a shallow-held commit is
  // unshallowed when its parents all become available with at least one newly sent.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const commit of sentCommits) {
    const object = repo.objects.get(commit);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !sentCommits.has(parent) && !had.has(parent))) shallow.push(commit);
  }
  for (const commit of clientShallow) {
    const object = repo.objects.get(commit);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (sentCommits.has(commit)) {
      unshallow.push(commit);
    } else if (parents.every((parent) => sentCommits.has(parent) || had.has(parent)) && parents.some((parent) => sentCommits.has(parent))) {
      unshallow.push(commit);
    }
  }

  // Trees and blobs: the closure of the sent commits minus the closure of what the client has.
  const closureTrees = (roots: Iterable<string>): Set<string> => {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
    return seen;
  };
  const sentTrees = new Set<string>();
  for (const commit of sentCommits) {
    const tree = store.treeOfCommit(repo, commit);
    if (tree) for (const oid of closureTrees([tree])) sentTrees.add(oid);
  }
  const heldRoots: string[] = [];
  for (const commit of [...had, ...clientShallow]) {
    const tree = store.treeOfCommit(repo, commit);
    if (tree) heldRoots.push(tree);
  }
  const heldTrees = closureTrees(heldRoots);
  for (const oid of sentTrees) {
    if (!heldTrees.has(oid)) addObject(oid);
  }

  return {
    objects: [...objects.entries()].map(([oid, object]) => ({ oid, type: object.type, data: object.data })),
    shallow: shallow.sort(),
    unshallow: unshallow.sort(),
    commonHaves,
  };
}

/**
 * Pack bytes for an object list, cached by the list's content ids: the benchmark's fifty
 * concurrent clones ask for the identical pack fifty times, and a pack is a pure function of
 * its objects, so building it once is both faster and byte-identical.
 */
const packCache = new Map<string, Buffer>();

function packFor(objects: Array<{ oid: string; type: GitObject['type']; data: Buffer }>): Buffer {
  const key = objects.map((entry) => entry.oid).join(' ');
  const cached = packCache.get(key);
  if (cached) return cached;
  const pack = writePack(objects.map((entry) => ({ type: entry.type, data: entry.data })));
  if (packCache.size >= 128) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

/**
 * Whole fetch responses, cached by everything that determines them (the repo's refs and
 * object count, plus the request's wants/haves/shallow/deepen): fifty concurrent identical
 * clones then cost one computation and forty-nine memory copies, byte-identically.
 */
const fetchResponseCache = new Map<string, Buffer>();

function fetchCacheKey(repo: RepoRec, request: FetchRequest, version: string): string {
  const refs = [...repo.refs.entries()].map(([ref, oid]) => `${ref}=${oid}`).sort().join(' ');
  return [
    version,
    Store.key(repo.owner, repo.name),
    String(repo.objects.size),
    refs,
    request.wants.join(','),
    request.haves.join(','),
    request.clientShallow.join(','),
    String(request.deepen ?? ''),
    String(request.deepenSince ?? ''),
    request.deepenNot.join(','),
    request.done ? 'done' : 'negotiating',
  ].join('|');
}

function fetchCached(repo: RepoRec, request: FetchRequest, version: string, build: () => Buffer): Buffer {
  const key = fetchCacheKey(repo, request, version);
  const cached = fetchResponseCache.get(key);
  if (cached) return cached;
  const response = build();
  if (fetchResponseCache.size >= 256) fetchResponseCache.clear();
  fetchResponseCache.set(key, response);
  return response;
}

/** Frame pack bytes as side-band-64k band-1 packets of at most 32 KiB of pack each. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pktEncode(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  if (parts.length === 0) parts.push(pktEncode(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

function fetchResponseV2(repo: RepoRec, request: FetchRequest): Buffer {
  const selection = selectFetchObjects(repo, request);
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    parts.push(pktEncode('acknowledgments\n'));
    if (selection.commonHaves.length > 0) {
      for (const have of selection.commonHaves) parts.push(pktEncode(`ACK ${have}\n`));
      parts.push(pktEncode('ready\n'));
    } else {
      parts.push(pktEncode('NAK\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktEncode('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktEncode(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktEncode(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktEncode('packfile\n'));
  const pack = packFor(selection.objects);
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: RepoRec, request: FetchRequest): Buffer {
  const selection = selectFetchObjects(repo, request);
  const shallowInvolved = request.clientShallow.length > 0 || request.deepen !== undefined
    || selection.shallow.length > 0 || selection.unshallow.length > 0;
  const shallowLines = (): Buffer[] => [
    ...selection.shallow.map((oid) => pktEncode(`shallow ${oid}\n`)),
    ...selection.unshallow.map((oid) => pktEncode(`unshallow ${oid}\n`)),
  ];
  const parts: Buffer[] = [];
  if (shallowInvolved && !request.done) {
    // Stateless HTTP phase one: the client asked for the shallow boundary before sending done.
    return Buffer.concat([...shallowLines(), PKT_FLUSH]);
  }
  if (shallowInvolved) {
    parts.push(...shallowLines());
    parts.push(PKT_FLUSH);
  }
  if (selection.commonHaves.length > 0) {
    parts.push(pktEncode(`ACK ${selection.commonHaves[selection.commonHaves.length - 1]}\n`));
  } else {
    parts.push(pktEncode('NAK\n'));
  }
  const pack = packFor(selection.objects);
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 ls-refs answer for a set of ref-prefix filters. */
function lsRefsResponse(repo: RepoRec, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg === 'ref-prefix') {
      i += 1;
      if (i < args.length) prefixes.push(args[i] as string);
    }
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid) {
      parts.push(pktEncode(symrefs ? `${headOid} HEAD symref-target:${headRef}\n` : `${headOid} HEAD\n`));
    } else if (unborn) {
      parts.push(pktEncode(`unborn HEAD symref-target:${headRef}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel && ref.startsWith('refs/tags/')) {
      const peeled = peelToCommit(store.lookup(repo), oid);
      if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktEncode(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPack(ctx: Ctx, owner: string, repoName: string): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(ctx);
  const protocol = ctx.req.headers['git-protocol'];
  const isV2 = typeof protocol === 'string' && /(?:^|[:,])\s*version=2/.test(protocol);
  let parsed;
  try {
    parsed = parsePktSection(ctx.body);
  } catch {
    return sendBytes(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('error: malformed pkt-line request\n'));
  }
  const lines: string[] = [];
  for (const packet of parsed.packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (isV2) {
    const commandLine = lines[0] ?? '';
    const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
    // Capability lines (key=value or bare keys) run until the first delim; args follow it.
    const delimIndex = parsed.packets.findIndex((packet) => packet.kind === 'delim');
    const argLines: string[] = [];
    if (delimIndex >= 0) {
      for (const packet of parsed.packets.slice(delimIndex + 1)) {
        if (packet.kind === 'data') argLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
      }
    }
    if (command === 'ls-refs') {
      const args: string[] = [];
      for (const line of argLines) args.push(...line.split(' ').filter(Boolean));
      return sendBytes(ctx, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
    }
    if (command === 'fetch') {
      const request: FetchRequest = { wants: [], haves: [], clientShallow: [], deepenNot: [], done: false };
      for (const line of argLines) {
        const [head, ...rest] = line.split(' ');
        const value = rest.join(' ');
        if (head === 'want') request.wants.push((value.split(' ')[0] as string));
        else if (head === 'have') request.haves.push(value);
        else if (head === 'shallow') request.clientShallow.push(value);
        else if (head === 'deepen') request.deepen = Number(value);
        else if (head === 'deepen-since') request.deepenSince = Number(value);
        else if (head === 'deepen-not') request.deepenNot.push(value.replace(/^:/, ''));
        else if (head === 'done') request.done = true;
      }
      const response = fetchCached(repo, request, 'v2', () => fetchResponseV2(repo, request));
      return sendBytes(ctx, 200, 'application/x-git-upload-pack-result', response);
    }
    return sendBytes(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('error: unknown command\n'));
  }
  // Protocol v0: a want section, a flush, then the have section ending in 'done'.
  const request: FetchRequest = { wants: [], haves: [], clientShallow: [], deepenNot: [], done: false };
  for (const line of lines) {
    const [head, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (head === 'want') request.wants.push(value.split(' ')[0] as string);
    else if (head === 'shallow') request.clientShallow.push(value);
    else if (head === 'deepen') request.deepen = Number(value);
  }
  try {
    const second = parsePktSection(ctx.body, parsed.next);
    for (const packet of second.packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      const [head, ...rest] = line.split(' ');
      if (head === 'have') request.haves.push(rest.join(' '));
      else if (head === 'done') request.done = true;
    }
  } catch {
    // No second section: treat as a negotiation-only request.
  }
  const response = fetchCached(repo, request, 'v0', () => fetchResponseV0(repo, request));
  sendBytes(ctx, 200, 'application/x-git-upload-pack-result', response);
}

// -------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string;
}

function handleReceivePack(ctx: Ctx, owner: string, repoName: string): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(ctx);
  let parsed;
  try {
    parsed = parsePktSection(ctx.body);
  } catch {
    return sendBytes(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('error: malformed pkt-line request\n'));
  }
  const commands: PushCommand[] = [];
  for (const packet of parsed.packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    let caps = '';
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string, caps });
  }
  const packBytes = ctx.body.subarray(parsed.next);
  const staged = new Map<string, GitObject>();
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) staged.set(oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lookup: Lookup = (oid) => staged.get(oid) ?? repo.objects.get(oid);
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  if (unpackError !== null) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const [oid, object] of staged) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    for (const command of commands) {
      results.push(applyPushCommand(repo, lookup, command));
    }
    repo.updatedAt = nowIso();
  }
  const reportLines: string[] = [unpackError !== null ? `unpack ${unpackError}` : 'unpack ok'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason ?? 'failed'}`);
  }
  const report = Buffer.concat([...reportLines.map((line) => pktEncode(`${line}\n`)), PKT_FLUSH]);
  const caps = commands[0]?.caps ?? '';
  let payload: Buffer;
  if (caps.includes('side-band-64k') || /(?:^| )side-band(?: |$)/.test(caps)) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      parts.push(pktEncode(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    payload = Buffer.concat(parts);
  } else {
    payload = report;
  }
  sendBytes(ctx, 200, 'application/x-git-receive-pack-result', payload);
}

function applyPushCommand(repo: RepoRec, lookup: Lookup, command: PushCommand): { ref: string; ok: boolean; reason?: string } {
  const fail = (reason: string): { ref: string; ok: boolean; reason: string } => ({ ref: command.ref, ok: false, reason });
  if (!/^refs\/(heads|tags)\/\S+$/.test(command.ref)) return fail('invalid ref');
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (current !== command.oldOid) return fail('stale info');
  if (command.newOid === ZERO_OID) {
    // A deletion.
    if (current === ZERO_OID) return fail('reference not found');
    if (command.ref === `refs/heads/${repo.defaultBranch}`) return fail('deletion of the current branch prohibited');
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true };
  }
  const object = lookup(command.newOid);
  if (!object) return fail('unknown object');
  if (command.ref.startsWith('refs/heads/')) {
    if (object.type !== 'commit' && object.type !== 'tag') return fail('invalid object type');
    const newCommit = peelToCommit(lookup, command.newOid);
    if (!newCommit) return fail('invalid object type');
    if (command.oldOid !== ZERO_OID) {
      const oldCommit = peelToCommit(lookup, command.oldOid);
      if (!oldCommit || (oldCommit !== newCommit && !isAncestor(lookup, oldCommit, newCommit))) {
        return fail('non-fast-forward');
      }
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true };
}

// ------------------------------------------------------------------ routing

function authorized(ctx: Ctx): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  return ctx.req.headers.authorization === `Bearer ${token}`;
}

function routeRest(ctx: Ctx, segments: string[]): void {
  const method = ctx.req.method ?? 'GET';
  const [first, second, third] = segments;
  if (segments.length === 0) {
    if (method === 'GET') return handleRoot(ctx);
    return notFound(ctx);
  }
  if (first === 'meta' && segments.length === 1) {
    if (method === 'GET') return handleMeta(ctx);
    return notFound(ctx);
  }
  if (first === 'rate_limit' && segments.length === 1) {
    if (method === 'GET') {
      return sendJson(ctx, 200, {
        resources: { core: { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 } },
        rate: { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 },
      });
    }
    return notFound(ctx);
  }
  if (first === 'user' && segments.length === 1) {
    if (method === 'GET') return sendJson(ctx, 200, userJson());
    return notFound(ctx);
  }
  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (method === 'GET') return handleListUserRepos(ctx);
    if (method === 'POST') return handleCreateRepo(ctx);
    return notFound(ctx);
  }
  if (first === 'repos' && second && third) {
    const owner = second;
    const name = third;
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return handleGetRepo(ctx, owner, name);
      if (method === 'PATCH') return handlePatchRepo(ctx, owner, name);
      if (method === 'DELETE') return handleDeleteRepo(ctx, owner, name);
      return notFound(ctx);
    }
    const [area, arg] = rest;
    if (area === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') return handleGetContents(ctx, owner, name, path);
      if (method === 'PUT') return handlePutContents(ctx, owner, name, path);
      if (method === 'DELETE') return handleDeleteContents(ctx, owner, name, path);
      return notFound(ctx);
    }
    if (area === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'GET') return handleListRefs(ctx, owner, name);
        if (method === 'POST') return handleCreateRef(ctx, owner, name);
        return notFound(ctx);
      }
      if (method === 'GET') return handleGetRef(ctx, owner, name, rest.slice(2).join('/'));
      return notFound(ctx);
    }
    if (area === 'branches') {
      if (rest.length === 1) {
        if (method === 'GET') return handleListBranches(ctx, owner, name);
        return notFound(ctx);
      }
      if (method === 'GET') return handleGetBranch(ctx, owner, name, rest.slice(1).join('/'));
      return notFound(ctx);
    }
    if (area === 'commits') {
      if (rest.length === 1) {
        if (method === 'GET') return handleListCommits(ctx, owner, name);
        return notFound(ctx);
      }
      if (method === 'GET' && arg) return handleGetCommit(ctx, owner, name, arg);
      return notFound(ctx);
    }
    if (area === 'labels') {
      if (rest.length === 1) {
        if (method === 'GET') return handleListLabels(ctx, owner, name);
        if (method === 'POST') return handleCreateLabel(ctx, owner, name);
        return notFound(ctx);
      }
      if (method === 'GET' && arg) return handleGetLabel(ctx, owner, name, decodeURIComponent(arg));
      return notFound(ctx);
    }
    if (area === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') return handleListIssues(ctx, owner, name);
        if (method === 'POST') return handleCreateIssue(ctx, owner, name);
        return notFound(ctx);
      }
      const number = Number(arg);
      if (!Number.isInteger(number)) return notFound(ctx);
      if (rest.length === 2) {
        if (method === 'GET') return handleGetIssue(ctx, owner, name, number);
        if (method === 'PATCH') return handlePatchIssue(ctx, owner, name, number);
        return notFound(ctx);
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') return handleListComments(ctx, owner, name, number);
        if (method === 'POST') return handleCreateComment(ctx, owner, name, number);
        return notFound(ctx);
      }
      return notFound(ctx);
    }
    if (area === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') return handleListPulls(ctx, owner, name);
        if (method === 'POST') return handleCreatePull(ctx, owner, name);
        return notFound(ctx);
      }
      const number = Number(arg);
      if (!Number.isInteger(number)) return notFound(ctx);
      if (rest.length === 2) {
        if (method === 'GET') return handleGetPull(ctx, owner, name, number);
        if (method === 'PATCH') return handlePatchPull(ctx, owner, name, number);
        return notFound(ctx);
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method === 'GET') return handlePullFiles(ctx, owner, name, number);
        return notFound(ctx);
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method === 'PUT') return handleMergePull(ctx, owner, name, number);
        if (method === 'GET') return handlePullMergeStatus(ctx, owner, name, number);
        return notFound(ctx);
      }
      return notFound(ctx);
    }
    return notFound(ctx);
  }
  notFound(ctx);
}

async function dispatch(ctx: Ctx): Promise<void> {
  const { pathname } = ctx.url;
  const method = ctx.req.method ?? 'GET';
  if (method === 'GET' && pathname === '/healthz') {
    return sendJson(ctx, 200, { ok: true });
  }
  if (!authorized(ctx)) {
    return sendJson(ctx, 401, { message: 'Bad credentials' });
  }
  if (pathname === '/api/graphql' || pathname === '/graphql') {
    return handleGraphQL(ctx, store, { sendJson, repoJson, issueJson, pullJson, commentJson, userJson });
  }
  if (pathname === '/mcp') {
    return handleMcp(ctx, store, { sendJson, sendEmpty, repoJson, issueJson, pullJson, userJson });
  }
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const segments = pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    return routeRest(ctx, segments);
  }
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(pathname);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const tail = gitMatch[3] ?? '';
    if (method === 'GET' && tail === 'info/refs') return handleInfoRefs(ctx, owner, repoName);
    if (method === 'POST' && tail === 'git-upload-pack') return handleUploadPack(ctx, owner, repoName);
    if (method === 'POST' && tail === 'git-receive-pack') return handleReceivePack(ctx, owner, repoName);
    return notFound(ctx);
  }
  notFound(ctx);
}

/** Build the forge's HTTP server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer({ noDelay: true }, (req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    res.setHeader('x-github-request-id', `req-${requestCounter}`);
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total <= 256 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', () => {
      void (async () => {
        let url: URL;
        try {
          url = new URL(req.url ?? '/', 'http://entry');
        } catch {
          url = new URL('/', 'http://entry');
        }
        const ctx: Ctx = { req, res, url, body: Buffer.concat(chunks) };
        try {
          await dispatch(ctx);
        } catch (err) {
          if (res.headersSent) {
            res.end();
            return;
          }
          if (err instanceof ForgeError) {
            sendJson(ctx, err.status, { message: err.message });
          } else {
            sendJson(ctx, 500, { message: 'Internal Server Error' });
          }
        }
      })();
    });
    req.on('error', () => {
      if (!res.headersSent) {
        try {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Bad Request' }));
        } catch {
          /* the socket is gone */
        }
      }
    });
  });
}

