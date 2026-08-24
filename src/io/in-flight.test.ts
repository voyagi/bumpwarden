import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deferred } from '../testkit/deferred.js';
import { READS_IN_FLIGHT, mapInFlight } from './in-flight.js';

describe('the width of a run', () => {
  it('is the number the deploy review tells an operator', () => {
    const review = readFileSync(
      fileURLToPath(new URL('../../docs/deploy-review.md', import.meta.url)),
      'utf8',
    );
    expect(review).toContain(`at most ${READS_IN_FLIGHT} go out at once`);
  });
});

describe('mapInFlight', () => {
  it('keeps the input order however the reads finish', async () => {
    const gates = { a: deferred<string>(), b: deferred<string>(), c: deferred<string>() };

    const result = mapInFlight(['a', 'b', 'c'] as const, 3, (item) => gates[item].promise);
    gates.c.resolve('C');
    gates.b.resolve('B');
    gates.a.resolve('A');

    expect(await result).toEqual(['A', 'B', 'C']);
  });

  it('fills the width and never exceeds it', async () => {
    let inFlight = 0;
    let peak = 0;

    const result = await mapInFlight(
      Array.from({ length: 10 }, (_, index) => index),
      3,
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return item * 2;
      },
    );

    expect(result).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(peak).toBe(3);
  });

  it('returns nothing for nothing without asking for a read', async () => {
    let reads = 0;
    expect(await mapInFlight([], 4, async () => (reads += 1))).toEqual([]);
    expect(reads).toBe(0);
  });

  /**
   * The reads still open when one throws finish on their own, and then nothing else starts. A run
   * that failed must not keep spending its call budget on dependencies nobody will score.
   */
  it('stops handing out reads once one of them throws', async () => {
    const started: number[] = [];
    const second = deferred<number>();

    const failing = mapInFlight([1, 2, 3, 4], 2, (item) => {
      started.push(item);
      if (item === 1) return Promise.reject(new Error('socket hang up'));
      return second.promise;
    });

    await expect(failing).rejects.toThrow('socket hang up');
    second.resolve(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([1, 2]);
  });
});
