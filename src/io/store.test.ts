import { Firestore } from '@google-cloud/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { unavailableBrief, type BriefRecord } from '../core/brief.js';
import type { BumpRecord } from '../core/records.js';
import {
  DEMO,
  NOW,
  actionRecord,
  bumpRecord,
  candidateBump,
  readyBrief,
  runRecord,
  scoreOf,
  summaryOf,
} from '../testkit/fixtures.js';
import { FirestoreStore } from './firestore-store.js';
import { MemoryStore } from './memory-store.js';
import type { BumpwardenStore } from './store.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
/** The `demo-` prefix is Firebase's marker for a project with no live resources behind it. */
const EMULATOR_PROJECT = 'demo-bumpwarden';

function greenBump(): BumpRecord {
  const green = candidateBump({
    dependency: 'hono',
    candidateVersion: '4.14.0',
    usage: 'unused',
    usageSites: [],
    release: { notes: 'Routine maintenance.', notesSource: 'release', commitSubjects: [] },
  });
  return bumpRecord({
    key: 'demo/app#hono@4.14.0',
    dependency: 'hono',
    candidateVersion: '4.14.0',
    score: scoreOf(green),
  });
}

/**
 * One contract, two implementations. The dashboard is built against the interface, so the only way
 * to know the Firestore one behaves like the one every test uses is to run the same expectations
 * over both.
 */
function storeContract(name: string, create: () => Promise<BumpwardenStore>): void {
  describe(name, () => {
    let store: BumpwardenStore;

    beforeEach(async () => {
      store = await create();
      await store.putWatchedRepository(DEMO);
    });

    it('lists the repositories it was given', async () => {
      expect(await store.listWatchedRepositories()).toEqual([DEMO]);
    });

    it('gives a newly watched repository a complete, zeroed summary', async () => {
      const [summary] = await store.listProjectSummaries();
      expect(summary).toMatchObject({
        repository: DEMO,
        lastRunId: null,
        counts: { green: 0, amber: 0, red: 0 },
        actions: 0,
      });
    });

    it('keeps the counts a run wrote when the repository is registered again', async () => {
      await store.putProjectSummary({
        repository: DEMO,
        lastRunId: 'run-1',
        lastRunAt: NOW.toISOString(),
        lastRunStatus: 'finished',
        counts: { green: 2, amber: 0, red: 1 },
        actions: 3,
        worstScore: 74,
      });
      await store.putWatchedRepository(DEMO);

      const [summary] = await store.listProjectSummaries();
      expect(summary?.counts).toEqual({ green: 2, amber: 0, red: 1 });
      expect(summary?.lastRunId).toBe('run-1');
    });

    it('round trips a run, including its per-repository results', async () => {
      await store.saveRun(runRecord());
      const loaded = await store.getRun(runRecord().id);

      expect(loaded).toEqual(runRecord());
      expect(loaded?.repositories[0]?.missing[0]?.what).toBe('lockfile');
    });

    it('overwrites a run rather than duplicating it when it finishes', async () => {
      await store.saveRun(runRecord({ status: 'running', finishedAt: null }));
      await store.saveRun(runRecord());

      const runs = await store.listRuns(10);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('finished');
    });

    it('lists runs newest first', async () => {
      await store.saveRun(runRecord());
      await store.saveRun(
        runRecord({ id: 'run-20260822T060000000Z-manual', startedAt: '2026-08-22T06:00:00.000Z' }),
      );

      expect((await store.listRuns(10)).map((run) => run.id)).toEqual([
        'run-20260822T060000000Z-manual',
        runRecord().id,
      ]);
    });

    it('returns null for a run it does not have', async () => {
      expect(await store.getRun('run-nothing')).toBeNull();
    });

    it('round trips a bump with its score and brief', async () => {
      await store.saveBump(bumpRecord());
      const loaded = await store.getBump(DEMO.id, bumpRecord().key);

      expect(loaded?.score.total).toBe(scoreOf().total);
      expect(loaded?.brief.content?.headline).toBe(readyBrief().content?.headline);
    });

    it('replaces a bump on a second run instead of storing it twice', async () => {
      await store.saveBump(bumpRecord());
      await store.saveBump(bumpRecord({ updatedAt: '2026-08-22T06:00:00.000Z' }));

      const bumps = await store.listBumps({ repositoryId: DEMO.id, limit: 10 });
      expect(bumps).toHaveLength(1);
      expect(bumps[0]?.updatedAt).toBe('2026-08-22T06:00:00.000Z');
    });

    it('lists a project queue riskiest first', async () => {
      await store.saveBump(greenBump());
      await store.saveBump(bumpRecord());

      const bumps = await store.listBumps({ repositoryId: DEMO.id, limit: 10 });
      expect(bumps.map((bump) => bump.dependency)).toEqual(['express', 'hono']);
    });

    it('filters a queue by verdict', async () => {
      await store.saveBump(greenBump());
      await store.saveBump(bumpRecord());

      const green = await store.listBumps({ repositoryId: DEMO.id, band: 'green', limit: 10 });
      expect(green.map((bump) => bump.dependency)).toEqual(['hono']);
    });

    it('honours the limit a page asks for', async () => {
      await store.saveBump(greenBump());
      await store.saveBump(bumpRecord());

      expect(await store.listBumps({ repositoryId: DEMO.id, limit: 1 })).toHaveLength(1);
    });

    it('keeps one project queue out of another', async () => {
      await store.saveBump(bumpRecord());
      expect(await store.listBumps({ repositoryId: 'demo/other', limit: 10 })).toEqual([]);
    });

    it('appends actions and lists them newest first', async () => {
      await store.appendAction(actionRecord());
      await store.appendAction(
        actionRecord({ id: 'run-2|k', at: '2026-08-22T06:00:00.000Z', detail: 'later' }),
      );

      const actions = await store.listActions({ limit: 10 });
      expect(actions.map((action) => action.detail)).toEqual(['later', 'opened issue #38']);
    });

    it('records the rule id and the URL with every action', async () => {
      await store.appendAction(actionRecord());
      const [action] = await store.listActions({ limit: 1 });

      expect(action?.ruleId).toBe('RED-HOLD-1');
      expect(action?.url).toBe('https://github.com/demo/app/issues/38');
    });

    it('filters the audit log by project', async () => {
      await store.appendAction(actionRecord());
      await store.appendAction(actionRecord({ id: 'other', repositoryId: 'demo/other' }));

      const mine = await store.listActions({ repositoryId: DEMO.id, limit: 10 });
      expect(mine).toHaveLength(1);
    });

    it('stores and returns a brief by its cache key', async () => {
      const brief = readyBrief();
      await store.putBrief(brief);

      expect(await store.getBrief(brief.cacheKey)).toEqual(brief);
      expect(await store.getBrief('no such key')).toBeNull();
    });

    it('stores an unavailable brief without inventing content for it', async () => {
      const brief: BriefRecord = unavailableBrief({
        bumpKey: summaryOf().key,
        cacheKey: 'unavailable-key',
        model: 'gemini-3.5-flash',
        rubricVersion: '1.0.0',
        generatedAt: NOW.toISOString(),
        attempts: 2,
        truncated: true,
        reason: 'the model answered with prose',
      });
      await store.putBrief(brief);

      expect((await store.getBrief('unavailable-key'))?.content).toBeNull();
    });
  });
}

storeContract('MemoryStore', async () => new MemoryStore());

/**
 * The emulator run is opt in through FIRESTORE_EMULATOR_HOST. The reset below deletes every
 * document in the collections the store uses, so it refuses to run without that variable: the same
 * code pointed at a real project would erase it.
 */
async function resetEmulator(): Promise<FirestoreStore> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('refusing to reset Firestore without FIRESTORE_EMULATOR_HOST');
  }

  const client = new Firestore({ projectId: EMULATOR_PROJECT, ignoreUndefinedProperties: true });
  for (const collection of ['projects', 'runs', 'actions', 'briefs']) {
    await client.recursiveDelete(client.collection(collection));
  }
  return new FirestoreStore({ projectId: EMULATOR_PROJECT, client });
}

describe.skipIf(!EMULATOR)('against the Firestore emulator', () => {
  storeContract('FirestoreStore', resetEmulator);
});
