import { describe, expect, it } from 'vitest';
import { BRIEF_MODEL } from '../core/stack.js';
import { probeModel } from './model-probe.js';

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

  it('tells a refused key, an outage and a timeout apart from a missing model', async () => {
    const refused = await probeModel({ apiKey: 'k', fetchImpl: answering(403, {}) });
    expect(refused).toMatchObject({ status: 'unreachable', reason: 'HTTP 403' });

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
