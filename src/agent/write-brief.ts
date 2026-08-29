import {
  BRIEF_SCHEMA_VERSION,
  briefCacheKey,
  briefPayloadSchema,
  claimsAuthority,
  unavailableBrief,
  verifyClaims,
  type BriefPayload,
  type BriefRecord,
} from '../core/brief.js';
import {
  budgetMaterial,
  type BriefBudget,
  type BriefMaterial,
  type BriefRequest,
} from './prompt.js';

/**
 * Interface for generating briefs using an AI model.
 */
export interface BriefEngine {
  readonly model: string;
  /** One attempt. Returns the model's final text; throws only on a transport or quota failure. */
  generate(request: BriefRequest, material: BriefMaterial, attempt: number): Promise<string>;
}

/**
 * What an engine throws when the API refused the call rather than answering it. The agent framework
 * hands a refusal back as a field on an event instead of throwing, so without this a 429 arrives as
 * an empty answer, is reported as a model that said nothing, and is retried straight back into the
 * same limit. The free tier allows a handful of model requests a minute and a bump costs two, so on
 * a real queue this is the failure a run meets, not an edge case.
 */
export class ModelRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
    /** The wait the API asked for, when it named one. */
    readonly retryAfterMs: number | null,
  ) {
    super(`the model refused with ${code}: ${detail}`);
    this.name = 'ModelRefusal';
  }
}

/** Long enough for the free tier's own minute window, short enough that a bad hint cannot park a run. */
export const MAX_RETRY_WAIT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cache for storing and retrieving brief records to avoid regenerating them.
 */
export interface BriefCache {
  get(cacheKey: string): Promise<BriefRecord | null>;
  put(record: BriefRecord): Promise<void>;
}

/**
 * Options for writing a brief, including the engine, cache, and budget settings.
 */
export interface WriteBriefOptions {
  engine: BriefEngine;
  rubricVersion: string;
  now: Date;
  cache?: BriefCache | null;
  budget?: BriefBudget;
  /** Injected so a test can assert the wait a refusal asked for without serving it. */
  wait?: (ms: number) => Promise<void>;
}

/** One retry, then the bump carries "brief unavailable" and the score stands on its own. */
const MAX_ATTEMPTS = 2;

const API_KEY_SHAPE = /AIza[0-9A-Za-z_-]{10,}/g;

/** Long enough to carry a quota message's tail, short enough to sit in a row on the queue page. */
const REASON_LIMIT = 240;

/**
 * The END of the message is kept rather than the start. An API refusal opens with the same generic
 * paragraph every time and puts the part that identifies it last: which quota, what the limit is,
 * how long to wait. Cutting from the front threw all three away and left the boilerplate.
 */
function redact(message: string): string {
  const clean = message.replace(API_KEY_SHAPE, '[redacted]').replace(/\s+/g, ' ').trim();
  return clean.length <= REASON_LIMIT ? clean : `... ${clean.slice(-REASON_LIMIT)}`;
}

function describe(error: unknown): string {
  return redact(error instanceof Error ? error.message : 'unknown failure');
}

export type Answer = { ok: true; value: unknown } | { ok: false; problem: string };

/**
 * Four failures used to arrive under one sentence, and the one that costs the most is invisible in
 * it: an answer cut off at the output token cap begins as valid JSON and simply never closes, which
 * reads as a model that misbehaved rather than as a budget nobody sized. A live run over a real
 * repository spent two of three briefs on that sentence with no way to tell which it meant.
 */
export function readAnswer(text: string): Answer {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, problem: 'the model returned nothing' };

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const size = `${trimmed.length} characters`;

  const start = candidate.indexOf('{');
  if (start === -1) return { ok: false, problem: `the answer was prose rather than JSON, ${size}` };

  const end = candidate.lastIndexOf('}');
  if (end <= start) {
    return {
      ok: false,
      problem: `the answer stopped before its JSON closed, ${size}, which is what the output token cap looks like`,
    };
  }

  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
  } catch {
    return { ok: false, problem: `the answer held JSON that would not parse, ${size}` };
  }
}

/** The narrow shape a caller that only wants the object uses. */
export function extractJson(text: string): unknown {
  const answer = readAnswer(text);
  return answer.ok ? answer.value : null;
}

type Attempt =
  { ok: true; payload: BriefPayload } | { ok: false; reason: string; retryAfterMs?: number | null };

async function runAttempt(
  request: BriefRequest,
  material: BriefMaterial,
  engine: BriefEngine,
  attempt: number,
): Promise<Attempt> {
  let text: string;
  try {
    text = await engine.generate(request, material, attempt);
  } catch (error) {
    const retryAfterMs = error instanceof ModelRefusal ? error.retryAfterMs : null;
    return { ok: false, reason: `attempt ${attempt}: ${describe(error)}`, retryAfterMs };
  }

  const answer = readAnswer(text);
  if (!answer.ok) return { ok: false, reason: `attempt ${attempt}: ${answer.problem}` };

  const parsed = briefPayloadSchema.safeParse(answer.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'payload';
    return {
      ok: false,
      reason: `attempt ${attempt}: ${where} ${issue?.message ?? 'failed validation'}`,
    };
  }

  return { ok: true, payload: parsed.data };
}

/**
 * Turns one candidate bump into a stored brief. A ready brief is cached by bump key and rubric
 * version, so a re-run over an unchanged bump costs no tokens. A failed one is deliberately NOT
 * cached: the usual cause is a rate limit or a truncated answer, and caching that would make one
 * bad minute permanent.
 */
export async function writeBrief(
  request: BriefRequest,
  options: WriteBriefOptions,
): Promise<BriefRecord> {
  const cacheKey = briefCacheKey(request.bumpKey, options.rubricVersion);
  const cached = await options.cache?.get(cacheKey);
  if (cached?.status === 'ready') return cached;

  const material = budgetMaterial(request, options.budget);
  const generatedAt = options.now.toISOString();
  const failures: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const outcome = await runAttempt(request, material, options.engine, attempt);
    if (!outcome.ok) {
      failures.push(outcome.reason);
      // A refused call names the wait it wants. Retrying inside it spends a second request on the
      // same limit and fails again, which is how one busy minute turned into two lost briefs.
      const asked = Math.min(outcome.retryAfterMs ?? 0, MAX_RETRY_WAIT_MS);
      if (asked > 0 && attempt < MAX_ATTEMPTS) await (options.wait ?? sleep)(asked);
      continue;
    }

    // A brief that speaks for this agent is not published with a label on it. It is not published.
    // The bump keeps its score and its verdict, and the body says the brief did not pass, which is
    // the same thing a reader is told when the model returns nothing at all. No retry: the cause is
    // the material rather than a bad minute, so a second attempt would spend two more of the day's
    // requests to be refused again. Not cached either, for the reason failures are never cached.
    const overstep = claimsAuthority(outcome.payload);
    if (overstep !== null) {
      return unavailableBrief({
        bumpKey: request.bumpKey,
        cacheKey,
        model: options.engine.model,
        rubricVersion: options.rubricVersion,
        generatedAt,
        attempts: attempt,
        truncated: material.truncated,
        reason: `the brief ${overstep}, which the rubric decides and the model does not`,
      });
    }

    const verified = verifyClaims(outcome.payload.breaksHere, {
      sites: request.usageSites,
      evidence: material.evidence,
      notesSource: material.releaseNotesSource,
    });

    const record: BriefRecord = {
      cacheKey,
      bumpKey: request.bumpKey,
      status: 'ready',
      model: options.engine.model,
      rubricVersion: options.rubricVersion,
      schemaVersion: BRIEF_SCHEMA_VERSION,
      generatedAt,
      attempts: attempt,
      truncated: material.truncated,
      droppedClaims: verified.dropped,
      reason: null,
      content: { ...outcome.payload, breaksHere: verified.claims },
    };

    await options.cache?.put(record);
    return record;
  }

  return unavailableBrief({
    bumpKey: request.bumpKey,
    cacheKey,
    model: options.engine.model,
    rubricVersion: options.rubricVersion,
    generatedAt,
    attempts: MAX_ATTEMPTS,
    truncated: material.truncated,
    reason: failures.join('; '),
  });
}
