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

/**
 * A dashboard that publishes third-party text (release notes, an agent's reading of them, a
 * GitHub issue title) is a page a stranger writes part of. These headers are what stops the
 * browser acting on that text if it ever arrives as markup rather than as content.
 */
describe('what every response carries', () => {
  it('refuses everything the pages do not need, and allows exactly what they do', async () => {
    const policy = (await app.request('/')).headers.get('content-security-policy') ?? '';
    const directives = new Map(
      policy.split('; ').map((directive) => {
        const [name, ...value] = directive.split(' ');
        return [name ?? '', value.join(' ')];
      }),
    );

    expect(directives.get('default-src')).toBe("'none'");
    // No 'unsafe-inline' here: a string that reached the page as markup still cannot run.
    expect(directives.get('script-src')).toBe("'self'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(directives.get('form-action')).toBe("'self'");
    // The score marks carry their width and colour as style attributes, so this one is allowed.
    expect(directives.get('style-src')).toBe("'self' 'unsafe-inline'");
  });

  it('names the type it means, refuses a frame, and does not leak the path in a referrer', async () => {
    const headers = (await app.request('/')).headers;
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('strict-transport-security')).toContain('max-age=31536000');
  });

  /**
   * The stylesheet and the run script ship under names that never change, so their cache lifetime
   * is exactly how long a returning reader keeps the previous deploy. A minute is the compromise;
   * an hour was what hid a stylesheet change from a browser that had been on the page before. The
   * fonts and the favicon do not change with the code and keep the week.
   */
  it('lets a deploy reach a returning reader within a minute', async () => {
    for (const path of ['/bumpwarden.css', '/run-now.js']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('public, max-age=60');
    }

    for (const path of ['/favicon.svg', '/fonts/mona-sans-latin.woff2']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe('public, max-age=604800');
    }
  });

  it('carries them on the api answers and the assets too, not only on the pages', async () => {
    for (const path of ['/healthz', '/sitemap.xml', '/robots.txt', '/no-such-page']) {
      const headers = (await app.request(path)).headers;
      expect(headers.get('content-security-policy'), path).toContain("default-src 'none'");
      expect(headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });
});
