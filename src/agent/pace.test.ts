import { describe, expect, it } from 'vitest';
import { createRequestPacer, type RequestPacer } from './pace.js';

const WINDOW = 60_000;

interface Harness {
  pacer: RequestPacer;
  /** Every sleep the pacer asked for, in order. */
  waits: number[];
  /** The clock reading at which each request went out, which is what the limit is about. */
  sentAt: number[];
  tick(ms: number): void;
  send(cost: number): Promise<void>;
}

/**
 * The clock belongs to the test, and a sleep moves it instead of waiting: a pacer measured against
 * a real clock would take a minute per assertion and still prove less.
 */
function harness(limit: number, windowMs = WINDOW): Harness {
  let clock = 0;
  const waits: number[] = [];
  const sentAt: number[] = [];

  const pacer = createRequestPacer({
    limit,
    windowMs,
    now: () => clock,
    sleep: (ms) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });

  return {
    pacer,
    waits,
    sentAt,
    tick: (ms) => {
      clock += ms;
    },
    async send(cost) {
      await pacer.clear(cost);
      for (let index = 0; index < cost; index += 1) sentAt.push(clock);
      pacer.spend(cost);
    },
  };
}

describe('pacing a run against the free tier', () => {
  it('sends everything the window allows without waiting once', async () => {
    const paced = harness(20);
    for (let brief = 0; brief < 10; brief += 1) await paced.send(2);

    expect(paced.waits).toEqual([]);
    expect(paced.pacer.used()).toBe(20);
    expect(paced.pacer.waited()).toBe(0);
  });

  it('holds the request that would be one too many until the oldest leaves the window', async () => {
    const paced = harness(20);
    for (let brief = 0; brief < 10; brief += 1) await paced.send(2);

    await paced.send(2);

    // Every earlier request went out at zero, so the window empties in one wait rather than in ten.
    expect(paced.waits).toEqual([WINDOW + 250]);
    expect(paced.pacer.used()).toBe(2);
  });

  it('waits for room rather than for the whole window when the requests were spread out', async () => {
    const paced = harness(4, 1000);
    await paced.send(1);
    paced.tick(100);
    await paced.send(1);
    paced.tick(100);
    await paced.send(1);
    paced.tick(100);
    await paced.send(1);

    await paced.send(1);

    // At 300 the oldest request is 300 old, so the wait is the 700 left of its second plus margin.
    expect(paced.waits).toEqual([950]);
  });

  it('never waits for room that cannot exist, so a cost above the whole allowance still goes', async () => {
    const paced = harness(2, 1000);
    await paced.send(2);

    const waited = await paced.pacer.clear(5);

    expect(waited).toBe(1250);
    expect(paced.pacer.used()).toBe(0);
  });

  it('forgets a request once its window has passed', async () => {
    const paced = harness(20);
    await paced.send(2);
    expect(paced.pacer.used()).toBe(2);

    paced.tick(WINDOW);

    expect(paced.pacer.used()).toBe(0);
  });

  it('reports what one call waited and what the run has waited altogether', async () => {
    const paced = harness(2, 1000);
    await paced.send(2);

    const first = await paced.pacer.clear(1);
    paced.pacer.spend(1);
    const second = await paced.pacer.clear(2);

    expect(first).toBe(1250);
    expect(second).toBe(1250);
    expect(paced.pacer.waited()).toBe(first + second);
  });

  /**
   * The property the module exists for, measured the way the API measures it. Counting waits would
   * pass on a pacer that waits at the wrong moments; this fails unless every minute of a long run
   * is inside the limit.
   */
  it('keeps every minute of a long run inside the limit', async () => {
    const paced = harness(20);

    for (let brief = 0; brief < 60; brief += 1) {
      await paced.send(2);
      paced.tick(800);
    }

    expect(paced.sentAt).toHaveLength(120);
    for (const start of paced.sentAt) {
      const inside = paced.sentAt.filter((at) => at >= start && at < start + WINDOW);
      expect(inside.length).toBeLessThanOrEqual(20);
    }
  });
});
