import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestPacer, type RequestPacer, type Reservation } from './pace.js';

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
 * a real clock would take a minute per assertion and still prove less. A pacer that never finds
 * room would sleep forever, so the harness gives up after a thousand sleeps rather than hang.
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
      if (waits.length > 1000) throw new Error('the pacer never found room');
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
      const room = await pacer.clear(cost);
      for (let index = 0; index < cost; index += 1) sentAt.push(clock);
      room.spend(cost);
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

    const room = await paced.pacer.clear(5);

    expect(room.waitedMs).toBe(1250);
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
    first.spend(1);
    const second = await paced.pacer.clear(2);

    expect(first.waitedMs).toBe(1250);
    expect(second.waitedMs).toBe(1250);
    expect(paced.pacer.waited()).toBe(first.waitedMs + second.waitedMs);
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

describe('several briefs in flight on one pacer', () => {
  /**
   * Between clearing and sending, nothing has gone out, and a pacer that only counts what was sent
   * promises the same last slot to everyone who asks in that gap. This is the failure four briefs
   * at once would meet on a queue of twenty.
   */
  it('holds the room a caller cleared until that caller sends, so a second caller cannot take it', async () => {
    const paced = harness(20);
    for (let brief = 0; brief < 9; brief += 1) await paced.send(2);

    const first = await paced.pacer.clear(2);
    const second = await paced.pacer.clear(2);

    expect(first.waitedMs).toBe(0);
    expect(second.waitedMs).toBe(WINDOW + 250);
    first.release();
    second.release();
  });

  it('makes the room a caller hands back available again', async () => {
    const paced = harness(4, 1000);
    const whole = await paced.pacer.clear(4);

    whole.release();
    whole.release();
    const next = await paced.pacer.clear(4);

    expect(next.waitedMs).toBe(0);
  });

  it('counts a request once whether it was cleared first or not', async () => {
    const paced = harness(20);
    const room = await paced.pacer.clear(2);
    room.spend(2);

    const rest = await paced.pacer.clear(18);

    expect(paced.pacer.used()).toBe(2);
    expect(rest.waitedMs).toBe(0);
  });

  it('charges a caller that sends more than it cleared, never its neighbour', async () => {
    const paced = harness(20);
    const first = await paced.pacer.clear(2);
    const second = await paced.pacer.clear(2);
    first.spend(3);

    // Three sent and two still held by the second caller leaves room for fifteen, not sixteen.
    const fifteen = await paced.pacer.clear(15);
    expect(fifteen.waitedMs).toBe(0);
    const one = await paced.pacer.clear(1);
    expect(one.waitedMs).toBeGreaterThan(0);
    second.release();
  });

  it('keeps every caller out for the wait a refusal named, not only the one refused', async () => {
    const paced = harness(20);
    await paced.send(2);
    paced.tick(5_000);

    paced.pacer.hold(15_000);
    const room = await paced.pacer.clear(2);

    // The wait is measured from the refusal, not from the start of the run.
    expect(room.waitedMs).toBe(15_000);
    expect(paced.waits).toEqual([15_000]);
  });

  it('lets a held caller go as soon as the hold has passed', async () => {
    const paced = harness(20);
    paced.tick(5_000);
    paced.pacer.hold(15_000);
    paced.tick(15_000);

    const room = await paced.pacer.clear(2);

    expect(room.waitedMs).toBe(0);
  });

  /**
   * The published limit was read off one refusal on one day, and the next day the same key
   * answered five a minute where it had answered twenty. The API names the limit it enforces in
   * every refusal, so the pacer takes a smaller one at its word and never a larger one.
   */
  it('adopts a smaller limit the API names, and only a smaller one', async () => {
    const paced = harness(20);
    await paced.send(2);
    await paced.send(2);

    paced.pacer.tighten(5);
    paced.pacer.tighten(50);
    paced.pacer.tighten(0);
    paced.pacer.tighten(Number.NaN);

    expect(paced.pacer.limit()).toBe(5);
    const fifth = await paced.pacer.clear(1);
    expect(fifth.waitedMs).toBe(0);
    const sixth = await paced.pacer.clear(1);
    expect(sixth.waitedMs).toBe(WINDOW + 250);
  });
});

/**
 * Real timers, faked: callers that really overlap, sleeping at the same moment, which the
 * one-caller harness above cannot show because its clock moves when a sleep is asked for.
 */
describe('four callers on one pacer, on a clock they share', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

  async function brief(pacer: RequestPacer, sentAt: number[]): Promise<void> {
    const room: Reservation = await pacer.clear(2);
    sentAt.push(Date.now());
    room.spend(1);
    await pause(1_000);
    sentAt.push(Date.now());
    room.spend(1);
    await pause(12_000);
    room.release();
  }

  it('keeps every minute inside the limit with four briefs in flight', async () => {
    vi.useFakeTimers();
    const pacer = createRequestPacer({ limit: 20 });
    const sentAt: number[] = [];

    async function worker(briefs: number): Promise<void> {
      for (let index = 0; index < briefs; index += 1) await brief(pacer, sentAt);
    }
    const run = Promise.all([worker(15), worker(15), worker(15), worker(15)]);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await run;

    expect(sentAt).toHaveLength(120);
    for (const start of sentAt) {
      const inside = sentAt.filter((at) => at >= start && at < start + WINDOW);
      expect(inside.length).toBeLessThanOrEqual(20);
    }
  });

  it('counts a minute that four callers spent waiting together as one minute', async () => {
    vi.useFakeTimers();
    const pacer = createRequestPacer({ limit: 20 });
    const sentAt: number[] = [];
    const full = await pacer.clear(20);
    full.spend(20);

    const run = Promise.all([
      brief(pacer, sentAt),
      brief(pacer, sentAt),
      brief(pacer, sentAt),
      brief(pacer, sentAt),
    ]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await run;

    expect(pacer.waited()).toBe(WINDOW + 250);
  });
});
