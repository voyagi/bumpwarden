import { serve } from '@hono/node-server';
import { createAdkBriefEngine } from '../agent/adk-engine.js';
import { probeModel } from '../agent/model-probe.js';
import type { WatchedRepository } from '../core/records.js';
import { env } from '../env.js';
import { FirestoreStore } from '../io/firestore-store.js';
import { RepositoryActor, octokitRequest } from '../io/github-actor.js';
import { RunFetcher } from '../io/http.js';
import { log } from '../io/log.js';
import { MemoryStore } from '../io/memory-store.js';
import type { BumpwardenStore } from '../io/store.js';
import { executeRun, type RunDependencies } from '../orchestrator/run.js';
import { createApp } from './app.js';
import { bindHostname } from './bind.js';
import { googleTokenVerifier } from './oidc.js';

// The entry point is the only place that reads the environment, so importing the app in a test or
// a script never triggers boot validation.

function buildStore(): BumpwardenStore {
  if (!env.GOOGLE_CLOUD_PROJECT) return new MemoryStore();
  return new FirestoreStore({
    projectId: env.GOOGLE_CLOUD_PROJECT,
    emulated: Boolean(env.FIRESTORE_EMULATOR_HOST),
  });
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
  logger: log,
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

/**
 * The model id is an alias Google can move or retire. Boot asks whether it still resolves and
 * logs the answer without spending a model request; a missing id is an error in the log, not a
 * crash, because the dashboard and the scores stand on their own and a run records the refusal.
 */
async function reportModel(): Promise<void> {
  if (!env.GEMINI_API_KEY) return;
  const probe = await probeModel({ apiKey: env.GEMINI_API_KEY });
  if (probe.status === 'listed') {
    log.info('model listed', {
      model: probe.model,
      version: probe.version,
      generates: probe.generates,
    });
  } else if (probe.status === 'missing') {
    log.error('model missing: the configured id no longer resolves', { model: probe.model });
  } else {
    log.warn('model not checked', { model: probe.model, reason: probe.reason });
  }
}

await seedDemoRepository();
await reportModel();

serve({ fetch: app.fetch, hostname: bindHostname(env.HOST), port: env.PORT }, (info) => {
  log.info('listening', {
    port: info.port,
    host: env.HOST,
    store: env.GOOGLE_CLOUD_PROJECT ? 'firestore' : 'memory',
    brief: env.GEMINI_API_KEY ? 'gemini' : 'disabled',
    github: env.GITHUB_TOKEN ? 'authenticated' : 'read-only',
    runEndpoint: env.RUN_INVOKER_EMAIL && env.SERVICE_BASE_URL ? 'gated' : 'closed',
    // Without a configured base url the canonical link, the sitemap and robots.txt follow the
    // Host header of whoever asked, which is a stranger on a public deployment.
    canonical: env.SERVICE_BASE_URL ? 'configured' : 'follows the request host',
  });
});
