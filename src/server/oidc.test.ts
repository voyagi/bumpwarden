import { describe, expect, it, vi } from 'vitest';
import { authorizeRun, type IdTokenClaims, type RunAuthConfig } from './oidc.js';
import { createApp } from './app.js';

const INVOKER = 'bumpwarden-runner@demo.iam.gserviceaccount.com';

function config(
  overrides: Partial<RunAuthConfig> = {},
  claims: IdTokenClaims | null = null,
): RunAuthConfig {
  return {
    invokerEmail: INVOKER,
    audience: 'https://bumpwarden.example.run/run',
    verify: async () => claims,
    ...overrides,
  };
}

const VALID: IdTokenClaims = {
  email: INVOKER,
  email_verified: true,
  iss: 'https://accounts.google.com',
};

describe('authorizeRun', () => {
  it('accepts the configured invoker', async () => {
    const result = await authorizeRun(`Bearer token`, config({}, VALID));
    expect(result).toEqual({ ok: true, caller: INVOKER });
  });

  it('accepts a lowercase bearer scheme, which is legal', async () => {
    expect(await authorizeRun('bearer token', config({}, VALID))).toMatchObject({ ok: true });
  });

  it('refuses every call when no invoker is configured, rather than accepting any', async () => {
    const result = await authorizeRun('Bearer token', config({ invokerEmail: null }, VALID));
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  const rejected: Array<[string, string | undefined]> = [
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a token with no scheme', 'token'],
    ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['an empty bearer', 'Bearer '],
  ];

  it.each(rejected)('rejects %s with 401', async (_label, header) => {
    expect(await authorizeRun(header, config({}, VALID))).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a token that does not verify', async () => {
    expect(await authorizeRun('Bearer bad', config({}, null))).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('rejects a verifier that throws instead of letting the error escape', async () => {
    const verify = vi.fn(() => Promise.reject(new Error('bad signature')));
    expect(await authorizeRun('Bearer bad', config({ verify }))).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('rejects a valid token belonging to a different service account', async () => {
    const other = { ...VALID, email: 'someone-else@demo.iam.gserviceaccount.com' };
    expect(await authorizeRun('Bearer token', config({}, other))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('rejects a token with no email claim at all', async () => {
    expect(await authorizeRun('Bearer token', config({}, { email_verified: true }))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('rejects an unverified email', async () => {
    const unverified = { ...VALID, email_verified: false };
    expect(await authorizeRun('Bearer token', config({}, unverified))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('passes the configured audience to the verifier', async () => {
    const verify = vi.fn(async () => VALID);
    await authorizeRun('Bearer token', config({ verify }));
    expect(verify).toHaveBeenCalledWith('token', 'https://bumpwarden.example.run/run');
  });
});

describe('the run route', () => {
  it('rejects an unauthenticated caller', async () => {
    const app = createApp({ runAuth: config({}, VALID) });
    const res = await app.request('/run', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('accepts the scheduler token', async () => {
    const app = createApp({ runAuth: config({}, VALID) });
    const res = await app.request('/run', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, caller: INVOKER });
  });

  it('does not answer a GET on the run endpoint', async () => {
    const app = createApp({ runAuth: config({}, VALID) });
    expect((await app.request('/run')).status).toBe(404);
  });

  it('leaves the public dashboard open while the run endpoint is shut', async () => {
    const app = createApp({ runAuth: config({ invokerEmail: null }, VALID) });
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/run', { method: 'POST' })).status).toBe(503);
  });
});
