import { env } from '../env.js';
import { serve } from '@hono/node-server';
import { app } from './app.js';

serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
  console.log(`bumpwarden listening on http://${info.address}:${info.port}`);
});
