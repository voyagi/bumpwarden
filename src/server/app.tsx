import { Hono } from 'hono';
import type { RunRecord, Trigger } from '../core/records.js';
import { authorizeRun, type RunAuthConfig } from './oidc.js';

export const SERVICE_NAME = 'bumpwarden';

export interface StartRunOptions {
  trigger: Trigger;
  repositoryId?: string;
}

export type StartRun = (options: StartRunOptions) => Promise<RunRecord>;

export interface AppOptions {
  runAuth?: RunAuthConfig;
  startRun?: StartRun | null;
}

/**
 * The app takes its configuration as an argument rather than reading the environment, so importing
 * it never validates anything. The entry point owns boot-time validation. The default here is the
 * shut one: no invoker, so /run answers 503 until something wires a real config in.
 */
function shutRunAuth(): RunAuthConfig {
  return { invokerEmail: null, audience: null, verify: async () => null };
}

export function createApp(options: AppOptions = {}): Hono {
  const instance = new Hono();
  const runAuth = options.runAuth ?? shutRunAuth();

  instance.get('/healthz', (c) => c.json({ ok: true, service: SERVICE_NAME }));

  instance.post('/run', async (c) => {
    const decision = await authorizeRun(c.req.header('authorization'), runAuth);
    if (!decision.ok) {
      return c.json({ ok: false, error: decision.reason }, decision.status);
    }
    if (!options.startRun) {
      return c.json({ ok: false, error: 'the run pipeline is not configured' }, 503);
    }

    // The run is awaited rather than started and forgotten: Cloud Run stops giving a container CPU
    // once the response is sent, so anything left running after it would be frozen mid-request.
    const run = await options.startRun({ trigger: 'scheduled' });
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

  instance.get('/', (c) =>
    c.html(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>bumpwarden</title>
        </head>
        <body>
          <main>
            <h1>bumpwarden</h1>
            <p>
              A background agent that watches the releases of a project's dependencies, scores each
              pending bump's break risk with a published rubric, explains what would break in your
              code, and acts on GitHub. It never merges anything.
            </p>
          </main>
        </body>
      </html>,
    ),
  );

  return instance;
}

export const app = createApp();
