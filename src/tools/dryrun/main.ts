import { createAdkBriefEngine } from '../../agent/adk-engine.js';
import type { WatchedRepository } from '../../core/records.js';
import { FirestoreStore } from '../../io/firestore-store.js';
import { RunFetcher } from '../../io/http.js';
import { MemoryStore } from '../../io/memory-store.js';
import type { BumpwardenStore } from '../../io/store.js';
import { executeRun, type RunDependencies } from '../../orchestrator/run.js';

/**
 * The whole pipeline over a real repository with the GitHub actor withheld, so every bump is
 * fetched, scored, briefed and decided but nothing is written to anyone's repository. It is the
 * honest way to try bumpwarden against a project you do not own, and the way to see a full run
 * before granting a token that can push.
 */

const USAGE = `usage: npm run dryrun -- <owner>/<repo> [--max <n>] [--briefs <n>]

  --max      stop after this many dependencies, useful on a large manifest
  --briefs   ask Gemini for at most this many briefs, default is the published per-run budget

Reads GITHUB_TOKEN for authenticated reads, GEMINI_API_KEY for the briefs, and
GOOGLE_CLOUD_PROJECT (plus FIRESTORE_EMULATOR_HOST) when the run should persist to Firestore
instead of memory. It never opens an issue or a pull request.`;

const NAME = /^[\w.-]+\/[\w.-]+$/;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function numberFlag(argv: string[], flag: string): number | undefined {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  const value = Number(argv[at + 1]);
  if (!Number.isInteger(value) || value < 1) fail(`${flag} needs a whole number above zero.`);
  return value;
}

const argv = process.argv.slice(2);
const id = argv.find((argument) => !argument.startsWith('--')) ?? process.env.DEMO_REPO;
if (!id) fail('name the repository to run against.');
if (!NAME.test(id)) fail(`"${id}" is not an owner/repo pair.`);

const [owner = '', repo = ''] = id.split('/');
const repository: WatchedRepository = { id, owner, repo, ref: 'HEAD', demo: false };

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const store: BumpwardenStore = projectId
  ? new FirestoreStore({ projectId, emulated: Boolean(process.env.FIRESTORE_EMULATOR_HOST) })
  : new MemoryStore();
const apiKey = process.env.GEMINI_API_KEY;
const engine = apiKey ? createAdkBriefEngine({ apiKey }) : null;

// Kept so the summary can say what the run pulled over the network, not only how long it took.
const network: { fetcher: RunFetcher | null } = { fetcher: null };

const dependencies: RunDependencies = {
  store,
  now: () => new Date(),
  createFetcher: () => (network.fetcher = new RunFetcher()),
  // The one difference from a deployed run. Withholding the actor is what makes this a dry run:
  // act.ts records what it would have done and touches nothing.
  createActor: () => null,
  engine,
  githubToken: process.env.GITHUB_TOKEN ?? null,
  dashboardBaseUrl: process.env.SERVICE_BASE_URL ?? null,
};

await store.putWatchedRepository(repository);

console.log(`dry run over ${id}`);
console.log(`  store  ${projectId ? `firestore (${projectId})` : 'memory'}`);
console.log(`  briefs ${apiKey ? 'gemini' : 'disabled, no GEMINI_API_KEY'}`);
console.log(`  reads  ${process.env.GITHUB_TOKEN ? 'authenticated' : 'anonymous'}\n`);

const started = Date.now();
const run = await executeRun(dependencies, {
  trigger: 'manual',
  repositoryId: id,
  maxDependencies: numberFlag(argv, '--max'),
  briefBudget: numberFlag(argv, '--briefs'),
});

const bumps = await store.listBumps({ repositoryId: id, limit: 200 });
bumps.sort((left, right) => right.score.total - left.score.total);

for (const bump of bumps) {
  const move = `${bump.dependency} ${bump.currentVersion} -> ${bump.candidateVersion}`;
  const action = bump.action;
  console.log(`${String(bump.score.total).padStart(3)} ${bump.score.band.padEnd(5)} ${move}`);
  console.log(
    action ? `    ${action.ruleId} ${action.kind}: ${action.detail}` : '    no action recorded',
  );
  console.log(`    brief ${bump.brief.status}${bump.brief.reason ? `: ${bump.brief.reason}` : ''}`);
  if (bump.brief.content) {
    console.log(`    "${bump.brief.content.headline}"`);
    for (const claim of bump.brief.content.breaksHere) {
      console.log(
        `      ${claim.path}:${claim.line} ${claim.verified ? 'verified' : 'unverified'}`,
      );
    }
  }
}

const considered = run.repositories.reduce((sum, r) => sum + r.dependenciesConsidered, 0);
const gaps = run.repositories.flatMap((result) => result.missing);
if (gaps.length > 0) {
  console.log(`\nsources recorded as missing (${gaps.length}):`);
  for (const gap of gaps) console.log(`    ${gap.what}: ${gap.why}`);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n${run.id}: ${considered} dependencies read, ${bumps.length} bumps in ${seconds}s, ` +
    `${run.counts.red} red, ${run.counts.amber} amber, ${run.counts.green} green, ` +
    `${run.actionsTaken} actions taken (a dry run takes none).`,
);

const reads = network.fetcher?.stats();
if (reads) {
  const megabytes = (reads.bytes / 1_048_576).toFixed(1);
  console.log(`${reads.calls} network calls, ${reads.cacheHits} cached, ${megabytes} MB read.`);
}

// A paced run is slower on purpose, and a reader who is not told that reads it as a slow run.
const paced = engine?.pacer.waited() ?? 0;
if (paced > 0) {
  console.log(`${(paced / 1000).toFixed(1)}s of that was waiting for the model's rate limit.`);
}
