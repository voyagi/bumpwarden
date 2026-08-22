import type { FetchLike } from '../io/http.js';

export interface InFlightMeter {
  impl: FetchLike;
  /** The most calls that were open at one moment. */
  peak: () => number;
  /** Urls in the order their responses came back, which a routed fixture cannot show. */
  finished: string[];
}

/**
 * Wraps a fetch so a test can see how many calls overlapped and which finished last. A per-url delay
 * lets the test make one dependency finish after every other, which is what proves the run's
 * output order does not depend on the order its reads complete in.
 */
export function meterInFlight(impl: FetchLike, delayMsFor: (url: string) => number): InFlightMeter {
  let inFlight = 0;
  let peak = 0;
  const finished: string[] = [];

  const metered: FetchLike = async (url, init) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      const wait = delayMsFor(url);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      return await impl(url, init);
    } finally {
      inFlight -= 1;
      finished.push(url);
    }
  };

  return { impl: metered, peak: () => peak, finished };
}
