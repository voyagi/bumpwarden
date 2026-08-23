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

/**
 * What boot says about each answer. It lives beside the answers rather than in the entry point
 * because two documents explain these lines to whoever is reading a log at the time: the runbook
 * says what to do about each, and the stack decision says what each means. A reworded message and
 * a document still naming the old one is a map that has quietly stopped matching the place.
 */
export const MODEL_LOG: Record<ModelProbe['status'], string> = {
  listed: 'model listed',
  missing: 'model missing',
  refused: 'model refused the key',
  unreachable: 'model not checked',
};

export interface ModelProbeOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/';
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

  // The attempts inside come before this error's own message, not after it: an aggregate that does
  // carry a summary ("All attempts failed") would otherwise answer with the summary and the codes
  // it was gathered to hold would never be reached, which is the whole reason for looking.
  const nested = (error as { errors?: unknown }).errors;
  if (depth < 3 && Array.isArray(nested) && nested.length > 0) {
    return reasonOf(nested[0], depth + 1);
  }

  return error.message.length > 0 ? error.message : error.name;
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
 * The API addresses a model by its full resource name, and the collection is part of that name:
 * `models/gemini-3.5-flash` is what its own answer calls this one, and a fine-tuned model lives
 * under `tunedModels/` instead. A bare id means the models collection, which is the only one this
 * service uses. The distinction matters because the slash is a path separator here rather than a
 * character to encode: sent encoded, the request comes back 404, this file would call a working
 * model missing, and the runbook answers a missing model with a rollback.
 */
function resourcePath(model: string): string {
  const name = model.includes('/') ? model : `models/${model}`;
  return name.split('/').map(encodeURIComponent).join('/');
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
    response = await fetchImpl(`${API_BASE}${resourcePath(model)}`, {
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

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    return { status: 'unreachable', model, reason: `unreadable body: ${describe(error)}` };
  }

  // `null` and a bare string are both legal JSON, and reading a field off either throws. A probe
  // that exists to keep a bad answer from ending the boot must not be the thing that throws.
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
    version?: unknown;
    supportedGenerationMethods?: unknown;
  };
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
