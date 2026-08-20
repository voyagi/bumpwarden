import { describe, expect, it } from 'vitest';
import { SERVICE_NAME, app } from './app.js';

describe('server', () => {
  it('answers the health probe with the service name', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: SERVICE_NAME });
  });

  it('serves the root page as HTML', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('bumpwarden');
  });

  it('returns 404 for an unknown route', async () => {
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
  });
});
