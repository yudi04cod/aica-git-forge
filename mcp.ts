// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP, answered as
// plain application/json. It speaks the modern discovery handshake (server/discover) and the
// legacy initialize flow, and exposes the forge's core operations as tools backed by the same
// store as REST — a repo or issue made over MCP reads back identically over REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeError,
  Store,
  VIEWER,
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

export interface McpHelpers {
  sendJson: (ctx: HttpCtx, status: number, value: unknown) => void;
  sendEmpty: (ctx: HttpCtx, status: number) => void;
  repoJson: (repo: RepoRec) => Record<string, unknown>;
  issueJson: (repo: RepoRec, issue: IssueRec) => Record<string, unknown>;
  pullJson: (repo: RepoRec, pull: PullRec) => Record<string, unknown>;
  userJson: () => Record<string, unknown>;
}

const SERVER_INFO = { name: 'aica-git-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ------------------------------------------------------------------ tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (store: Store, helpers: McpHelpers, args: Record<string, unknown>) => unknown;
}

function argStr(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') {
    throw new RpcError(-32602, `Missing or invalid required argument: ${name}`);
  }
  return value;
}

function argOptStr(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function requireRepo(store: Store, args: Record<string, unknown>): RepoRec {
  const owner = argStr(args, 'owner');
  const name = argStr(args, 'repo');
  const repo = store.getRepo(owner, name);
  if (!repo) throw new ToolFailure(`Repository ${owner}/${name} not found`);
  return repo;
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

class ToolFailure extends Error {}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    run: (store, helpers, args) => {
      const name = argStr(args, 'name');
      const repo = store.createRepo(name, {
        description: argOptStr(args, 'description') ?? '',
        isPrivate: args.private === true,
      });
      return helpers.repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
    run: (_store, helpers, args) => helpers.repoJson(requireRepo(_store, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (store, helpers, args) => {
      const repo = requireRepo(store, args);
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).filter((value): value is string => typeof value === 'string') : [];
      const issue = store.createIssue(repo, { title: argStr(args, 'title'), body: argOptStr(args, 'body') ?? '', labels });
      return helpers.issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, helpers, args) => {
      const repo = requireRepo(store, args);
      const state = argOptStr(args, 'state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return { issues: issues.map((issue) => helpers.issueJson(repo, issue)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
        body: { type: 'string', description: 'The pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (store, helpers, args) => {
      const repo = requireRepo(store, args);
      const pull = store.createPull(repo, {
        title: argStr(args, 'title'),
        body: argOptStr(args, 'body') ?? '',
        head: argStr(args, 'head'),
        base: argStr(args, 'base'),
      });
      return helpers.pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, helpers, args) => {
      const repo = requireRepo(store, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) throw new ToolFailure(`Pull request #${number} not found`);
      store.mergePull(repo, pull, 'squash');
      return helpers.pullJson(repo, pull);
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, helpers, args) => {
      const repo = requireRepo(store, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) throw new ToolFailure(`Pull request #${number} not found`);
      return helpers.pullJson(repo, pull);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, helpers, args) => {
      const repo = requireRepo(store, args);
      const state = argOptStr(args, 'state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      return { pull_requests: pulls.map((pull) => helpers.pullJson(repo, pull)) };
    },
  },
];

/** The tools/list payload, built once so two calls answer byte-identically. */
const TOOLS_LIST_JSON = JSON.stringify({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
});

// ------------------------------------------------------------------ JSON-RPC handling

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function resultResponse(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleToolsCall(store: Store, helpers: McpHelpers, params: Record<string, unknown>): unknown {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
  const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments
    : {}) as Record<string, unknown>;
  // Missing required arguments are a protocol error, before any tool logic runs.
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) {
      throw new RpcError(-32602, `Missing required argument: ${required}`);
    }
  }
  try {
    const payload = tool.run(store, helpers, args);
    const text = JSON.stringify(payload);
    return {
      content: [{ type: 'text', text }],
      structuredContent: payload,
      isError: false,
    };
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = err instanceof ForgeError ? err.message : err instanceof Error ? err.message : 'Tool execution failed';
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }
}

function handleRpc(store: Store, helpers: McpHelpers, request: RpcRequest): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? request.params
    : {}) as Record<string, unknown>;
  const isNotification = id === undefined;
  try {
    switch (method) {
      case 'server/discover':
        return resultResponse(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: SERVER_INFO,
          instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests as MCP tools.',
        });
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
        const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-03-26';
        return resultResponse(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests as MCP tools.',
        });
      }
      case 'ping':
        return resultResponse(id, {});
      case 'tools/list': {
        // Answered from the prebuilt payload so repeat calls are byte-identical.
        const parsed = JSON.parse(TOOLS_LIST_JSON) as unknown;
        return resultResponse(id, parsed);
      }
      case 'tools/call':
        return resultResponse(id, handleToolsCall(store, helpers, params));
      case 'resources/list':
        return resultResponse(id, { resources: [] });
      case 'resources/templates/list':
        return resultResponse(id, { resourceTemplates: [] });
      case 'prompts/list':
        return resultResponse(id, { prompts: [] });
      default:
        if (isNotification) return null;
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    if (err instanceof RpcError) return errorResponse(id, err.code, err.message);
    return errorResponse(id, -32603, err instanceof Error ? err.message : 'Internal error');
  }
}

// ------------------------------------------------------------------ HTTP entry

export function handleMcp(ctx: HttpCtx, store: Store, helpers: McpHelpers): void {
  if (ctx.req.method === 'GET' || ctx.req.method === 'DELETE') {
    helpers.sendEmpty(ctx, 405);
    return;
  }
  if (ctx.req.method !== 'POST') {
    helpers.sendEmpty(ctx, 405);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    helpers.sendJson(ctx, 400, errorResponse(null, -32700, 'Parse error: the body is not valid JSON'));
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => handleRpc(store, helpers, (entry ?? {}) as RpcRequest))
      .filter((entry) => entry !== null);
    if (responses.length === 0) {
      helpers.sendEmpty(ctx, 202);
      return;
    }
    helpers.sendJson(ctx, 200, responses);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    helpers.sendJson(ctx, 400, errorResponse(null, -32600, 'Invalid Request'));
    return;
  }
  const response = handleRpc(store, helpers, parsed as RpcRequest);
  if (response === null) {
    helpers.sendEmpty(ctx, 202);
    return;
  }
  helpers.sendJson(ctx, 200, response);
}

export { VIEWER };
