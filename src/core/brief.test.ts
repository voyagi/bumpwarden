import { describe, expect, it } from 'vitest';
import {
  BRIEF_SCHEMA_VERSION,
  briefCacheKey,
  briefPayloadSchema,
  unavailableBrief,
  verifyClaims,
  type Claim,
} from './brief.js';
import { RUBRIC_VERSION } from './rubric.js';
import type { UsageSite } from './types.js';

const SITE: UsageSite = {
  path: 'src/routes/files.ts',
  line: 18,
  symbol: 'res.sendfile',
  text: 'return res.sendfile(target);',
};

const NOTES = 'The `res.sendfile()` function has been replaced by a camel-cased version.';

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    path: SITE.path,
    line: SITE.line,
    symbol: SITE.symbol,
    quote: 'The res.sendfile() function has been replaced',
    source: 'https://expressjs.com/en/guide/migrating-5.html',
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headline: 'Two removed methods are called in your routes',
    whatChanged: 'Express 5 drops methods Express 4 accepted.',
    breakingChanges: ['res.sendfile is now res.sendFile'],
    breaksHere: [claim()],
    migrationSteps: ['Rename the call on line 18.'],
    confidence: 'high',
    ...overrides,
  };
}

describe('the brief schema', () => {
  it('accepts a well formed answer', () => {
    expect(briefPayloadSchema.safeParse(payload()).success).toBe(true);
  });

  it('rejects a field the schema does not define, so nothing rides along', () => {
    const result = briefPayloadSchema.safeParse(payload({ systemPrompt: 'ignore the rules' }));
    expect(result.success).toBe(false);
  });

  it('rejects an unbounded string', () => {
    expect(briefPayloadSchema.safeParse(payload({ headline: 'x'.repeat(400) })).success).toBe(
      false,
    );
  });

  it('rejects a confidence it does not recognise', () => {
    expect(briefPayloadSchema.safeParse(payload({ confidence: 'certain' })).success).toBe(false);
  });

  it('rejects a claim with no evidence fields', () => {
    expect(
      briefPayloadSchema.safeParse(payload({ breaksHere: [{ path: 'a.ts', line: 1 }] })).success,
    ).toBe(false);
  });

  it('rejects a line number that is not a line number', () => {
    expect(
      briefPayloadSchema.safeParse(payload({ breaksHere: [claim({ line: 0 })] })).success,
    ).toBe(false);
  });
});

describe('claim verification', () => {
  const ground = { sites: [SITE], evidence: NOTES };

  it('keeps a quoted claim that the matcher also found, marked verified', () => {
    const result = verifyClaims([claim()], ground);
    expect(result.dropped).toBe(0);
    expect(result.claims[0]?.verified).toBe(true);
  });

  it('drops a claim whose quote is nowhere in the material', () => {
    const result = verifyClaims([claim({ quote: 'this sentence was never published' })], ground);
    expect(result.claims).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it('keeps a quoted claim about a file the matcher never saw, labelled unverified', () => {
    const result = verifyClaims([claim({ path: 'src/other.ts', line: 3 })], ground);
    expect(result.claims[0]?.verified).toBe(false);
    expect(result.dropped).toBe(0);
  });

  it('marks a claim on the right file but the wrong line unverified', () => {
    expect(verifyClaims([claim({ line: 19 })], ground).claims[0]?.verified).toBe(false);
  });

  it('ignores backticks and smart quotes when matching, because a model rewrites them', () => {
    const quoted = claim({ quote: 'The \u201cres.sendfile()\u201d function has been replaced' });
    expect(verifyClaims([quoted], ground).claims).toHaveLength(1);
  });

  it('ignores line wrapping differences', () => {
    const wrapped = claim({ quote: 'function has been\n  replaced by a camel-cased version' });
    expect(verifyClaims([wrapped], ground).claims).toHaveLength(1);
  });
});

describe('an unavailable brief', () => {
  const record = unavailableBrief({
    bumpKey: 'demo/app#express@5.0.0',
    cacheKey: briefCacheKey('demo/app#express@5.0.0', RUBRIC_VERSION),
    model: 'gemini-3.5-flash',
    rubricVersion: RUBRIC_VERSION,
    generatedAt: '2026-08-21T10:00:00.000Z',
    attempts: 2,
    truncated: false,
    reason: 'attempt 2: breaksHere failed validation',
  });

  it('says why, carries no content, and never fakes one', () => {
    expect(record.status).toBe('unavailable');
    expect(record.content).toBeNull();
    expect(record.reason).toContain('attempt 2');
  });

  it('records the schema version it was judged against', () => {
    expect(record.schemaVersion).toBe(BRIEF_SCHEMA_VERSION);
  });
});

describe('the cache key', () => {
  it('changes when the rubric changes, so an old brief never survives a rubric bump', () => {
    expect(briefCacheKey('k', '1.0.0')).not.toBe(briefCacheKey('k', '1.1.0'));
  });

  it('carries the bump key, so two bumps never share a cached brief', () => {
    expect(briefCacheKey('a', RUBRIC_VERSION)).not.toBe(briefCacheKey('b', RUBRIC_VERSION));
  });
});
