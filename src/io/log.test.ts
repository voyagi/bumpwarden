import { describe, expect, it } from 'vitest';
import { createLogger, redactFields, scrubText } from './log.js';

// Assembled rather than written out: a literal credential shape in a repository is what secret
// scanners are for, and a fixture that trips one teaches the next reader to ignore the scanner.
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const FINE_GRAINED = `github_pat_${'1'.repeat(22)}_${'x'.repeat(20)}`;
const GOOGLE_KEY = `AIza${'Sy'.repeat(10)}_abcdefghij`;

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    write: (line) => lines.push(line),
    now: () => new Date('2026-08-21T20:00:00.000Z'),
  });
  return { lines, logger };
}

describe('createLogger', () => {
  it('writes one parseable JSON object per call, with the fields Cloud Run reads', () => {
    const { lines, logger } = capture();
    logger.info('run finished', { runId: 'run-1', actions: 3 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      severity: 'INFO',
      message: 'run finished',
      time: '2026-08-21T20:00:00.000Z',
      runId: 'run-1',
      actions: 3,
    });
  });

  it('grades warnings and errors so a search on severity finds them', () => {
    const { lines, logger } = capture();
    logger.warn('degraded');
    logger.error('failed');

    expect(lines.map((line) => JSON.parse(line).severity)).toEqual(['WARNING', 'ERROR']);
  });

  it('keeps a credential out of the line whatever field it arrives in', () => {
    const { lines, logger } = capture();
    logger.error('github write failed', {
      githubToken: GITHUB_TOKEN,
      request: { headers: { authorization: `Bearer ${GITHUB_TOKEN}` } },
      detail: `401 for https://api.github.com with ${GITHUB_TOKEN}`,
    });

    expect(lines[0]).not.toContain(GITHUB_TOKEN);
    const entry = JSON.parse(lines[0] as string);
    expect(entry.githubToken).toBe('[redacted]');
    expect(entry.request.headers.authorization).toBe('[redacted]');
    expect(entry.detail).toBe('401 for https://api.github.com with [redacted]');
  });

  it('redacts a credential nested in an array of objects', () => {
    const { lines, logger } = capture();
    logger.info('sources', { missing: [{ what: 'auth', why: `key ${GOOGLE_KEY} rejected` }] });

    expect(lines[0]).not.toContain(GOOGLE_KEY);
  });

  it('redacts a credential in the message itself', () => {
    const { lines, logger } = capture();
    logger.error(`boot failed: ${FINE_GRAINED} is not a token`);

    expect(lines[0]).not.toContain(FINE_GRAINED);
  });

  it('reduces an Error to its name and message, never a stack full of paths', () => {
    const { lines, logger } = capture();
    logger.error('run failed', { error: new TypeError(`bad token ${GITHUB_TOKEN}`) });

    const entry = JSON.parse(lines[0] as string);
    expect(entry.error).toEqual({ name: 'TypeError', message: 'bad token [redacted]' });
  });

  it('still writes a line when a field cannot be serialized', () => {
    const { lines, logger } = capture();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(() => logger.info('cyclic', { cycle })).not.toThrow();
    expect(JSON.parse(lines[0] as string).message).toBe('cyclic');
  });

  it('stringifies a bigint rather than throwing inside the logging call', () => {
    const { lines, logger } = capture();
    logger.info('counted', { total: 9007199254740993n });

    expect(JSON.parse(lines[0] as string).total).toBe('9007199254740993');
  });
});

describe('redactFields', () => {
  it('leaves the bump key readable, because every audit trail is searched by it', () => {
    expect(redactFields({ key: 'voyagi/demo:express:5.2.1' })).toEqual({
      key: 'voyagi/demo:express:5.2.1',
    });
  });

  it('marks a deeply nested object rather than walking it forever', () => {
    let node: Record<string, unknown> = { end: true };
    for (let i = 0; i < 10; i += 1) node = { next: node };

    expect(JSON.stringify(redactFields(node))).toContain('[deep]');
  });
});

describe('scrubText', () => {
  it('passes ordinary prose through untouched', () => {
    const text = 'no release notes for 13.0.6 under either tag spelling';
    expect(scrubText(text)).toBe(text);
  });
});
