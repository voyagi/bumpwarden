import { describe, expect, it, vi } from 'vitest';
import { briefCacheKey, type BriefRecord } from '../core/brief.js';
import { RUBRIC_VERSION } from '../core/rubric.js';
import { EXPRESS_NOTES, NOW, candidateBump, summaryOf } from '../testkit/fixtures.js';
import type { BriefMaterial, BriefRequest } from './prompt.js';
import {
  ModelRefusal,
  extractJson,
  readAnswer,
  writeBrief,
  type BriefCache,
  type BriefEngine,
} from './write-brief.js';

const VALID = {
  headline: 'Two removed methods are called in your routes',
  whatChanged: 'Express 5 drops methods Express 4 accepted.',
  breakingChanges: ['res.sendfile is now res.sendFile'],
  breaksHere: [
    {
      path: 'src/routes/files.ts',
      line: 18,
      symbol: 'res.sendfile',
      quote: 'The `res.sendfile()` function has been replaced by a camel-cased version',
      source: 'https://expressjs.com/en/guide/migrating-5.html',
    },
  ],
  migrationSteps: ['Rename the call on line 18.'],
  confidence: 'high',
};

function request(overrides: Partial<BriefRequest> = {}): BriefRequest {
  const bump = candidateBump();
  return {
    bumpKey: summaryOf().key,
    repositoryId: 'demo/app',
    dependency: bump.dependency,
    currentVersion: bump.currentVersion,
    candidateVersion: bump.candidateVersion,
    band: 'red',
    score: 62,
    releaseNotes: EXPRESS_NOTES,
    releaseNotesSource: 'https://github.com/expressjs/express/releases/tag/v5.0.0',
    commitSubjects: bump.release.commitSubjects,
    usageSites: bump.usageSites,
    changedFiles: ['lib/response.js'],
    ...overrides,
  };
}

interface ScriptedEngine extends BriefEngine {
  seen: Array<{ attempt: number; material: BriefMaterial }>;
}

function engine(answers: Array<string | Error>): ScriptedEngine {
  const seen: Array<{ attempt: number; material: BriefMaterial }> = [];
  return {
    model: 'gemini-3.5-flash',
    seen,
    async generate(_request, material, attempt) {
      seen.push({ attempt, material });
      const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer ?? '';
    },
  };
}

function options(briefEngine: BriefEngine, cache: BriefCache | null = null) {
  return { engine: briefEngine, rubricVersion: RUBRIC_VERSION, now: NOW, cache };
}

describe('writing a brief', () => {
  it('validates the answer and records one attempt', async () => {
    const record = await writeBrief(request(), options(engine([JSON.stringify(VALID)])));

    expect(record.status).toBe('ready');
    expect(record.attempts).toBe(1);
    expect(record.content?.headline).toBe(VALID.headline);
    expect(record.model).toBe('gemini-3.5-flash');
    expect(record.rubricVersion).toBe(RUBRIC_VERSION);
  });

  it('reads an answer wrapped in a fenced code block', async () => {
    const fenced = '```json\n' + JSON.stringify(VALID) + '\n```';
    expect((await writeBrief(request(), options(engine([fenced])))).status).toBe('ready');
  });

  it('retries once when the first answer does not match the schema', async () => {
    const scripted = engine(['{"headline": "too short to be a brief"}', JSON.stringify(VALID)]);
    const record = await writeBrief(request(), options(scripted));

    expect(record.status).toBe('ready');
    expect(record.attempts).toBe(2);
    expect(scripted.seen.map((call) => call.attempt)).toEqual([1, 2]);
  });

  it('gives up after the retry and says why, rather than inventing an answer', async () => {
    const record = await writeBrief(request(), options(engine(['not json at all'])));

    expect(record.status).toBe('unavailable');
    expect(record.content).toBeNull();
    expect(record.attempts).toBe(2);
    expect(record.reason).toContain('attempt 1');
    expect(record.reason).toContain('attempt 2');
  });

  it('records a transport failure instead of letting it escape into the run', async () => {
    const record = await writeBrief(request(), options(engine([new Error('429 quota exceeded')])));

    expect(record.status).toBe('unavailable');
    expect(record.reason).toContain('429 quota exceeded');
  });

  it('never writes an API key into the recorded reason', async () => {
    const leak = new Error('request to ...?key=AIzaSyD-abcdefghijklmnopqrstuvwxyz01 failed');
    const record = await writeBrief(request(), options(engine([leak])));

    expect(record.reason).toContain('[redacted]');
    expect(record.reason).not.toContain('AIzaSyD');
  });

  it('drops a claim the material does not support and counts the drop', async () => {
    const invented = {
      ...VALID,
      breaksHere: [{ ...VALID.breaksHere[0], quote: 'a sentence nobody published' }],
    };
    const record = await writeBrief(request(), options(engine([JSON.stringify(invented)])));

    expect(record.content?.breaksHere).toEqual([]);
    expect(record.droppedClaims).toBe(1);
  });

  it('labels a supported claim about a file the matcher never saw as unverified', async () => {
    const elsewhere = {
      ...VALID,
      breaksHere: [{ ...VALID.breaksHere[0], path: 'src/elsewhere.ts', line: 3 }],
    };
    const record = await writeBrief(request(), options(engine([JSON.stringify(elsewhere)])));

    expect(record.content?.breaksHere[0]?.verified).toBe(false);
  });

  it('flags a truncated input rather than letting a thin brief look thorough', async () => {
    const record = await writeBrief(request(), {
      ...options(engine([JSON.stringify(VALID)])),
      budget: { maxNoteChars: 40, maxCommitSubjects: 1, maxUsageSites: 1, maxChangedFiles: 1 },
    });

    expect(record.truncated).toBe(true);
  });
});

describe('the brief cache', () => {
  function cache(seed: BriefRecord | null = null) {
    const stored = new Map<string, BriefRecord>();
    if (seed) stored.set(seed.cacheKey, seed);
    return {
      stored,
      get: vi.fn(async (key: string) => stored.get(key) ?? null),
      put: vi.fn(async (record: BriefRecord) => {
        stored.set(record.cacheKey, record);
      }),
    };
  }

  it('returns a stored brief without calling the model again', async () => {
    const first = await writeBrief(request(), options(engine([JSON.stringify(VALID)])));
    const store = cache(first);
    const scripted = engine([JSON.stringify(VALID)]);

    const second = await writeBrief(request(), options(scripted, store));

    expect(second.generatedAt).toBe(first.generatedAt);
    expect(scripted.seen).toHaveLength(0);
  });

  it('stores a ready brief under the bump key and rubric version', async () => {
    const store = cache();
    await writeBrief(request(), options(engine([JSON.stringify(VALID)]), store));

    expect(store.put).toHaveBeenCalledTimes(1);
    expect([...store.stored.keys()]).toEqual([briefCacheKey(summaryOf().key, RUBRIC_VERSION)]);
  });

  it('does not store a failure, so one bad minute is not cached forever', async () => {
    const store = cache();
    await writeBrief(request(), options(engine(['not json']), store));

    expect(store.put).not.toHaveBeenCalled();
  });

  it('ignores a cached failure and tries again', async () => {
    const failed = await writeBrief(request(), options(engine(['not json'])));
    const store = cache(failed);
    const scripted = engine([JSON.stringify(VALID)]);

    expect((await writeBrief(request(), options(scripted, store))).status).toBe('ready');
    expect(scripted.seen).toHaveLength(1);
  });
});

/**
 * A live run met this: the free tier allows 20 model requests a minute, a bump costs two, and the
 * API answers a burst with 429 and the wait it wants. Retrying inside that wait spends a second
 * request on the same limit and fails again, so both attempts were lost to one busy minute.
 */
describe('a call the model refused', () => {
  it('waits the time the API asked for before trying again, and says what refused', async () => {
    const waits: number[] = [];
    const refusal = new ModelRefusal('429', 'quota exceeded, retry in 10.5s', 10_500);
    const scripted = engine([refusal, JSON.stringify(VALID)]);

    const record = await writeBrief(request(), {
      ...options(scripted),
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([10_500]);
    expect(record.status).toBe('ready');
    expect(record.attempts).toBe(2);
  });

  it('names the refusal in the reason rather than calling it an empty answer', async () => {
    const refusal = new ModelRefusal('429', 'quota exceeded', 500);
    const record = await writeBrief(request(), {
      ...options(engine([refusal])),
      wait: async () => undefined,
    });

    expect(record.status).toBe('unavailable');
    expect(record.reason).toContain('the model refused with 429');
  });

  /**
   * The live message opens with the same boilerplate every time and names the quota, the limit and
   * the wait at the very end, so a reason cut from the front is the half that says nothing.
   */
  it('keeps the end of a long refusal, which is the part that identifies it', async () => {
    const refusal = new ModelRefusal(
      '429',
      `You exceeded your current quota. ${'boilerplate. '.repeat(30)}Quota exceeded for metric: generate_content_free_tier_requests, limit: 20. Please retry in 10.5s.`,
      10_500,
    );

    const record = await writeBrief(request(), {
      ...options(engine([refusal])),
      wait: async () => undefined,
    });

    expect(record.reason).toContain('limit: 20');
    expect(record.reason).toContain('Please retry in 10.5s.');
    expect(record.reason).not.toContain('You exceeded your current quota');
  });

  /** A hint of an hour would park a run behind one bump. The cap is what keeps the run moving. */
  it('never waits longer than half a minute, whatever the hint says', async () => {
    const waits: number[] = [];
    const refusal = new ModelRefusal('429', 'retry in 3600s', 3_600_000);

    await writeBrief(request(), {
      ...options(engine([refusal, JSON.stringify(VALID)])),
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([30_000]);
  });

  it('does not wait after the last attempt, because nothing follows it', async () => {
    const waits: number[] = [];
    const refusal = new ModelRefusal('429', 'retry in 5s', 5_000);

    await writeBrief(request(), {
      ...options(engine([refusal, refusal])),
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([5_000]);
  });
});

describe('reading JSON out of an answer', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads an object with prose around it', () => {
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('reads a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads a fenced block with carriage returns, which a checkout can introduce', () => {
    expect(extractJson('```json\r\n{"a":1}\r\n```')).toEqual({ a: 1 });
  });

  it('returns null for text with no object in it', () => {
    expect(extractJson('I could not read the release notes.')).toBeNull();
  });

  it('returns null for a broken object rather than throwing', () => {
    expect(extractJson('{"a": ')).toBeNull();
  });
});

/**
 * A live run over a real repository recorded "no JSON object in the answer" twice, and that one
 * sentence covers three different failures with three different fixes. The one it hides is the
 * expensive one: an answer cut off at the output token cap begins as valid JSON and simply never
 * closes, so it reads as a model that misbehaved rather than a budget nobody sized.
 */
describe('what a failed answer is told to have been', () => {
  it('separates nothing, prose, a cut-off answer and malformed JSON', () => {
    expect(readAnswer('')).toMatchObject({ ok: false, problem: 'the model returned nothing' });
    expect(readAnswer('   \n ')).toMatchObject({
      ok: false,
      problem: 'the model returned nothing',
    });

    expect(readAnswer('I could not read the release notes.')).toMatchObject({
      ok: false,
      problem: 'the answer was prose rather than JSON, 35 characters',
    });

    const cut = `{"headline":"${'x'.repeat(90)}`;
    expect(readAnswer(cut)).toMatchObject({
      ok: false,
      problem:
        'the answer stopped before its JSON closed, 103 characters, which is what the output token cap looks like',
    });

    expect(readAnswer('{"a": oops}')).toMatchObject({
      ok: false,
      problem: 'the answer held JSON that would not parse, 11 characters',
    });
  });

  it('still reads a good answer', () => {
    expect(readAnswer('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });
});
