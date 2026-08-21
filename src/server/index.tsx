import { serve } from '@hono/node-server';
import { createAdkBriefEngine } from '../agent/adk-engine.js';
import type { WatchedRepository } from '../core/records.js';
import { env } from '../env.js';
import { FirestoreStore } from '../io/firestore-store.js';
import { RepositoryActor, octokitRequest } from '../io/github-actor.js';
import { RunFetcher } from '../io/http.js';
import { MemoryStore } from '../io/memory-store.js';
import type { BumpwardenStore } from '../io/store.js';
import { executeRun, type RunDependencies } from '../orchestrator/run.js';
import { createApp } from './app.js';
import { googleTokenVerifier } from './oidc.js';

// The entry point is the only place that reads the environment, so importing the app in a test or
// a script never triggers boot validation.

function buildStore(): BumpwardenStore {
  if (!env.GOOGLE_CLOUD_PROJECT) return new MemoryStore();
  return new FirestoreStore({ projectId: env.GOOGLE_CLOUD_PROJECT });
}

function actorFor(repository: WatchedRepository): RepositoryActor | null {
  if (!env.GITHUB_TOKEN) return null;
  return new RepositoryActor(octokitRequest(env.GITHUB_TOKEN), {
    owner: repository.owner,
    repo: repository.repo,
  });
}

const store = buildStore();

const dependencies: RunDependencies = {
  store,
  now: () => new Date(),
  createFetcher: () => new RunFetcher(),
  createActor: actorFor,
  engine: env.GEMINI_API_KEY ? createAdkBriefEngine({ apiKey: env.GEMINI_API_KEY }) : null,
  githubToken: env.GITHUB_TOKEN ?? null,
  dashboardBaseUrl: env.SERVICE_BASE_URL ?? null,
};

/**
 * The watch list lives in the store, and the demo project is the one entry an operator should not
 * have to add by hand: the hosted instance is judged on it, so a fresh deployment has to arrive
 * already watching it.
 */
async function seedDemoRepository(): Promise<void> {
  if (!env.DEMO_REPO) return;

  const [owner, repo] = env.DEMO_REPO.split('/');
  if (!owner || !repo) return;

  await store.putWatchedRepository({
    id: `${owner}/${repo}`,
    owner,
    repo,
    ref: 'HEAD',
    demo: true,
  });
}

const app = createApp({
  runAuth: {
    invokerEmail: env.RUN_INVOKER_EMAIL ?? null,
    // Cloud Scheduler signs its token for the exact URL it calls, so that URL is the audience.
    audience: env.SERVICE_BASE_URL ? `${env.SERVICE_BASE_URL}/run` : null,
    verify: googleTokenVerifier(),
  },
  startRun: (options) => executeRun(dependencies, options),
  store,
  baseUrl: env.SERVICE_BASE_URL ?? null,
});

await seedDemoRepository();

serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
  console.log(`bumpwarden listening on http://${info.address}:${info.port}`);
});
