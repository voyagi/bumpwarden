import { createEvent, type Event } from '@google/adk';
import { describe, expect, it } from 'vitest';
import { BRIEF_MAX_CHARS } from '../core/brief.js';
import {
  BRIEFS_IN_FLIGHT,
  BRIEF_MODEL,
  FREE_TIER_REQUESTS_PER_DAY,
  FREE_TIER_REQUESTS_PER_MINUTE,
} from '../core/stack.js';
import {
  DEFAULT_BRIEF_MODEL,
  MAX_OUTPUT_TOKENS,
  REQUESTS_PER_BRIEF,
  countsAsRequest,
  limitFrom,
  readRun,
  retryDelayFrom,
} from './adk-engine.js';
import type { RequestPacer } from './pace.js';
import { MAX_RETRY_WAIT_MS, ModelRefusal } from './write-brief.js';

/**
 * Verbatim, from a live 429 on 2026-08-22, the sixth request inside one minute. It is the only
 * place the free tier states its own limit, and the only place the wait is written down, so the
 * parsers are measured against the real sentence rather than a tidied one.
 */
const LIVE_429 =
  'You exceeded your current quota, please check your plan and billing details. For more ' +
  'information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To ' +
  'monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for ' +
  'metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, ' +
  'model: gemini-3.5-flash\nPlease retry in 39.352527719s.';

/**
 * The same metric refusing under the day's allowance, verbatim from 2026-08-21. It names a bigger
 * number than the minute's, and for a day it was read as a second minute limit: the refusal that
 * settled it came with the minute empty, six minutes after the last request.
 */
const LIVE_429_DAY =
  'You exceeded your current quota, please check your plan and billing details. For more ' +
  'information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To ' +
  'monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for ' +
  'metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, ' +
  'model: gemini-3.5-flash\nPlease retry in 10.554422839s.';

/**
 * A conservative floor for JSON in English. Real text runs nearer four characters per token, so
 * measuring against three leaves the budget room to be wrong in the safe direction.
 */
const CHARS_PER_TOKEN = 3;

describe('the brief the model is asked for', () => {
  it('has room in the output budget for the longest answer the schema allows', () => {
    expect(MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN).toBeGreaterThanOrEqual(BRIEF_MAX_CHARS);
  });

  it('asks for the model the About page names', () => {
    expect(DEFAULT_BRIEF_MODEL).toBe(BRIEF_MODEL);
  });
});

describe('the wait a refused call asks for', () => {
  it('reads it out of the sentence the API actually sends, rounded up to a whole millisecond', () => {
    expect(retryDelayFrom(LIVE_429)).toBe(39_353);
    expect(retryDelayFrom(LIVE_429_DAY)).toBe(10_555);
  });

  it('has nothing to report when the refusal named no wait', () => {
    expect(retryDelayFrom('You exceeded your current quota.')).toBeNull();
    expect(retryDelayFrom('')).toBeNull();
    expect(retryDelayFrom('retry in 0s')).toBeNull();
  });
});

describe('the limit a refused call names', () => {
  it('reads the minute and the day off their real sentences', () => {
    expect(limitFrom(LIVE_429)).toBe(FREE_TIER_REQUESTS_PER_MINUTE);
    expect(limitFrom(LIVE_429_DAY)).toBe(FREE_TIER_REQUESTS_PER_DAY);
  });

  it('has nothing to report when no limit is named', () => {
    expect(limitFrom('You exceeded your current quota.')).toBeNull();
    expect(limitFrom('limit: 0, model: gemini-3.5-flash')).toBeNull();
    expect(limitFrom('')).toBeNull();
  });
});

const ANSWER = '{"headline":"express 5 removes res.sendfile"}';

/**
 * The events one live call yields, built with the framework's own constructor so a fixture cannot
 * drift from the shape the runner really produces. Read off a run on 2026-08-22: the model asks for
 * its tools and reports the tokens it spent, the tools answer inside this process, then the model
 * writes the brief. Two of the three cost a request, which is where REQUESTS_PER_BRIEF comes from.
 */
const MODEL_ASKS_FOR_TOOLS = createEvent({
  author: 'bumpwarden_brief',
  content: { role: 'model', parts: [{ functionCall: { name: 'read_release_notes', args: {} } }] },
  usageMetadata: { promptTokenCount: 496, candidatesTokenCount: 24, totalTokenCount: 520 },
});

const TOOLS_ANSWER = createEvent({
  author: 'bumpwarden_brief',
  content: {
    role: 'user',
    parts: [{ functionResponse: { name: 'read_release_notes', response: {} } }],
  },
});

const MODEL_ANSWERS = createEvent({
  author: 'bumpwarden_brief',
  content: { role: 'model', parts: [{ text: ANSWER }] },
  usageMetadata: { promptTokenCount: 569, candidatesTokenCount: 154, totalTokenCount: 723 },
});

const REFUSED = createEvent({
  author: 'bumpwarden_brief',
  errorCode: '429',
  errorMessage: LIVE_429,
});

async function* stream(...events: Event[]): AsyncIterable<Event> {
  for (const event of events) yield event;
}

interface Recorder {
  pacer: RequestPacer;
  spent: () => number;
  /** How many times the room was handed back. */
  released: () => number;
  /** The last hold the engine asked for, or null when it asked for none. */
  held: () => number | null;
  /** The last limit the engine asked the pacer to adopt, or null when it asked for none. */
  tightened: () => number | null;
}

function recorder(): Recorder {
  let spent = 0;
  let released = 0;
  let held: number | null = null;
  let tightened: number | null = null;
  return {
    spent: () => spent,
    released: () => released,
    held: () => held,
    tightened: () => tightened,
    pacer: {
      clear: () =>
        Promise.resolve({
          waitedMs: 0,
          spend: (count) => {
            spent += count;
          },
          release: () => {
            released += 1;
          },
        }),
      hold: (ms) => {
        held = ms;
      },
      tighten: (limit) => {
        tightened = limit;
      },
      limit: () => FREE_TIER_REQUESTS_PER_MINUTE,
      used: () => spent,
      waited: () => 0,
    },
  };
}

describe('what a call to the model costs, and when it is paid', () => {
  it('counts a model turn and a refusal, and not a tool result that never left the process', () => {
    expect(countsAsRequest(MODEL_ASKS_FOR_TOOLS)).toBe(true);
    expect(countsAsRequest(MODEL_ANSWERS)).toBe(true);
    expect(countsAsRequest(REFUSED)).toBe(true);
    expect(countsAsRequest(TOOLS_ANSWER)).toBe(false);
  });

  it('does not count a streamed piece of a request that was counted when it began', () => {
    expect(countsAsRequest({ ...MODEL_ANSWERS, partial: true })).toBe(false);
  });

  it('books what a live brief really spends, and returns the answer', async () => {
    const paced = recorder();

    const answer = await readRun(
      stream(MODEL_ASKS_FOR_TOOLS, TOOLS_ANSWER, MODEL_ANSWERS),
      paced.pacer,
    );

    expect(answer).toBe(ANSWER);
    expect(paced.spent()).toBe(REQUESTS_PER_BRIEF);
  });

  it('books the known cost when nothing reported one, rather than reading the call as free', async () => {
    const paced = recorder();
    const silent = createEvent({ content: { role: 'model', parts: [{ text: ANSWER }] } });

    await readRun(stream(silent), paced.pacer);

    expect(paced.spent()).toBe(REQUESTS_PER_BRIEF);
  });

  it('books a refused request too, because the API was asked either way', async () => {
    const paced = recorder();

    await expect(readRun(stream(REFUSED), paced.pacer)).rejects.toThrow(ModelRefusal);
    expect(paced.spent()).toBe(1);
  });

  it('keeps an answer that arrived after an error rather than raising the error', async () => {
    const paced = recorder();

    await expect(readRun(stream(REFUSED, MODEL_ANSWERS), paced.pacer)).resolves.toBe(ANSWER);
  });

  /**
   * Several briefs share one pacer now. Room that a finished call never handed back would count
   * against every later call for the rest of the minute, and a refusal one brief was told about is
   * true for the others too.
   */
  it('hands its room back once the call is over, answered or refused', async () => {
    const answered = recorder();
    await readRun(stream(MODEL_ASKS_FOR_TOOLS, TOOLS_ANSWER, MODEL_ANSWERS), answered.pacer);
    expect(answered.released()).toBe(1);

    const refused = recorder();
    await expect(readRun(stream(REFUSED), refused.pacer)).rejects.toThrow(ModelRefusal);
    expect(refused.released()).toBe(1);
  });

  it('holds every caller for the wait a refusal named, no longer than the retry cap', async () => {
    const paced = recorder();
    await expect(readRun(stream(REFUSED), paced.pacer)).rejects.toThrow(ModelRefusal);
    expect(paced.held()).toBe(MAX_RETRY_WAIT_MS);

    const brief = recorder();
    const soon = createEvent({
      author: 'bumpwarden_brief',
      errorCode: '429',
      errorMessage: LIVE_429_DAY,
    });
    await expect(readRun(stream(soon), brief.pacer)).rejects.toThrow(ModelRefusal);
    expect(brief.held()).toBe(10_555);

    const quiet = recorder();
    await readRun(stream(MODEL_ANSWERS), quiet.pacer);
    expect(quiet.held()).toBeNull();
  });

  it('hands the pacer the limit a refusal named, and nothing when none was named', async () => {
    const paced = recorder();
    await expect(readRun(stream(REFUSED), paced.pacer)).rejects.toThrow(ModelRefusal);
    expect(paced.tightened()).toBe(FREE_TIER_REQUESTS_PER_MINUTE);

    const unnamed = recorder();
    const vague = createEvent({
      author: 'bumpwarden_brief',
      errorCode: '429',
      errorMessage: 'You exceeded your current quota.',
    });
    await expect(readRun(stream(vague), unnamed.pacer)).rejects.toThrow(ModelRefusal);
    expect(unnamed.tightened()).toBeNull();
  });

  it('waits for room before the first request goes out, not after it', async () => {
    const order: string[] = [];
    const pacer: RequestPacer = {
      clear: () => {
        order.push('waited for room');
        return Promise.resolve({
          waitedMs: 0,
          spend: () => {
            order.push('spent a request');
          },
          release: () => undefined,
        });
      },
      hold: () => undefined,
      tighten: () => undefined,
      limit: () => FREE_TIER_REQUESTS_PER_MINUTE,
      used: () => 0,
      waited: () => 0,
    };
    async function* watched(): AsyncIterable<Event> {
      order.push('asked the model');
      yield MODEL_ANSWERS;
    }

    await readRun(watched(), pacer);

    expect(order).toEqual(['waited for room', 'asked the model', 'spent a request']);
  });

  it('paces against the limit the free tier states, not one of its own', () => {
    expect(FREE_TIER_REQUESTS_PER_MINUTE).toBe(5);
    expect(LIVE_429).toContain(`limit: ${FREE_TIER_REQUESTS_PER_MINUTE}`);
    expect(LIVE_429_DAY).toContain(`limit: ${FREE_TIER_REQUESTS_PER_DAY}`);
  });

  it('never opens a burst the minute could not hold', () => {
    expect(BRIEFS_IN_FLIGHT * REQUESTS_PER_BRIEF).toBeLessThanOrEqual(
      FREE_TIER_REQUESTS_PER_MINUTE,
    );
  });
});
