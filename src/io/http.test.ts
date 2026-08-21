import { describe, expect, it, vi } from 'vitest';
import { RunFetcher } from './http.js';
import { scriptedFetch, text, type Step } from '../testkit/scripted-fetch.js';

function response(status: number, body = '', headers: Record<string, string> = {}): () => Response {
  return text(body, status, headers);
}

function scripted(steps: Step[]) {
  return scriptedFetch(steps);
}

const noSleep = () => Promise.resolve();

describe('RunFetcher', () => {
  it('returns the body on success', async () => {
    const { impl } = scripted([response(200, 'hello')]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep: noSleep });

    const result = await fetcher.getText('https://example.test/a');

    expect(result).toEqual({ ok: true, value: 'hello', fromCache: false });
    expect(fetcher.stats().calls).toBe(1);
  });

  it('serves a repeat of the same url from the per-run cache', async () => {
    const { impl, urls } = scripted([response(200, 'hello')]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep: noSleep });

    await fetcher.getText('https://example.test/a');
    const second = await fetcher.getText('https://example.test/a');

    expect(second).toEqual({ ok: true, value: 'hello', fromCache: true });
    expect(urls).toHaveLength(1);
    expect(fetcher.stats()).toMatchObject({ calls: 1, cacheHits: 1 });
  });

  it('caches a failure too, so a dead source is not paid for twice', async () => {
    const { impl, urls } = scripted([response(404)]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep: noSleep });

    await fetcher.getText('https://example.test/gone');
    const second = await fetcher.getText('https://example.test/gone');

    expect(second).toMatchObject({ ok: false, reason: 'not-found' });
    expect(urls).toHaveLength(1);
  });

  it('does not retry a 404', async () => {
    const { impl, urls } = scripted([response(404)]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep: noSleep });

    const result = await fetcher.getText('https://example.test/gone');

    expect(result).toMatchObject({ ok: false, reason: 'not-found', status: 404 });
    expect(urls).toHaveLength(1);
  });

  it('retries a 429 and succeeds', async () => {
    const { impl, urls } = scripted([
      response(429, '', { 'retry-after': '0' }),
      response(200, 'ok'),
    ]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep: noSleep });

    const result = await fetcher.getText('https://example.test/slow');

    expect(result).toMatchObject({ ok: true, value: 'ok' });
    expect(urls).toHaveLength(2);
    expect(fetcher.stats().retries).toBe(1);
  });

  it('waits for the retry-after header rather than its own backoff', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { impl } = scripted([response(429, '', { 'retry-after': '2' }), response(200, 'ok')]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep });

    await fetcher.getText('https://example.test/slow');

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('treats a 403 with no rate-limit budget left as rate limiting, and a plain 403 as final', async () => {
    const limited = new RunFetcher({
      fetchImpl: scripted([response(403, '', { 'x-ratelimit-remaining': '0' })]).impl,
      sleep: noSleep,
      maxRetries: 1,
    });
    const forbidden = new RunFetcher({
      fetchImpl: scripted([response(403)]).impl,
      sleep: noSleep,
      maxRetries: 1,
    });

    expect(await limited.getText('https://example.test/x')).toMatchObject({
      reason: 'rate-limited',
    });
    expect(await forbidden.getText('https://example.test/y')).toMatchObject({
      reason: 'unavailable',
      status: 403,
    });
    expect(forbidden.stats().calls).toBe(1);
  });

  it('recovers from a thrown network error', async () => {
    const { impl } = scripted(['throw', response(200, 'ok')]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep: noSleep });

    expect(await fetcher.getText('https://example.test/flaky')).toMatchObject({ ok: true });
  });

  it('stops at the run budget instead of calling again', async () => {
    const { impl, urls } = scripted([response(200, 'ok')]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep: noSleep, budget: 2 });

    await fetcher.getText('https://example.test/1');
    await fetcher.getText('https://example.test/2');
    const third = await fetcher.getText('https://example.test/3');

    expect(third).toMatchObject({ ok: false, reason: 'budget-exhausted' });
    expect(urls).toHaveLength(2);
    expect(fetcher.stats().budgetRemaining).toBe(0);
  });

  it('counts retries against the budget, because they are real calls', async () => {
    const { impl, urls } = scripted([response(500)]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep: noSleep, budget: 2, maxRetries: 5 });

    const result = await fetcher.getText('https://example.test/broken');

    expect(urls).toHaveLength(2);
    expect(result).toMatchObject({ ok: false, reason: 'budget-exhausted' });
  });

  it('reports malformed json as malformed rather than crashing the run', async () => {
    const { impl } = scripted([response(200, '{ not json')]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep: noSleep });

    expect(await fetcher.getJson('https://example.test/j')).toMatchObject({ reason: 'malformed' });
  });

  it('parses json on the happy path', async () => {
    const { impl } = scripted([response(200, '{"a":1}')]);
    const fetcher = new RunFetcher({ fetchImpl: impl, sleep: noSleep });

    expect(await fetcher.getJson<{ a: number }>('https://example.test/j')).toMatchObject({
      ok: true,
      value: { a: 1 },
    });
  });
});
