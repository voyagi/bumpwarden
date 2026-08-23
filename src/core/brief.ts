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
const CAP = {
  headline: 120,
  whatChanged: 1500,
  line: 400,
  items: 12,
  claimPath: 200,
  claimSymbol: 80,
  claimQuote: 400,
  claimSource: 300,
} as const;

export const claimSchema = z.strictObject({
  path: z.string().min(1).max(CAP.claimPath),
  line: z.number().int().min(1).max(1_000_000),
  symbol: z.string().min(1).max(CAP.claimSymbol),
  quote: z.string().min(1).max(CAP.claimQuote),
  source: z.string().min(1).max(CAP.claimSource),
});

const briefShape = {
  headline: z.string().min(1).max(CAP.headline),
  whatChanged: z.string().min(1).max(CAP.whatChanged),
  breakingChanges: z.array(z.string().min(1).max(CAP.line)).max(CAP.items),
  breaksHere: z.array(claimSchema).max(CAP.items),
  migrationSteps: z.array(z.string().min(1).max(CAP.line)).max(CAP.items),
  confidence: z.enum(['high', 'medium', 'low']),
};

/**
 * The longest answer this schema calls legal, in characters. It exists so the model's output token
 * budget can be checked against it: a budget too small to hold a legitimate brief cuts the answer
 * off mid-JSON, and that arrives looking like a model that misbehaved rather than a cap nobody
 * sized. Field names, punctuation and escaping are the flat allowance on the end.
 */
export const BRIEF_MAX_CHARS =
  CAP.headline +
  CAP.whatChanged +
  CAP.items * CAP.line * 2 +
  CAP.items * (CAP.claimPath + CAP.claimSymbol + CAP.claimQuote + CAP.claimSource) +
  400;

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

/**
 * The model explains a release. It decides nothing, and it must not sound as though it had. A
 * changelog is written by whoever publishes the package and reaches the model inside the prompt,
 * so a model that follows one can produce prose that speaks in this agent's name, announces an
 * approval the rubric owns, or tells a reader to merge without looking. The score was already safe
 * from all three. A person skimming an issue this agent signed was not.
 *
 * Each pattern is narrow on purpose, and the comment on each says what it must NOT catch, because
 * the cost of a false positive is a bump losing its explanation. "No breaking changes in this
 * release", "merge the upstream branch first" and "the server fails without reading its config"
 * are all ordinary things for a brief to say.
 */
const AUTHORITY_CLAIMS: ReadonlyArray<readonly [string, RegExp]> = [
  // The model is asked about a dependency release and never about this tool, so its name appearing
  // in the model's own words has no innocent reading.
  ['spoke in the name of bumpwarden', /\bbumpwarden\b/i],
  // An approval is a verdict, and the verdict is arithmetic over the published rubric. Anchored to
  // an action so that "safe for older consumers" and "ready for testing" are left alone.
  [
    'announced the bump approved',
    /\b(safe|cleared|approved|fine|ready|good)\s+to\s+(merge|deploy|ship|upgrade)\b/i,
  ],
  // Anchored to an instruction about this bump, so "the maintainers merged #4821" is left alone.
  [
    'told the reader to merge',
    /\bmerge\s+(?:this\s+|it\s+)?(?:now|immediately|at once|without)\b/i,
  ],
  ['told the reader to merge', /\b(?:you can|feel free to|go ahead and)\s+merge\b/i],
  // Anchored to the reading of the brief itself, not to reading in general.
  ['told the reader not to read it', /\bwithout\s+reading\s+(?:it|this|further|the brief)\b/i],
  ['told the reader not to read it', /\bno need to (?:read|review)\b|\bskip the review\b/i],
];

/**
 * Answers with the fixed phrase naming what the brief did, or null. Deliberately never returns any
 * of the model's own words: the answer is stored on the record and rendered into an issue, and
 * echoing the text back would put the thing being rejected in front of the reader anyway.
 *
 * Checked against the model's prose only, never against a verified quote. A quote has to appear
 * verbatim in the material, so checking those would hand any package author a way to suppress
 * every brief about their release by naming this tool once in a changelog.
 */
export function claimsAuthority(content: BriefPayload): string | null {
  const prose = [
    content.headline,
    content.whatChanged,
    ...content.breakingChanges,
    ...content.migrationSteps,
  ].join('\n');

  for (const [named, pattern] of AUTHORITY_CLAIMS) {
    if (pattern.test(prose)) return named;
  }
  return null;
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
