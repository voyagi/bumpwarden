import { serve } from '@hono/node-server';
import { env } from '../env.js';
import { createApp } from './app.js';
import { googleTokenVerifier } from './oidc.js';

// The entry point is the only place that reads the environment, so importing the app in a test or
// a script never triggers boot validation.
const app = createApp({
  runAuth: {
    invokerEmail: env.RUN_INVOKER_EMAIL ?? null,
    // Cloud Scheduler signs its token for the exact URL it calls, so that URL is the audience.
    audience: env.SERVICE_BASE_URL ? `${env.SERVICE_BASE_URL}/run` : null,
    verify: googleTokenVerifier(),
  },
});

serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
  console.log(`bumpwarden listening on http://${info.address}:${info.port}`);
});
