import { z } from 'zod';
import type { UsageSite } from './types.js';

/**
 * Bumping this invalidates every cached brief, the same way the rubric version invalidates a score.
 * It belongs in the cache key rather than in a migration: a brief is cheap to recompute and
 * expensive to misread.
 */
export const BRIEF_SCHEMA_VERSION = '1.0.0';

/**
 * A closed schema with a length cap on every string. The agent reads release notes written by
 * strangers, so the output shape is the last place that untrusted text could arrive as something
 * other than data: there is no free-form object, no passthrough key, and nothing an instruction
 * could be smuggled through at unbounded length.
 */
export const claimSchema = z.strictObject({
  path: z.string().min(1).max(200),
  line: z.number().int().min(1).max(1_000_000),
  symbol: z.string().min(1).max(80),
  quote: z.string().min(1).max(400),
  source: z.string().min(1).max(300),
});

const briefShape = {
  headline: z.string().min(1).max(120),
  whatChanged: z.string().min(1).max(1500),
  breakingChanges: z.array(z.string().min(1).max(400)).max(12),
  breaksHere: z.array(claimSchema).max(12),
  migrationSteps: z.array(z.string().min(1).max(400)).max(12),
  confidence: z.enum(['high', 'medium', 'low']),
};

export const briefPayloadSchema = z.strictObject(briefShape);

/**
 * The same fields, handed to the agent framework, which converts them into the model's response
 * schema. Strictness has no meaning in that conversion, so the strict schema above stays the one
 * that parses the answer.
 */
export const briefModelSchema = z.object(briefShape);

export type BriefPayload = z.infer<typeof briefPayloadSchema>;
export type Claim = z.infer<typeof claimSchema>;

export interface VerifiedClaim extends Claim {
  /**
   * True when the file and line the model named is one the mechanical usage matcher also found.
   * A false claim is still shown, labelled, because a reader can judge it; it is never counted as
   * evidence.
   */
  verified: boolean;
}

export interface BriefContent {
  headline: string;
  whatChanged: string;
  breakingChanges: string[];
  breaksHere: VerifiedClaim[];
  migrationSteps: string[];
  confidence: 'high' | 'medium' | 'low';
}

export type BriefStatus = 'ready' | 'unavailable';

export interface BriefRecord {
  cacheKey: string;
  bumpKey: string;
  status: BriefStatus;
  model: string;
  rubricVersion: string;
  schemaVersion: string;
  generatedAt: string;
  attempts: number;
  /** Set when an input hit its budget, so a thin brief is never mistaken for a thorough one. */
  truncated: boolean;
  droppedClaims: number;
  reason: string | null;
  content: BriefContent | null;
}

export function briefCacheKey(bumpKey: string, rubricVersion: string): string {
  return `${bumpKey}|rubric=${rubricVersion}|schema=${BRIEF_SCHEMA_VERSION}`;
}

/** Backticks and quote marks travel differently through a model than through a changelog. */
const QUOTE_MARKS = /[`'"\u2018\u2019\u201c\u201d]/g;

function normalize(text: string): string {
  return text.toLowerCase().replace(QUOTE_MARKS, '').replace(/\s+/g, ' ').trim();
}

export interface ClaimGround {
  /** Call sites the mechanical matcher found in the repository. */
  sites: UsageSite[];
  /** Release notes, commit subjects and diff text the agent was given, joined. */
  evidence: string;
}

export interface VerifiedClaims {
  claims: VerifiedClaim[];
  dropped: number;
}

/**
 * The model may only report what the evidence already says. A quote that is not in the material it
 * was given is dropped outright rather than labelled, because an invented quotation reads as proof
 * and is the one failure a reader cannot catch by eye.
 */
export function verifyClaims(claims: Claim[], ground: ClaimGround): VerifiedClaims {
  const haystack = normalize(ground.evidence);
  const known = new Set(ground.sites.map((site) => `${site.path}:${site.line}`));

  const kept: VerifiedClaim[] = [];
  let dropped = 0;

  for (const claim of claims) {
    const quote = normalize(claim.quote);
    if (quote.length === 0 || !haystack.includes(quote)) {
      dropped += 1;
      continue;
    }
    kept.push({ ...claim, verified: known.has(`${claim.path}:${claim.line}`) });
  }

  return { claims: kept, dropped };
}

export interface UnavailableBriefInput {
  bumpKey: string;
  cacheKey: string;
  model: string;
  rubricVersion: string;
  generatedAt: string;
  attempts: number;
  truncated: boolean;
  reason: string;
}

export function unavailableBrief(input: UnavailableBriefInput): BriefRecord {
  return {
    cacheKey: input.cacheKey,
    bumpKey: input.bumpKey,
    status: 'unavailable',
    model: input.model,
    rubricVersion: input.rubricVersion,
    schemaVersion: BRIEF_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    attempts: input.attempts,
    truncated: input.truncated,
    droppedClaims: 0,
    reason: input.reason,
    content: null,
  };
}
