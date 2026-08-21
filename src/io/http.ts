export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type FailureReason =
  'not-found' | 'rate-limited' | 'budget-exhausted' | 'unavailable' | 'malformed';

export type Outcome<T> =
  | { ok: true; value: T; fromCache: boolean }
  | { ok: false; reason: FailureReason; status: number | null; detail: string };

export interface RunFetcherOptions {
  fetchImpl?: FetchLike;
  /** Network calls allowed for the whole run. Cache hits do not count against it. */
  budget?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export interface FetcherStats {
  calls: number;
  cacheHits: number;
  retries: number;
  budget: number;
  budgetRemaining: number;
}

const DEFAULT_BUDGET = 300;
const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function failure(reason: FailureReason, status: number | null, detail: string): Outcome<never> {
  return { ok: false, reason, status, detail };
}

function backoffMs(attempt: number, response: Response | null): number {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * GitHub answers a secondary rate limit with 403 and an exhausted x-ratelimit-remaining, which is
 * indistinguishable from a permissions failure by status alone. Retrying a genuine 403 wastes the
 * run's budget, so the header decides.
 */
function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  return response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
}

function shouldRetry(response: Response): boolean {
  return RETRYABLE_STATUS.has(response.status) || isRateLimited(response);
}

/**
 * One instance per run. It exists so a run cannot silently cost an unbounded number of API calls,
 * and so the same manifest fetched by two dependencies is fetched once. Every failure is returned
 * rather than thrown: a source that cannot be read is a scored fact, not a crash.
 */
export class RunFetcher {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly cache = new Map<string, Outcome<string>>();
  private readonly budget: number;
  private calls = 0;
  private cacheHits = 0;
  private retries = 0;

  constructor(options: RunFetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.budget = options.budget ?? DEFAULT_BUDGET;
    this.userAgent = options.userAgent ?? 'bumpwarden';
  }

  stats(): FetcherStats {
    return {
      calls: this.calls,
      cacheHits: this.cacheHits,
      retries: this.retries,
      budget: this.budget,
      budgetRemaining: Math.max(0, this.budget - this.calls),
    };
  }

  async getText(url: string, headers: Record<string, string> = {}): Promise<Outcome<string>> {
    const key = `${url}|${JSON.stringify(headers)}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cacheHits += 1;
      return cached.ok ? { ...cached, fromCache: true } : cached;
    }

    const outcome = await this.request(url, headers);
    this.cache.set(key, outcome);
    return outcome;
  }

  async getJson<T>(url: string, headers: Record<string, string> = {}): Promise<Outcome<T>> {
    const text = await this.getText(url, { accept: 'application/json', ...headers });
    if (!text.ok) return text;

    try {
      return { ok: true, value: JSON.parse(text.value) as T, fromCache: text.fromCache };
    } catch (error) {
      return failure(
        'malformed',
        null,
        error instanceof Error ? error.message : 'unparseable JSON',
      );
    }
  }

  private async request(url: string, headers: Record<string, string>): Promise<Outcome<string>> {
    let lastStatus: number | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (this.calls >= this.budget) {
        return failure('budget-exhausted', null, `run budget of ${this.budget} calls is spent`);
      }

      this.calls += 1;
      const response = await this.send(url, headers);
      if (!response) {
        lastStatus = null;
        if (attempt === this.maxRetries) return failure('unavailable', null, 'network error');
        this.retries += 1;
        await this.sleep(backoffMs(attempt, null));
        continue;
      }

      if (response.ok) return { ok: true, value: await response.text(), fromCache: false };
      lastStatus = response.status;

      if (response.status === 404) return failure('not-found', 404, `no such resource: ${url}`);
      if (!shouldRetry(response)) {
        return failure('unavailable', response.status, `${response.status} for ${url}`);
      }
      if (attempt === this.maxRetries) {
        const reason = isRateLimited(response) ? 'rate-limited' : 'unavailable';
        return failure(reason, response.status, `gave up after ${attempt + 1} attempts on ${url}`);
      }

      this.retries += 1;
      await this.sleep(backoffMs(attempt, response));
    }

    return failure('unavailable', lastStatus, `exhausted retries for ${url}`);
  }

  private async send(url: string, headers: Record<string, string>): Promise<Response | null> {
    try {
      return await this.fetchImpl(url, { headers: { 'user-agent': this.userAgent, ...headers } });
    } catch {
      return null;
    }
  }
}
