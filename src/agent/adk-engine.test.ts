import { describe, expect, it } from 'vitest';
import { BRIEF_MAX_CHARS } from '../core/brief.js';
import { BRIEF_MODEL } from '../core/stack.js';
import { DEFAULT_BRIEF_MODEL, MAX_OUTPUT_TOKENS, retryDelayFrom } from './adk-engine.js';

/**
 * Verbatim, from a live 429 on 2026-08-21. It is the only place the free tier states its own limit,
 * and the only place the wait is written down, so the parser is measured against the real sentence
 * rather than a tidied one.
 */
const LIVE_429 =
  'You exceeded your current quota, please check your plan and billing details. For more ' +
  'information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To ' +
  'monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for ' +
  'metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, ' +
  'model: gemini-3.5-flash\nPlease retry in 10.554422839s.';

/**
 * A conservative floor for JSON in English. Real text runs nearer four characters per token, so
 * measuring against three leaves the budget room to be wrong in the safe direction.
 */
const CHARS_PER_TOKEN = 3;

describe('the brief the model is asked for', () => {
  it('has room in the output budget for the longest answer the schema allows', () => {
    expect(MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN).toBeGreaterThanOrEqual(BRIEF_MAX_CHARS);
  });

  it('asks for the model the About page names', () => {
    expect(DEFAULT_BRIEF_MODEL).toBe(BRIEF_MODEL);
  });
});

describe('the wait a refused call asks for', () => {
  it('reads it out of the sentence the API actually sends, rounded up to a whole millisecond', () => {
    expect(retryDelayFrom(LIVE_429)).toBe(10_555);
  });

  it('has nothing to report when the refusal named no wait', () => {
    expect(retryDelayFrom('You exceeded your current quota.')).toBeNull();
    expect(retryDelayFrom('')).toBeNull();
    expect(retryDelayFrom('retry in 0s')).toBeNull();
  });
});
