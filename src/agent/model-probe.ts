import { BRIEF_MODEL } from '../core/stack.js';

/**
 * `gemini-3.5-flash` is a family alias, not a frozen model: Google moves it and can retire it. This
 * asks the API whether the exact id still resolves, and what it resolves to, without spending a
 * model request. The free tier answers twenty requests a day and every cold start would pay one,
 * so the real call is the first brief of a run, and `npm run smoke:brief` is the operator's proof
 * of life. A listing is not proof the model answers (Google has kept retired ids listed), which
 * is why the boot log says "listed", never "answers".
 */
export type ModelProbe =
  | { status: 'listed'; model: string; version: string; generates: boolean }
  | { status: 'missing'; model: string }
  | { status: 'unreachable'; model: string; reason: string };

export interface ModelProbeOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_TIMEOUT_MS = 10_000;

function describe(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timed out' : error.message;
  return String(error);
}

export async function probeModel(options: ModelProbeOptions): Promise<ModelProbe> {
  const model = options.model ?? BRIEF_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${MODELS_ENDPOINT}${encodeURIComponent(model)}`, {
      headers: { 'x-goog-api-key': options.apiKey },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: 'unreachable', model, reason: describe(error) };
  }

  if (response.status === 404) return { status: 'missing', model };
  if (!response.ok) {
    return { status: 'unreachable', model, reason: `HTTP ${response.status}` };
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
