import { Hono, type Context, type Next } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { MemoryStore } from '../io/memory-store.js';
import type { BumpwardenStore } from '../io/store.js';
import { mountDashboard } from './dashboard.js';
import { authorizeRun, type RunAuthConfig } from './oidc.js';
import { isRunInProgress, type StartRun } from './start-run.js';

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

/**
 * The two files that change with the code, under names that do not. An hour here meant a browser
 * that had visited before kept serving the previous stylesheet against the new markup for an hour
 * after a deploy, which is a page that looks broken for a reason nothing on it explains. A minute
 * still spares a reader the 22 KB on every click and puts a redeploy on screen while the person who
 * ran it is still looking.
 */
const CODE_CACHE = 'public, max-age=60';

/**
 * The name a guard reads has to be the name the file resolver opens. hono routes on a path it has
 * already put through decodeURI, and serveStatic decodes that one more time before the read, so
 * `%2Ename` reads as an ordinary word in the URL and lands on disk as `.name`. Decoding once here
 * is what puts the two on the same value; a sequence that will not decode at all is refused rather
 * than half-read into a name nobody asked for.
 */
function isHidden(path: string): boolean {
  let name: string;
  try {
    name = decodeURIComponent(path);
  } catch {
    return true;
  }
  return name.split('/').some((part) => part.startsWith('.'));
}

/**
 * A dotfile under a static root is a file nobody chose to publish: an editor's leavings, a local
 * marker, a stray .env. Serving the folder must never mean serving those as well.
 */
async function refuseDotfiles(c: Context, next: Next): Promise<Response | undefined> {
  if (isHidden(c.req.path)) return c.notFound();
  await next();
  return undefined;
}

/**
 * Set on the way out rather than through serveStatic's own `onFound`, which answers the file but
 * never runs the callback outside a node server, so the lifetime of a cached asset was a thing no
 * test could see. A miss is left alone: nothing should cache a 404 for a week.
 */
function caching(value: string) {
  return async (c: Context, next: Next): Promise<void> => {
    await next();
    if (c.res.ok) c.res.headers.set('Cache-Control', value);
  };
}

function mountAssets(app: Hono): void {
  app.use('/fonts/*', refuseDotfiles, caching(ASSET_CACHE), serveStatic({ root: './public' }));
  app.use(
    '/bumpwarden.css',
    refuseDotfiles,
    caching(CODE_CACHE),
    serveStatic({ root: './public' }),
  );
  app.use('/run-now.js', refuseDotfiles, caching(CODE_CACHE), serveStatic({ root: './public' }));
  app.use('/favicon.svg', refuseDotfiles, caching(ASSET_CACHE), serveStatic({ root: './public' }));
}

/**
 * Nothing on any page loads from anywhere but this service: both typefaces are self-hosted, the
 * only script is `/run-now.js`, and the architecture diagram is inline SVG. So the policy can be
 * default-deny rather than a list of allowances, and `script-src 'self'` with no inline escape
 * means a string that reached a page as markup still cannot run.
 *
 * `style-src` is the one exception: the score marks carry their width and colour as style
 * attributes, since a bar whose length is the reading cannot come from a static sheet.
 */
const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'"],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  formAction: ["'self'"],
  baseUri: ["'none'"],
  frameAncestors: ["'none'"],
};

export function createApp(options: AppOptions = {}): Hono {
  const instance = new Hono();
  const runAuth = options.runAuth ?? shutRunAuth();
  const startRun = options.startRun ?? null;

  instance.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: CONTENT_SECURITY_POLICY,
      // A public read-only dashboard has no cross-origin isolation to buy, and both of these break
      // an ordinary browser tab reading it rather than protecting anyone.
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      referrerPolicy: 'strict-origin-when-cross-origin',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      xFrameOptions: 'DENY',
    }),
  );

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
    let run;
    try {
      run = await startRun({ trigger: 'scheduled' });
    } catch (error) {
      if (!isRunInProgress(error)) throw error;
      // Cloud Scheduler retries a 5xx and would pile more runs behind the one already going.
      return c.json({ ok: false, error: 'a run is already going' }, 409);
    }

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
