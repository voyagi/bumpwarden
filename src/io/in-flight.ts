/**
 * How many of a run's reads go out at once. The sources set the ceiling: GitHub allows 100
 * concurrent requests and 900 REST points a minute, npm's own client opens 15 sockets per host,
 * and deps.dev publishes no limit. A read takes about 250 ms, so four in flight is about sixteen
 * calls a second, which keeps a GitHub-heavy stretch under half of the points limit. Wider buys
 * little, because the reads inside one dependency stay sequential, and it is the rate, not the
 * count, that a secondary limit measures.
 */
export const READS_IN_FLIGHT = 4;

/**
 * `Promise.all` with a ceiling. Results keep the input's order whatever order the reads finish in,
 * so a run's bump list and missing list stay deterministic, and once a read throws no further item
 * is handed out, so a failed run does not keep spending its call budget in the background.
 */
export async function mapInFlight<T, R>(
  items: readonly T[],
  width: number,
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await read(items[index] as T);
      } catch (error) {
        next = items.length;
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}
