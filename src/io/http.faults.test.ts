import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RunFetcher } from './http.js';

/**
 * The unit tests above drive failure through a fake fetch, which proves the branch and not the
 * behaviour: a promise that never settles and a socket that never answers are different things,
 * and only one of them is what a slow dependency actually does to this process. These run against
 * a real server on a real port, so the fault is on the wire.
 *
 * Every source bumpwarden reads belongs to somebody else, and a run is answered inside one HTTP
 * request that Cloud Run will cut off. A source that hangs has to become a recorded missing
 * source in seconds rather than a run that never returns.
 */
const servers: Server[] = [];

async function serving(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/thing`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('a dependency that misbehaves on the wire', () => {
  it('gives up on a source that accepts the connection and never answers', async () => {
    const url = await serving(() => {
      // Deliberately no response: the connection is open and nothing is coming.
    });
    const fetcher = new RunFetcher({ sleep: async () => undefined, maxRetries: 0, timeoutMs: 300 });

    const started = Date.now();
    const result = await fetcher.getText(url);

    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives up on a source that sends headers and then stops mid-body', async () => {
    const url = await serving((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"versions":');
    });
    const fetcher = new RunFetcher({ sleep: async () => undefined, maxRetries: 0, timeoutMs: 300 });

    expect(await fetcher.getJson(url)).toMatchObject({ ok: false });
  });

  it('records a reset connection as unavailable rather than throwing through the run', async () => {
    const url = await serving((request) => {
      request.socket.destroy();
    });
    const fetcher = new RunFetcher({ sleep: async () => undefined, maxRetries: 1, timeoutMs: 500 });

    expect(await fetcher.getText(url)).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('stops a body that keeps arriving rather than taking whatever is sent', async () => {
    const url = await serving((_request, response) => {
      response.writeHead(200);
      // No content-length: the only thing bounding this read is the cap itself.
      const pump = setInterval(() => response.write('x'.repeat(64 * 1024)), 1);
      response.on('close', () => clearInterval(pump));
    });
    const fetcher = new RunFetcher({
      sleep: async () => undefined,
      maxRetries: 0,
      timeoutMs: 5_000,
      maxBytes: 256 * 1024,
    });

    expect(await fetcher.getText(url)).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('reads a healthy source over the same path, so the bounds cost nothing real', async () => {
    const url = await serving((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    const fetcher = new RunFetcher({ sleep: async () => undefined, timeoutMs: 5_000 });

    expect(await fetcher.getJson(url)).toMatchObject({ ok: true, value: { ok: true } });
  });
});
