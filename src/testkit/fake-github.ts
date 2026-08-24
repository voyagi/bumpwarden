import { ROUTES, type GitHubRequest, type GitHubResponse } from '../io/github-actor.js';

export interface RecordedCall {
  route: string;
  params: Record<string, unknown>;
}

interface StoredIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  isPullRequest: boolean;
  author: string;
  headRef: string | null;
}

interface StoredComment {
  id: number;
  issueNumber: number;
  body: string;
  author: string;
}

export interface FakeGitHubOptions {
  defaultBranch?: string;
  canPush?: boolean;
  files?: Record<string, string>;
  issues?: Array<Partial<StoredIssue>>;
  comments?: Array<Partial<StoredComment>>;
  /** Route to fail, and the status to fail it with. */
  failures?: Record<string, number>;
}

export interface FakeGitHub {
  request: GitHubRequest;
  calls: RecordedCall[];
  issues: StoredIssue[];
  comments: StoredComment[];
  branches: Set<string>;
  fileOn(branch: string, path: string): string | undefined;
}

type Params = Record<string, unknown>;
type Handler = (params: Params) => GitHubResponse;

const HOST = 'https://github.com/demo/app';

function shaFor(text: string): string {
  let hash = 0;
  for (const character of text) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 0xffffffff;
  }
  return `sha${hash.toString(16)}`;
}

function issueJson(issue: StoredIssue): Record<string, unknown> {
  return {
    number: issue.number,
    html_url: `${HOST}/${issue.isPullRequest ? 'pull' : 'issues'}/${issue.number}`,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.author },
    ...(issue.isPullRequest ? { pull_request: {}, head: { ref: issue.headRef ?? '' } } : {}),
  };
}

function commentJson(comment: StoredComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    html_url: `${HOST}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    user: { login: comment.author },
  };
}

function seedIssues(seeds: Array<Partial<StoredIssue>>): StoredIssue[] {
  return seeds.map((issue, index) => ({
    number: issue.number ?? 10 + index,
    title: issue.title ?? '',
    body: issue.body ?? '',
    labels: issue.labels ?? [],
    state: issue.state ?? 'open',
    isPullRequest: issue.isPullRequest ?? false,
    author: issue.author ?? 'operator',
    headRef: issue.headRef ?? null,
  }));
}

function seedComments(seeds: Array<Partial<StoredComment>>): StoredComment[] {
  return seeds.map((comment, index) => ({
    id: comment.id ?? 800 + index,
    issueNumber: comment.issueNumber ?? 0,
    body: comment.body ?? '',
    author: comment.author ?? 'bumpwarden',
  }));
}

/**
 * The real API answers a listing one page at a time, and the caller reads on until a page comes
 * back short. A fake that ignored the page parameter would hand back the same first page forever,
 * so a test with more than one page of anything would either hang or prove nothing.
 */
function paged<T>(rows: T[], params: Record<string, unknown>): T[] {
  const size = Number(params.per_page ?? 30);
  const page = Number(params.page ?? 1);
  return rows.slice((page - 1) * size, page * size);
}

/**
 * A small stand-in for the parts of GitHub the actor writes to. It keeps state between calls, so a
 * second run over the same bump really does find the issue the first run opened, which is the only
 * way to prove idempotency without a network.
 */
export function fakeGitHub(options: FakeGitHubOptions = {}): FakeGitHub {
  const defaultBranch = options.defaultBranch ?? 'main';
  const calls: RecordedCall[] = [];
  const labels = new Set<string>();
  const branches = new Set<string>([defaultBranch]);
  const files = new Map<string, string>();
  const issues = seedIssues(options.issues ?? []);
  const comments = seedComments(options.comments ?? []);
  let nextNumber = 100;
  let nextCommentId = 900;

  for (const [path, text] of Object.entries(options.files ?? {})) {
    files.set(`${defaultBranch}:${path}`, text);
  }

  function findIssue(params: Params): StoredIssue {
    const number = Number(params.issue_number);
    const issue = issues.find((candidate) => candidate.number === number);
    if (!issue) throw new Error(`fake GitHub has no issue ${number}`);
    return issue;
  }

  const handlers: Record<string, Handler> = {
    [ROUTES.repository]: () => ({
      status: 200,
      data: { default_branch: defaultBranch, permissions: { push: options.canPush ?? true } },
    }),

    [ROUTES.issues]: (params) => {
      const wanted = String(params.labels ?? '');
      const matching = issues.filter((issue) => issue.labels.includes(wanted));
      return { status: 200, data: paged(matching, params).map(issueJson) };
    },

    [ROUTES.pulls]: (params) => ({
      status: 200,
      data: paged(
        issues.filter((issue) => issue.isPullRequest),
        params,
      ).map(issueJson),
    }),

    [ROUTES.comments]: (params) => {
      const number = Number(params.issue_number);
      const matching = comments.filter((comment) => comment.issueNumber === number);
      return { status: 200, data: paged(matching, params).map(commentJson) };
    },

    [ROUTES.createLabel]: (params) => {
      const name = String(params.name);
      if (labels.has(name)) return { status: 422, data: { message: 'already_exists' } };
      labels.add(name);
      return { status: 201, data: { name } };
    },

    [ROUTES.createIssue]: (params) => {
      const issue: StoredIssue = {
        number: (nextNumber += 1),
        title: String(params.title),
        body: String(params.body),
        labels: (params.labels as string[]) ?? [],
        state: 'open',
        isPullRequest: false,
        author: 'bumpwarden',
        headRef: null,
      };
      issues.push(issue);
      return { status: 201, data: issueJson(issue) };
    },

    [ROUTES.updateIssue]: (params) => {
      const issue = findIssue(params);
      issue.title = String(params.title);
      issue.body = String(params.body);
      issue.labels = (params.labels as string[]) ?? issue.labels;
      return { status: 200, data: issueJson(issue) };
    },

    [ROUTES.addLabels]: (params) => {
      const issue = findIssue(params);
      issue.labels = [...new Set([...issue.labels, ...((params.labels as string[]) ?? [])])];
      return { status: 200, data: issue.labels.map((name) => ({ name })) };
    },

    [ROUTES.createComment]: (params) => {
      const comment: StoredComment = {
        id: (nextCommentId += 1),
        issueNumber: Number(params.issue_number),
        body: String(params.body),
        author: 'bumpwarden',
      };
      comments.push(comment);
      return { status: 201, data: commentJson(comment) };
    },

    [ROUTES.updateComment]: (params) => {
      const id = Number(params.comment_id);
      const comment = comments.find((candidate) => candidate.id === id);
      if (!comment) throw new Error(`fake GitHub has no comment ${id}`);
      comment.body = String(params.body);
      return { status: 200, data: commentJson(comment) };
    },

    [ROUTES.ref]: (params) => {
      const branch = String(params.branch);
      if (!branches.has(branch)) return { status: 404, data: { message: 'Not Found' } };
      return { status: 200, data: { object: { sha: shaFor(branch) } } };
    },

    [ROUTES.createRef]: (params) => {
      const branch = String(params.ref).replace('refs/heads/', '');
      if (branches.has(branch)) return { status: 422, data: { message: 'Reference exists' } };
      branches.add(branch);
      for (const [key, text] of [...files.entries()]) {
        const [source, path] = key.split(':');
        if (source === defaultBranch && path) files.set(`${branch}:${path}`, text);
      }
      return { status: 201, data: { ref: params.ref } };
    },

    [ROUTES.readFile]: (params) => {
      const text = files.get(`${String(params.ref)}:${String(params.path)}`);
      if (text === undefined) return { status: 404, data: { message: 'Not Found' } };
      return {
        status: 200,
        data: {
          content: Buffer.from(text, 'utf8').toString('base64'),
          encoding: 'base64',
          sha: shaFor(text),
        },
      };
    },

    [ROUTES.writeFile]: (params) => {
      const key = `${String(params.branch)}:${String(params.path)}`;
      const current = files.get(key);
      if (current !== undefined && shaFor(current) !== String(params.sha)) {
        return { status: 409, data: { message: 'does not match' } };
      }
      files.set(key, Buffer.from(String(params.content), 'base64').toString('utf8'));
      return { status: 200, data: { commit: { sha: shaFor(key) } } };
    },

    [ROUTES.createPull]: (params) => {
      const pull: StoredIssue = {
        number: (nextNumber += 1),
        title: String(params.title),
        body: String(params.body),
        labels: [],
        state: 'open',
        isPullRequest: true,
        author: 'bumpwarden',
        headRef: String(params.head),
      };
      issues.push(pull);
      return { status: 201, data: issueJson(pull) };
    },
  };

  const request: GitHubRequest = async (route, params) => {
    calls.push({ route, params });

    const failure = options.failures?.[route];
    if (failure) return { status: failure, data: { message: 'forced failure' } };

    const handler = handlers[route];
    if (!handler) throw new Error(`fake GitHub was called with an unknown route: ${route}`);
    return handler(params);
  };

  return {
    request,
    calls,
    issues,
    comments,
    branches,
    fileOn: (branch, path) => files.get(`${branch}:${path}`),
  };
}
