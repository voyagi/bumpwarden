import type { FetchLike } from '../io/http.js';

/**
 * A Response body can only be read once and the script repeats its last step for every extra call,
 * so each step is a factory rather than an instance. Reusing one Response across two calls throws
 * "Body is unusable", which reads as a fetcher bug when it is a harness bug.
 */
export type Step = (() => Response) | 'throw';

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

export function text(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): () => Response {
  return () => new Response(body, { status, headers });
}

export function status(code: number, headers: Record<string, string> = {}): () => Response {
  return () => new Response('', { status: code, headers });
}

/** Answers calls in order, repeating the last step once the script runs out. */
export function scriptedFetch(steps: Step[]): RoutedFetch {
  const urls: string[] = [];
  let index = 0;
  const impl: FetchLike = async (url) => {
    urls.push(url);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === undefined) throw new Error('scriptedFetch was given no steps');
    if (step === 'throw') throw new Error('socket hang up');
    return step();
  };
  return { impl, urls };
}

export interface Route {
  match: (url: string) => boolean;
  step: Step;
}

export interface RoutedFetch {
  impl: FetchLike;
  urls: string[];
}

/** Routes by URL rather than by call order, so a test does not encode the fetcher's call sequence. */
export function routedFetch(routes: Route[], fallback: Step = status(404)): RoutedFetch {
  const urls: string[] = [];
  const impl: FetchLike = async (url) => {
    urls.push(url);
    const route = routes.find((candidate) => candidate.match(url));
    const step = route?.step ?? fallback;
    if (step === 'throw') throw new Error('socket hang up');
    return step();
  };
  return { impl, urls };
}

export function urlContains(fragment: string): (url: string) => boolean {
  return (url) => url.includes(fragment);
}
