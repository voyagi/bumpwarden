import { Hono, type Context, type Next } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { MemoryStore } from '../io/memory-store.js';
import type { BumpwardenStore } from '../io/store.js';
import { mountDashboard } from './dashboard.js';
import { authorizeRun, type RunAuthConfig } from './oidc.js';
import type { StartRun } from './start-run.js';

export const SERVICE_NAME = 'bumpwarden';

export type { StartRun, StartRunOptions } from './start-run.js';

export interface AppOptions {
  runAuth?: RunAuthConfig;
  startRun?: StartRun | null;
  store?: BumpwardenStore;
  now?: () => Date;
  baseUrl?: string | null;
}

/**
 * The app takes its configuration as an argument rather than reading the environment, so importing
 * it never validates anything. The entry point owns boot-time validation. The default here is the
 * shut one: no invoker, so /run answers 503 until something wires a real config in.
 */
function shutRunAuth(): RunAuthConfig {
  return { invokerEmail: null, audience: null, verify: async () => null };
}

/** Hashed names would let these be immutable; without them a week is the honest ceiling. */
const ASSET_CACHE = 'public, max-age=604800';
const STYLE_CACHE = 'public, max-age=3600';

/**
 * A dotfile under a static root is a file nobody chose to publish: an editor's leavings, a local
 * marker, a stray .env. Serving the folder must never mean serving those as well.
 */
async function refuseDotfiles(c: Context, next: Next): Promise<Response | undefined> {
  const hidden = new URL(c.req.url).pathname.split('/').some((part) => part.startsWith('.'));
  if (hidden) return c.notFound();
  await next();
  return undefined;
}

function mountAssets(app: Hono): void {
  app.use('/fonts/*', refuseDotfiles);
  app.use(
    '/fonts/*',
    serveStatic({ root: './public', onFound: (_p, c) => c.header('Cache-Control', ASSET_CACHE) }),
  );
  app.use(
    '/bumpwarden.css',
    serveStatic({ root: './public', onFound: (_p, c) => c.header('Cache-Control', STYLE_CACHE) }),
  );
  app.use(
    '/run-now.js',
    serveStatic({ root: './public', onFound: (_p, c) => c.header('Cache-Control', STYLE_CACHE) }),
  );
  app.use('/robots.txt', serveStatic({ root: './public' }));
}

export function createApp(options: AppOptions = {}): Hono {
  const instance = new Hono();
  const runAuth = options.runAuth ?? shutRunAuth();
  const startRun = options.startRun ?? null;

  instance.get('/healthz', (c) => c.json({ ok: true, service: SERVICE_NAME }));

  instance.post('/run', async (c) => {
    const decision = await authorizeRun(c.req.header('authorization'), runAuth);
    if (!decision.ok) {
      return c.json({ ok: false, error: decision.reason }, decision.status);
    }
    if (!startRun) {
      return c.json({ ok: false, error: 'the run pipeline is not configured' }, 503);
    }

    // The run is awaited rather than started and forgotten: Cloud Run stops giving a container CPU
    // once the response is sent, so anything left running after it would be frozen mid-request.
    const run = await startRun({ trigger: 'scheduled' });
    return c.json({
      ok: true,
      caller: decision.caller,
      runId: run.id,
      status: run.status,
      counts: run.counts,
      actionsTaken: run.actionsTaken,
      repositories: run.repositories.length,
    });
  });

  mountAssets(instance);
  mountDashboard(instance, {
    store: options.store ?? new MemoryStore(),
    now: options.now ?? (() => new Date()),
    startRun,
    baseUrl: options.baseUrl ?? null,
  });

  return instance;
}

export const app = createApp();
