import {
  BRIEF_SCHEMA_VERSION,
  briefCacheKey,
  briefPayloadSchema,
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

export interface BriefEngine {
  readonly model: string;
  /** One attempt. Returns the model's final text; throws only on a transport or quota failure. */
  generate(request: BriefRequest, material: BriefMaterial, attempt: number): Promise<string>;
}

export interface BriefCache {
  get(cacheKey: string): Promise<BriefRecord | null>;
  put(record: BriefRecord): Promise<void>;
}

export interface WriteBriefOptions {
  engine: BriefEngine;
  rubricVersion: string;
  now: Date;
  cache?: BriefCache | null;
  budget?: BriefBudget;
}

/** One retry, then the bump carries "brief unavailable" and the score stands on its own. */
const MAX_ATTEMPTS = 2;

const API_KEY_SHAPE = /AIza[0-9A-Za-z_-]{10,}/g;

function redact(message: string): string {
  return message.replace(API_KEY_SHAPE, '[redacted]').slice(0, 200);
}

function describe(error: unknown): string {
  return redact(error instanceof Error ? error.message : 'unknown failure');
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

type Attempt = { ok: true; payload: BriefPayload } | { ok: false; reason: string };

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
    return { ok: false, reason: `attempt ${attempt}: ${describe(error)}` };
  }

  const json = extractJson(text);
  if (json === null)
    return { ok: false, reason: `attempt ${attempt}: no JSON object in the answer` };

  const parsed = briefPayloadSchema.safeParse(json);
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
      continue;
    }

    const verified = verifyClaims(outcome.payload.breaksHere, {
      sites: request.usageSites,
      evidence: material.evidence,
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
