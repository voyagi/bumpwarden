import { BRIEF_MODEL } from '../core/stack.js';

/**
 * `gemini-3.5-flash` is a family alias, not a frozen model: Google moves it and can retire it. This
 * asks the API whether the exact id still resolves, and what it resolves to, without spending a
 * model request. The free tier answers twenty requests a day and every cold start would pay one,
 * so the real call is the first brief of a run, and `npm run smoke:brief` is the operator's proof
 * of life. A listing is not proof the model answers (Google has kept retired ids listed), which
 * is why the boot log says "listed", never "answers".
 *
 * `generates` says only that `generateContent` was among the methods the answer listed. False
 * covers the answer that listed no methods at all, so it is "the API did not say", never "the
 * model refuses": read it beside `version`, and treat a real refusal as something only a request
 * can establish.
 */
export type ModelProbe =
  | { status: 'listed'; model: string; version: string; generates: boolean }
  | { status: 'missing'; model: string }
  | { status: 'refused'; model: string; reason: string }
  | { status: 'unreachable'; model: string; reason: string };

export interface ModelProbeOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Node's own error codes name a network failure better than its messages do: `ENOTFOUND` says DNS,
 * `ECONNREFUSED` says nothing is listening, `CERT_HAS_EXPIRED` says the trust store. An
 * `AggregateError` (one address family per attempt) carries neither and keeps them in `errors`.
 */
function reasonOf(error: unknown, depth = 0): string {
  if (typeof error === 'string') return error;
  if (!(error instanceof Error)) return String(error);

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (error.message.length > 0) return error.message;

  const nested = (error as { errors?: unknown }).errors;
  if (depth < 3 && Array.isArray(nested) && nested.length > 0)
    return reasonOf(nested[0], depth + 1);
  return error.name;
}

/**
 * `fetch` reports every network failure as the same `TypeError: fetch failed` and puts the one that
 * happened on `cause`, so a log written from the message alone tells the operator nothing they can
 * act on. The timeout is named rather than coded because it is this file's own ceiling, not the
 * network's.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'TimeoutError') return 'timed out';

  const because = error.cause === undefined || error.cause === null ? '' : reasonOf(error.cause);
  return because.length > 0 ? `${error.message}: ${because}` : reasonOf(error);
}

/**
 * The API names a model `models/gemini-3.5-flash` in its own answer, and the id is edited by hand
 * whenever Google moves the alias, so the prefixed form is the one an operator is most likely to
 * paste. It has to come off before the id becomes a path segment: encoded whole, the slash makes
 * the request 404, this file would call a working model missing, and the runbook answers a missing
 * model with a rollback.
 */
function pathSegment(model: string): string {
  return encodeURIComponent(model.replace(/^models\//, ''));
}

/**
 * The one reason a 400 gives when the credential, rather than the request, is the problem. Read off
 * a live refusal on 2026-08-23: an invalid key is answered `400 INVALID_ARGUMENT` carrying
 * `API_KEY_INVALID` in the error details, not the 401 the status alone would suggest. A key that
 * exists without entitlement answers 403 and an expired one 401, so neither needs its body read,
 * and listing their reasons here would only be a test that can never come out true.
 */
const KEY_REJECTED = 'API_KEY_INVALID';

/**
 * A rejected credential is not an outage, and reading it as one is how a deployment holding the
 * wrong key spends a whole demo recording "brief unavailable": nothing retries its way out of it,
 * and the answer is the runbook's key rotation rather than patience. Only a 400 costs a body read,
 * because 400 is also what a malformed request from this client would earn, and calling that a
 * credential problem sends the operator to rotate a key that was never the matter.
 */
async function refusesTheKey(response: Response): Promise<boolean> {
  if (response.status === 401 || response.status === 403) return true;
  if (response.status !== 400) return false;

  const detail = await response.text().catch(() => '');
  return detail.includes(KEY_REJECTED);
}

export async function probeModel(options: ModelProbeOptions): Promise<ModelProbe> {
  const model = options.model ?? BRIEF_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${MODELS_ENDPOINT}${pathSegment(model)}`, {
      headers: { 'x-goog-api-key': options.apiKey },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: 'unreachable', model, reason: describe(error) };
  }

  if (response.status === 404) return { status: 'missing', model };
  if (!response.ok) {
    return (await refusesTheKey(response))
      ? { status: 'refused', model, reason: `HTTP ${response.status}` }
      : { status: 'unreachable', model, reason: `HTTP ${response.status}` };
  }

  let body: { version?: unknown; supportedGenerationMethods?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    return { status: 'unreachable', model, reason: `unreadable body: ${describe(error)}` };
  }
  const methods = Array.isArray(body.supportedGenerationMethods)
    ? body.supportedGenerationMethods
    : [];
  return {
    status: 'listed',
    model,
    version: typeof body.version === 'string' ? body.version : 'unknown',
    generates: methods.includes('generateContent'),
  };
}
