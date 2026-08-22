/**
 * Spending the free tier's minute instead of discovering it. A run asks for up to 20 briefs and a
 * brief costs two model requests, so 40 requests used to arrive inside a window that allows 20 and
 * the API refused the surplus. Waiting for room takes the same wall clock and spends nothing on
 * refusals. The refusal path in write-brief.ts stays: this stops bumpwarden causing a 429, not
 * anything else on the same key causing one.
 */

const WINDOW_MS = 60_000;

/**
 * The window is kept on this clock and enforced on the server's, so a request sent at the exact
 * edge can still be counted inside the window that was closing. A quarter second of margin buys
 * that back for nothing, since a paced run is already waiting.
 */
const EDGE_MS = 250;

export interface RequestPacerOptions {
  /** Requests allowed inside one window. */
  limit: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestPacer {
  /** Waits until `cost` more requests fit in the window, and answers with the time it waited. */
  clear(cost: number): Promise<number>;
  /** Records requests that were sent. Only a real request counts, never an intention to send one. */
  spend(count: number): void;
  /** Requests inside the window right now. */
  used(): number;
  /** Everything this pacer has waited, for a run that wants to say why it took the time it did. */
  waited(): number;
}

export function createRequestPacer(options: RequestPacerOptions): RequestPacer {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const sent: number[] = [];
  let waited = 0;

  const forget = (at: number): void => {
    while (sent.length > 0 && at - (sent[0] as number) >= windowMs) sent.shift();
  };

  return {
    async clear(cost: number): Promise<number> {
      // A cost above the whole allowance can never fit, and waiting for room that cannot exist
      // would hang the run. Such a call waits for the emptiest window there is, then goes.
      const room = Math.min(Math.max(cost, 1), options.limit);
      const before = waited;

      while (true) {
        const at = now();
        forget(at);
        if (sent.length + room <= options.limit) return waited - before;

        const ms = Math.max((sent[0] as number) + windowMs - at + EDGE_MS, 1);
        waited += ms;
        await sleep(ms);
      }
    },

    spend(count: number): void {
      const at = now();
      forget(at);
      for (let index = 0; index < count; index += 1) sent.push(at);
    },

    used(): number {
      forget(now());
      return sent.length;
    },

    waited: (): number => waited,
  };
}
