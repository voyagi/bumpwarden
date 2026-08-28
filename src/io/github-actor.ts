import { Octokit } from '@octokit/rest';

export interface GitHubResponse {
  status: number;
  data: unknown;
}

export type GitHubRequest = (
  route: string,
  params: Record<string, unknown>,
) => Promise<GitHubResponse>;

/**
 * Every route bumpwarden can call, in one place. There is no merge route here and no method builds
 * a route string of its own, so "the agent never merges" is a property of this object rather than a
 * promise in a README. `github-actor.test.ts` fails if a merge route ever appears.
 */
export const ROUTES = {
  repository: 'GET /repos/{owner}/{repo}',
  issues: 'GET /repos/{owner}/{repo}/issues',
  pulls: 'GET /repos/{owner}/{repo}/pulls',
  comments: 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
  createLabel: 'POST /repos/{owner}/{repo}/labels',
  createIssue: 'POST /repos/{owner}/{repo}/issues',
  updateIssue: 'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
  createComment: 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
  updateComment: 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
  addLabels: 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
  ref: 'GET /repos/{owner}/{repo}/git/ref/heads/{branch}',
  createRef: 'POST /repos/{owner}/{repo}/git/refs',
  readFile: 'GET /repos/{owner}/{repo}/contents/{path}',
  writeFile: 'PUT /repos/{owner}/{repo}/contents/{path}',
  createPull: 'POST /repos/{owner}/{repo}/pulls',
} as const;

/**
 * The one route that is not about a repository. It reads the login the token acts under, which is
 * what tells a comment this agent wrote from one somebody else left carrying the same marker. It
 * holds no `{...}` parameter, so unlike the routes above there is nothing in it to aim, and it is a
 * GET, so there is nothing to write through it either.
 */
export const VIEWER_ROUTE = 'GET /user';

export interface RepositoryTarget {
  owner: string;
  repo: string;
}

export interface RepositoryFacts {
  defaultBranch: string;
  /** False for a read-only or missing token: the run then records what it would have done. */
  canWrite: boolean;
}

export interface IssueLike {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  labels: string[];
  isPullRequest: boolean;
  author: string;
  /** Present on pull requests: the branch the pull request would merge. */
  headRef: string | null;
}

export interface CommentLike {
  id: number;
  body: string;
  url: string;
  author: string;
}

export interface FileContents {
  text: string;
  sha: string;
}

interface RawIssue {
  number?: number;
  html_url?: string;
  title?: string;
  body?: string | null;
  state?: string;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
  user?: { login?: string };
  head?: { ref?: string };
}

interface RawComment {
  id?: number;
  body?: string | null;
  html_url?: string;
  user?: { login?: string };
}

const LABEL_COLOR = '4f5b56';
const OK = new Set([200, 201]);

function labelNames(labels: RawIssue['labels']): string[] {
  return (labels ?? [])
    .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
    .filter((name) => name.length > 0);
}

function toIssue(raw: RawIssue): IssueLike {
  return {
    number: raw.number ?? 0,
    url: raw.html_url ?? '',
    title: raw.title ?? '',
    body: raw.body ?? '',
    state: raw.state ?? 'open',
    labels: labelNames(raw.labels),
    isPullRequest: raw.pull_request !== undefined || raw.head !== undefined,
    author: raw.user?.login ?? '',
    headRef: raw.head?.ref ?? null,
  };
}

function toComment(raw: RawComment): CommentLike {
  return {
    id: raw.id ?? 0,
    body: raw.body ?? '',
    url: raw.html_url ?? '',
    author: raw.user?.login ?? '',
  };
}

export interface ActorOptions {
  /** Serialises writes. GitHub answers a burst of content writes with a secondary rate limit. */
  minWriteIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_WRITE_INTERVAL_MS = 1000;

/** GitHub's own maximum for a listing page, so this is the fewest requests a full read can take. */
const PAGE_SIZE = 100;

/** A runaway guard, not a policy. Ten pages is a thousand items, and reaching it is reported. */
const MAX_PAGES = 10;

/**
 * Writes for exactly one repository. Owner and repo come from the constructor and are re-applied to
 * every request, so no caller can aim a write at a repository the operator did not put on the watch
 * list, whatever a release note or a model output says.
 */
export class RepositoryActor {
  private readonly minWriteIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Null rather than 0: "never written" and "written at the epoch" must not read the same. */
  private lastWriteAt: number | null = null;
  private readonly ensuredLabels = new Set<string>();
  /** Undefined until asked: null is an answer GitHub gave, not a question nobody has put yet. */
  private selfLoginAnswer: string | null | undefined;

  constructor(
    private readonly send: GitHubRequest,
    readonly target: RepositoryTarget,
    options: ActorOptions = {},
  ) {
    this.minWriteIntervalMs = options.minWriteIntervalMs ?? DEFAULT_WRITE_INTERVAL_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  private async read(route: string, params: Record<string, unknown> = {}): Promise<GitHubResponse> {
    return this.send(route, { ...params, owner: this.target.owner, repo: this.target.repo });
  }

  /**
   * Every list this actor reads is asked a question of the form "has this bump been reported
   * already", so a page boundary is not a display limit here, it is a wrong answer. A marker on
   * page two is invisible to one read, and an invisible marker opens a second issue for a bump
   * that already has one. The cap is a runaway guard rather than a policy: a repository past a
   * thousand of these has other problems, and the log line says so rather than the list going
   * quietly short.
   */
  private async readAll<T>(
    route: string,
    params: Record<string, unknown>,
    what: string,
  ): Promise<T[]> {
    const collected: T[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await this.read(route, { ...params, per_page: PAGE_SIZE, page });
      const batch = this.expect(response, what) as T[];
      collected.push(...batch);
      if (batch.length < PAGE_SIZE) return collected;
    }

    throw new Error(
      `${what} did not finish inside ${MAX_PAGES} pages, so the result would have been incomplete`,
    );
  }

  private async write(route: string, params: Record<string, unknown>): Promise<GitHubResponse> {
    if (this.lastWriteAt !== null) {
      const waited = this.now() - this.lastWriteAt;
      if (waited < this.minWriteIntervalMs) await this.sleep(this.minWriteIntervalMs - waited);
    }
    this.lastWriteAt = this.now();
    return this.read(route, params);
  }

  private expect(response: GitHubResponse, what: string): unknown {
    if (!OK.has(response.status)) {
      throw new Error(`${what} failed with ${response.status}`);
    }
    return response.data;
  }

  async facts(): Promise<RepositoryFacts> {
    const response = await this.read(ROUTES.repository);
    const data = this.expect(response, 'reading the repository') as {
      default_branch?: string;
      permissions?: { push?: boolean };
    };
    return {
      defaultBranch: data.default_branch ?? 'main',
      canWrite: data.permissions?.push === true,
    };
  }

  /**
   * The login this token acts under, read once and kept for the rest of the actor's life. Anything
   * other than a login comes back as null rather than as an exception: a token that may not read
   * its own identity can still open issues and comment, and a caller that cannot name itself is
   * expected to leave a comment it cannot prove is its own alone rather than to stop.
   */
  async selfLogin(): Promise<string | null> {
    if (this.selfLoginAnswer === undefined) {
      // Straight to the transport rather than through `read`, which would attach an owner and a
      // repo this route has nowhere to put.
      const response = await this.send(VIEWER_ROUTE, {});
      const login = OK.has(response.status)
        ? (response.data as { login?: string } | null)?.login
        : undefined;
      this.selfLoginAnswer = typeof login === 'string' && login.length > 0 ? login : null;
    }
    return this.selfLoginAnswer;
  }

  async listBumpwardenIssues(label: string): Promise<IssueLike[]> {
    const data = await this.readAll<RawIssue>(
      ROUTES.issues,
      { labels: label, state: 'all' },
      'listing issues',
    );
    return data.map(toIssue);
  }

  async listOpenPullRequests(): Promise<IssueLike[]> {
    const data = await this.readAll<RawIssue>(
      ROUTES.pulls,
      { state: 'open' },
      'listing pull requests',
    );
    return data.map(toIssue);
  }

  /**
   * Read whole for the same reason as the two above: the caller is looking for bumpwarden's own
   * comment by its marker, and a marker on a later page means a second comment beside the first
   * on every run after that.
   */
  async listComments(issueNumber: number): Promise<CommentLike[]> {
    const data = await this.readAll<RawComment>(
      ROUTES.comments,
      { issue_number: issueNumber },
      'listing comments',
    );
    return data.map(toComment);
  }

  /** A label that does not exist yet is created; one that already exists answers 422, which is fine. */
  async ensureLabels(labels: string[]): Promise<void> {
    for (const name of labels) {
      if (this.ensuredLabels.has(name)) continue;
      await this.write(ROUTES.createLabel, { name, color: LABEL_COLOR, description: 'bumpwarden' });
      this.ensuredLabels.add(name);
    }
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueLike> {
    await this.ensureLabels(input.labels);
    const response = await this.write(ROUTES.createIssue, input);
    return toIssue(this.expect(response, 'creating an issue') as RawIssue);
  }

  async updateIssue(
    issueNumber: number,
    input: { title: string; body: string; labels: string[] },
  ): Promise<IssueLike> {
    await this.ensureLabels(input.labels);
    const response = await this.write(ROUTES.updateIssue, { issue_number: issueNumber, ...input });
    return toIssue(this.expect(response, 'updating an issue') as RawIssue);
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.ensureLabels(labels);
    const response = await this.write(ROUTES.addLabels, { issue_number: issueNumber, labels });
    this.expect(response, 'labelling');
  }

  async createComment(issueNumber: number, body: string): Promise<CommentLike> {
    const response = await this.write(ROUTES.createComment, { issue_number: issueNumber, body });
    return toComment(this.expect(response, 'commenting') as RawComment);
  }

  async updateComment(commentId: number, body: string): Promise<CommentLike> {
    const response = await this.write(ROUTES.updateComment, { comment_id: commentId, body });
    return toComment(this.expect(response, 'updating a comment') as RawComment);
  }

  async headSha(branch: string): Promise<string> {
    const response = await this.read(ROUTES.ref, { branch });
    const data = this.expect(response, `reading ${branch}`) as { object?: { sha?: string } };
    const sha = data.object?.sha;
    if (!sha) throw new Error(`no commit sha for ${branch}`);
    return sha;
  }

  /** Returns false when the branch was already there, which is the normal state on a re-run. */
  async ensureBranch(branch: string, fromSha: string): Promise<boolean> {
    const response = await this.write(ROUTES.createRef, {
      ref: `refs/heads/${branch}`,
      sha: fromSha,
    });
    if (response.status === 422) return false;
    this.expect(response, `creating ${branch}`);
    return true;
  }

  async readFile(path: string, ref: string): Promise<FileContents> {
    const response = await this.read(ROUTES.readFile, { path, ref });
    const data = this.expect(response, `reading ${path}`) as {
      content?: string;
      encoding?: string;
      sha?: string;
    };
    if (data.encoding !== 'base64' || typeof data.content !== 'string' || !data.sha) {
      throw new Error(`${path} is not base64 content`);
    }
    return { text: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
  }

  async writeFile(input: {
    path: string;
    text: string;
    sha: string;
    branch: string;
    message: string;
  }): Promise<void> {
    const response = await this.write(ROUTES.writeFile, {
      path: input.path,
      message: input.message,
      content: Buffer.from(input.text, 'utf8').toString('base64'),
      sha: input.sha,
      branch: input.branch,
    });
    this.expect(response, `writing ${input.path}`);
  }

  async createPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<IssueLike> {
    const response = await this.write(ROUTES.createPull, input);
    return toIssue(this.expect(response, 'opening a pull request') as RawIssue);
  }
}

/**
 * The Octokit-backed transport. It turns an HTTP error into a status rather than an exception so
 * the actor can treat an expected 422 (the label is already there, the branch already exists) as
 * ordinary flow instead of a failure.
 */
export function octokitRequest(token: string): GitHubRequest {
  const octokit = new Octokit({ auth: token, userAgent: 'bumpwarden' });

  return async (route, params) => {
    try {
      const response = await octokit.request(route, params);
      return { status: response.status, data: response.data };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (typeof status !== 'number') throw error;
      return { status, data: (error as { response?: { data?: unknown } }).response?.data ?? null };
    }
  };
}
