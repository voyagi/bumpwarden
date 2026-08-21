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
  timeoutMs?: number;
  maxBytes?: number;
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

/**
 * A run is answered inside one HTTP request that Cloud Run will cut off, so no single read may sit
 * on the clock indefinitely. Node's own defaults are five minutes per phase, which four attempts
 * turn into twenty, well past any deadline this service has: a slow source has to become a
 * recorded missing source quickly rather than a run that never returns.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Nothing this service reads is legitimately large: the biggest is a registry packument for a
 * package with thousands of versions. The cap exists because the body arrives from a party that
 * chooses its size, and this container has 512 MB.
 */
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;

type BodyRead = { ok: true; text: string } | { ok: false; reason: 'too-large' | 'cut-short' };
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
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private calls = 0;
  private cacheHits = 0;
  private retries = 0;

  constructor(options: RunFetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.budget = options.budget ?? DEFAULT_BUDGET;
    this.userAgent = options.userAgent ?? 'bumpwarden';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
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

      if (response.ok) {
        const body = await this.readBounded(response);
        if (body.ok) return { ok: true, value: body.text, fromCache: false };
        if (body.reason === 'too-large') {
          return failure('malformed', response.status, `body over ${this.maxBytes} bytes: ${url}`);
        }
        // The headers arrived and the body did not. The status was a success, so this is not a
        // failure the retry ladder above knows about; it is still a source that could not be read.
        return failure('unavailable', response.status, `body did not arrive from ${url}`);
      }
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

  /**
   * Read the body a chunk at a time and stop at the cap rather than calling `.text()`, which
   * decides how much memory to take from a `content-length` the sender wrote. A sender who lies
   * about that header, or omits it, is exactly the case the cap is for.
   */
  private async readBounded(response: Response): Promise<BodyRead> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBytes)
      return { ok: false, reason: 'too-large' };

    const body = response.body;
    if (!body) return { ok: true, text: await response.text() };

    const decoder = new TextDecoder();
    const reader = body.getReader();
    let read = 0;
    let text = '';

    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;

        read += chunk.value.byteLength;
        if (read > this.maxBytes) return { ok: false, reason: 'too-large' };
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      // A body that stops arriving mid-stream aborts here, after the headers already said 200.
      // Every other failure in this class is returned rather than thrown, and so is this one.
      return { ok: false, reason: 'cut-short' };
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    return { ok: true, text: text + decoder.decode() };
  }

  private async send(url: string, headers: Record<string, string>): Promise<Response | null> {
    try {
      return await this.fetchImpl(url, {
        headers: { 'user-agent': this.userAgent, ...headers },
        // Without this the read inherits Node's own five minute phase timeouts, and four attempts
        // at five minutes outlive any request this run is answering.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return null;
    }
  }
}
