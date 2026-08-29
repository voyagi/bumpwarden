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

/**
 * Configuration options for creating a request pacer.
 */
export interface RequestPacerOptions {
  /** Requests allowed inside one window. */
  limit: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A reservation for request capacity in the rate limit window.
 * Room in the window that one caller has cleared and not yet used. Several briefs are in flight at
 * once, and between clearing and sending nothing has gone out yet, so without this two callers
 * could both be promised the last slot of the minute.
 */
export interface Reservation {
  /** What this call waited for its room. */
  readonly waitedMs: number;
  /** Records requests that were sent. Only a real request counts, never an intention to send one. */
  spend(count: number): void;
  /** Hands back the room that was never used. Calling it twice is harmless. */
  release(): void;
}

/**
 * Manages request pacing to stay within rate limits.
 */
export interface RequestPacer {
  /** Waits until `cost` more requests fit in the window, and holds that room for the caller. */
  clear(cost: number): Promise<Reservation>;
  /** Keeps every caller out for the wait the API named when it refused a request. */
  hold(ms: number): void;
  /** Adopts a smaller allowance the API named, for the rest of this pacer's life. */
  tighten(limit: number): void;
  /** Requests allowed inside one window, as it stands now. */
  limit(): number;
  /** Requests inside the window right now. */
  used(): number;
  /** Wall clock this pacer has spent waiting, a moment counted once however many callers shared it. */
  waited(): number;
}

/**
 * Creates a new request pacer that manages rate limiting across multiple concurrent callers.
 */
export function createRequestPacer(options: RequestPacerOptions): RequestPacer {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const sent: number[] = [];
  // The published number is a reading of one key on one day. The API states the limit it is
  // enforcing inside every refusal, and a run that keeps asking at the old number after being told
  // a lower one spends every bump's attempts learning the same thing.
  let limit = Math.max(1, options.limit);
  let reserved = 0;
  let heldUntil = 0;
  let waiting = 0;
  let waitingSince = 0;
  let waited = 0;

  const forget = (at: number): void => {
    while (sent.length > 0 && at - (sent[0] as number) >= windowMs) sent.shift();
  };

  // Four briefs held by the same minute are one minute of a run's time, not four.
  async function wait(ms: number): Promise<void> {
    if (waiting === 0) waitingSince = now();
    waiting += 1;
    await sleep(ms);
    waiting -= 1;
    if (waiting === 0) waited += now() - waitingSince;
  }

  /** How long until there could be room for `room` more, or zero when there is room now. */
  function delay(room: number, at: number): number {
    forget(at);
    if (heldUntil > at) return heldUntil - at;
    if (sent.length + reserved + room <= limit) return 0;
    // Room held by another caller has no timestamp to wait on; it is spent or handed back within a
    // request's own round trip, so a short look is all that is needed.
    const oldest = sent[0];
    return oldest === undefined ? EDGE_MS : Math.max(oldest + windowMs - at + EDGE_MS, 1);
  }

  return {
    async clear(cost: number): Promise<Reservation> {
      // A cost above the whole allowance can never fit, and waiting for room that cannot exist
      // would hang the run. Such a call waits for the emptiest window there is, then goes.
      const room = Math.min(Math.max(cost, 1), limit);
      let waitedMs = 0;

      for (let ms = delay(room, now()); ms > 0; ms = delay(room, now())) {
        waitedMs += ms;
        await wait(ms);
      }

      reserved += room;
      let remaining = room;
      return {
        waitedMs,
        spend(count: number): void {
          const at = now();
          forget(at);
          for (let index = 0; index < count; index += 1) sent.push(at);
          // A call that sends more than it cleared has overdrawn its own room, not a neighbour's.
          const covered = Math.min(count, remaining);
          remaining -= covered;
          reserved -= covered;
        },
        release(): void {
          reserved -= remaining;
          remaining = 0;
        },
      };
    },

    hold(ms: number): void {
      heldUntil = Math.max(heldUntil, now() + ms);
    },

    tighten(to: number): void {
      if (Number.isFinite(to) && to >= 1) limit = Math.min(limit, Math.floor(to));
    },

    limit: (): number => limit,

    used(): number {
      forget(now());
      return sent.length;
    },

    waited: (): number => waited,
  };
}
