import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BRIEF_MODEL } from '../core/stack.js';
import { MODEL_LOG, probeModel } from './model-probe.js';

function answering(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

describe('the model probe', () => {
  it('asks for the exact configured id with the key in a header, never in the url', async () => {
    let seenUrl = '';
    let seenKey: string | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenKey = new Headers(init?.headers).get('x-goog-api-key');
      return new Response(JSON.stringify({ version: '001' }), { status: 200 });
    };

    await probeModel({ apiKey: 'k-test', fetchImpl });

    expect(seenUrl).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${BRIEF_MODEL}`);
    expect(seenUrl).not.toContain('k-test');
    expect(seenKey).toBe('k-test');
  });

  it('takes the API\'s own "models/" prefix off the path instead of encoding the slash', async () => {
    let seenUrl = '';
    const probe = await probeModel({
      apiKey: 'k',
      model: `models/${BRIEF_MODEL}`,
      fetchImpl: async (input) => {
        seenUrl = String(input);
        return new Response(JSON.stringify({ version: '3.5' }), { status: 200 });
      },
    });

    expect(seenUrl).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${BRIEF_MODEL}`);
    expect(seenUrl).not.toContain('%2F');
    // The configured id is what the operator set and what the log has to name back to them.
    expect(probe.model).toBe(`models/${BRIEF_MODEL}`);
    expect(probe.status).toBe('listed');
  });

  it('reports the version the alias resolves to and whether it generates', async () => {
    const probe = await probeModel({
      apiKey: 'k',
      fetchImpl: answering(200, {
        name: `models/${BRIEF_MODEL}`,
        version: '3.5',
        supportedGenerationMethods: ['generateContent', 'countTokens'],
      }),
    });
    expect(probe).toEqual({
      status: 'listed',
      model: BRIEF_MODEL,
      version: '3.5',
      generates: true,
    });
  });

  it('says a retired id is missing, which is the case the probe exists for', async () => {
    const probe = await probeModel({ apiKey: 'k', fetchImpl: answering(404, { error: {} }) });
    expect(probe).toEqual({ status: 'missing', model: BRIEF_MODEL });
  });

  /**
   * A rejected key and a bad gateway are the same HTTP failure to a status check and opposite
   * things to an operator: one is answered by rotating a secret, the other by waiting. Boot logs
   * the first as an error precisely because nothing retries its way out of it.
   */
  it('calls a rejected credential refused, and keeps every other bad status unreachable', async () => {
    for (const status of [401, 403]) {
      const refused = await probeModel({ apiKey: 'k', fetchImpl: answering(status, {}) });
      expect(refused).toEqual({ status: 'refused', model: BRIEF_MODEL, reason: `HTTP ${status}` });
    }

    // Copied from a live refusal rather than imagined: this is the answer an invalid key really
    // gets, and reading its status alone would file it under "the API is having a moment".
    const invalidKey = await probeModel({
      apiKey: 'k',
      fetchImpl: answering(400, {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
          ],
        },
      }),
    });
    expect(invalidKey).toEqual({ status: 'refused', model: BRIEF_MODEL, reason: 'HTTP 400' });

    // A 400 naming no credential reason is this client's own bad request, and sending the operator
    // to rotate a working key over it would be worse than saying nothing.
    for (const status of [400, 429, 500, 503]) {
      const other = await probeModel({ apiKey: 'k', fetchImpl: answering(status, {}) });
      expect(other).toEqual({
        status: 'unreachable',
        model: BRIEF_MODEL,
        reason: `HTTP ${status}`,
      });
    }
  });

  it('tells an outage and a timeout apart from a missing model', async () => {
    const down = await probeModel({
      apiKey: 'k',
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(down).toMatchObject({ status: 'unreachable', reason: 'ECONNRESET' });

    const slow = await probeModel({
      apiKey: 'k',
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    expect(slow).toMatchObject({ status: 'unreachable', reason: 'timed out' });
  });

  /**
   * The fake above throws a plain error with the code as its message, which is a shape Node's
   * `fetch` never produces: it reports every network failure as the same `TypeError: fetch failed`
   * and hides the real one on `cause`. So this one takes the error from the runtime instead of
   * assuming it, by connecting to a loopback port nothing listens on, and hands that exact object
   * to the probe. Without the cause the operator's log would name only "fetch failed".
   */
  it('names the network error underneath, not just the one fetch reports', async () => {
    const thrown: unknown = await fetch('http://127.0.0.1:1/').then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('fetch failed');

    const probe = await probeModel({ apiKey: 'k', fetchImpl: () => Promise.reject(thrown) });

    expect(probe.status).toBe('unreachable');
    // Platform-independent on purpose: the code itself differs by operating system, but a cause
    // having been unwrapped at all is what this pins.
    expect(probe).toMatchObject({ reason: expect.stringMatching(/^fetch failed: \S/) });
    // Longer than the default: loopback normally refuses at once, but a host that drops instead of
    // refusing takes fetch's own connect timeout, and that has to surface as this assertion rather
    // than as an unexplained "test timed out".
  }, 20_000);

  /**
   * Node reports a host with several addresses as an AggregateError whose own message is empty and
   * whose code lives on the attempts inside it. Reading the wrapper alone gives the operator the
   * word "fetch failed" and nothing else.
   */
  it('digs the code out of an aggregate error carrying no message of its own', async () => {
    const attempt = Object.assign(new Error(''), { code: 'ENOTFOUND' });
    const thrown = new TypeError('fetch failed', { cause: new AggregateError([attempt], '') });

    const probe = await probeModel({ apiKey: 'k', fetchImpl: () => Promise.reject(thrown) });

    expect(probe).toMatchObject({ status: 'unreachable', reason: 'fetch failed: ENOTFOUND' });
  });

  it('stops instead of recursing when an aggregate error contains itself', async () => {
    const looping = new AggregateError([], '');
    looping.errors.push(looping);
    const thrown = new TypeError('fetch failed', { cause: looping });

    const probe = await probeModel({ apiKey: 'k', fetchImpl: () => Promise.reject(thrown) });

    expect(probe).toMatchObject({ status: 'unreachable' });
    expect(probe).toHaveProperty('reason', 'fetch failed: AggregateError');
  });

  /**
   * The reason is read out of the body, so a body that cannot be read has to fall somewhere. It
   * falls to unreachable: a warning that says the API could not be understood is cheaper to be
   * wrong about than an error sending an operator to rotate a key that was working.
   */
  it('does not call a 400 a refusal when its body cannot be read', async () => {
    const answer = new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }), {
      status: 400,
    });
    await answer.text();

    const probe = await probeModel({ apiKey: 'k', fetchImpl: async () => answer });

    expect(probe).toEqual({ status: 'unreachable', model: BRIEF_MODEL, reason: 'HTTP 400' });
  });

  /**
   * Every other exit answers rather than throws, and these two are how that promise gets broken
   * without anyone noticing: a body that is not JSON, and a body that is legal JSON but not an
   * object. Reading a field off `null` throws, and a probe whose whole point is to keep a bad
   * answer from ending the boot must not become the thing that ends it.
   */
  it('answers rather than throws when the body is not JSON at all', async () => {
    const probe = await probeModel({
      apiKey: 'k',
      fetchImpl: async () => new Response('<html>a captive portal</html>', { status: 200 }),
    });

    expect(probe.status).toBe('unreachable');
    expect(probe).toMatchObject({ reason: expect.stringContaining('unreadable body:') });
  });

  it('answers rather than throws when the body is legal JSON but not an object', async () => {
    for (const shape of ['null', '"a string"', '42', '[]']) {
      const probe = await probeModel({
        apiKey: 'k',
        fetchImpl: async () =>
          new Response(shape, { status: 200, headers: { 'content-type': 'application/json' } }),
      });

      expect(probe).toEqual({
        status: 'listed',
        model: BRIEF_MODEL,
        version: 'unknown',
        generates: false,
      });
    }
  });

  it('does not read a listing with no version as an answer about the model', async () => {
    const probe = await probeModel({ apiKey: 'k', fetchImpl: answering(200, { name: 'x' }) });
    expect(probe).toEqual({
      status: 'listed',
      model: BRIEF_MODEL,
      version: 'unknown',
      generates: false,
    });
  });
});

/**
 * Two documents explain these four lines to whoever is reading a log at three in the morning, and
 * both were written by hand in another file. Rewording a message is the easy half; a document still
 * naming the old one is a map that has quietly stopped matching the place it describes, and nothing
 * fails when it happens.
 */
describe('what boot says about the model', () => {
  it('is explained, phrase for phrase, where an operator goes looking', async () => {
    const [runbook, decision] = await Promise.all([
      readFile('docs/RUNBOOK.md', 'utf8'),
      readFile('docs/adr/0001-stack.md', 'utf8'),
    ]);

    // The decision record says what each of the four means.
    for (const phrase of Object.values(MODEL_LOG)) {
      expect(decision).toContain(phrase);
    }

    // The runbook says what to do, so it carries the three that ask something of the reader. A
    // listed model asks nothing, which is why it is the one that belongs only in the decision.
    for (const phrase of [MODEL_LOG.missing, MODEL_LOG.refused, MODEL_LOG.unreachable]) {
      expect(runbook).toContain(phrase);
    }
    expect(runbook).not.toContain(MODEL_LOG.listed);
  });
});
