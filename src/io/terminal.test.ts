import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_PREFIX,
  UNBOUNDED_FIELD_CAP,
  safeBlockForTerminal,
  safeForTerminal,
} from './terminal.js';

/** Built by code rather than typed, so no escape literal can materialise into this file. */
const ESC = String.fromCharCode(0x1b);
const CSI_8BIT = String.fromCharCode(0x9b);
const DEL = String.fromCharCode(0x7f);

describe('text from somebody else, on the way to a terminal', () => {
  it('leaves ordinary text exactly as it was', () => {
    const plain = 'express 4.18.2 -> 5.2.1 (major)';
    expect(safeForTerminal(plain)).toBe(plain);
  });

  it('writes out the escape a forged verdict row would need', () => {
    const forged = `${ESC}[3A${ESC}[2K  62 green express 4.18.2 -> 5.2.1`;
    const safe = safeForTerminal(forged);
    expect(safe).not.toContain(ESC);
    expect(safe).toContain('\\x1b');
  });

  it('writes out the eight-bit introducer a filter watching for ESC would miss', () => {
    expect(safeForTerminal(`${CSI_8BIT}[2K`)).toBe('\\x9b[2K');
  });

  it('writes out DEL and a carriage return', () => {
    expect(safeForTerminal(`a${DEL}b\rc`)).toBe('a\\x7fb\\x0dc');
  });

  it('keeps a row to one line, so planted text cannot forge a second one', () => {
    const safe = safeForTerminal('62 green express\n  1 red lodash');
    expect(safe).not.toContain('\n');
    expect(safe).toContain('\\x0a');
  });

  it('states the cut rather than trimming in silence', () => {
    const long = 'x'.repeat(UNBOUNDED_FIELD_CAP + 40);
    const safe = safeForTerminal(long, UNBOUNDED_FIELD_CAP);
    expect(safe).toContain('[+40 characters not shown]');
  });

  /**
   * The cap is a limit on room taken on screen, and each control character takes four characters
   * once it is written out. Measuring the value that arrived rather than the one that is printed
   * would let a string of nothing but escapes sit under the cap and spend four times the room.
   */
  it('holds the cap against what is printed, not what arrived', () => {
    const escapes = ESC.repeat(UNBOUNDED_FIELD_CAP);
    const safe = safeForTerminal(escapes, UNBOUNDED_FIELD_CAP);
    expect(safe).toContain('characters not shown');
    expect([...safe].length).toBeLessThan(UNBOUNDED_FIELD_CAP + 40);
  });

  it('counts and cuts by character, so one is never left as half of itself', () => {
    // An astral character is two code units, so a cut that counted units would split the last one
    // and report a number that did not match the word beside it.
    const astral = '\u{1F600}'.repeat(UNBOUNDED_FIELD_CAP + 5);
    const safe = safeForTerminal(astral, UNBOUNDED_FIELD_CAP);
    expect(safe).toContain('[+5 characters not shown]');
    // Exactly the characters it said it kept, every one of them whole. A lone half would show up
    // here as a count one short, and as an unpaired code unit in the string.
    expect([...safe].filter((character) => character === '\u{1F600}')).toHaveLength(
      UNBOUNDED_FIELD_CAP,
    );
    expect(safe).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it('does not cut a value no cap was asked for', () => {
    // A migration list is twelve steps of up to 400 characters. Joined, it runs past any cap that
    // was sized against a single field, and every character of it is output the operator asked to
    // read, so the tools must not pass a cap for it.
    const steps = Array.from({ length: 12 }, () => 'y'.repeat(400)).join('\n');
    expect(steps.length).toBeGreaterThan(UNBOUNDED_FIELD_CAP);
    expect(safeForTerminal(steps)).not.toContain('not shown');
    expect(safeBlockForTerminal(steps)).not.toContain('not shown');
  });
});

describe('a block of prose the operator is meant to read', () => {
  it('keeps paragraphs and list items on their own lines', () => {
    const prose = 'The router moved.\n\n- res.sendfile is gone\n- res.sendFile replaces it';
    const lines = safeBlockForTerminal(prose).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe(`${BLOCK_PREFIX}- res.sendfile is gone`);
  });

  it('still writes out an escape inside the prose', () => {
    expect(safeBlockForTerminal(`a${ESC}[2Kb`)).toBe(`${BLOCK_PREFIX}a\\x1b[2Kb`);
  });

  /**
   * The rows these tools print themselves start at column zero, two spaces or four. A planted line
   * must not be able to sit where one of those does, however many newlines it carries.
   */
  it('gives every line a prefix no row of our own uses', () => {
    const planted = 'ok\n  62 green express 4.18.2 -> 5.2.1\n    "quoted"';
    for (const line of safeBlockForTerminal(planted).split('\n')) {
      expect(line.startsWith(BLOCK_PREFIX)).toBe(true);
    }
    expect(['', '  ', '    ']).not.toContain(BLOCK_PREFIX);
  });
});

/**
 * The finding was one unguarded print, but the class is every value these tools read from
 * somewhere else. This fails closed: an interpolation that is neither guarded nor listed here as
 * built by our own code fails the test, so a new field cannot be added unguarded in silence.
 */
describe('every value the tools interpolate', () => {
  const TOOLS = ['../tools/dryrun/main.ts', '../tools/demo/main.ts', '../smoke/main.ts'];

  /**
   * The names a value can be interpolated under without a guard, because our own code decides it:
   * a count, a flag, a version constant, an argv word, or a value already wrapped further up.
   * Anything not on this list has to be wrapped or added here deliberately, which is the point.
   */
  const OURS = new Set([
    // What a wrapped interpolation is left as once its guard has been lifted out.
    'GUARDED',
    'REPO',
    'RUBRIC_VERSION',
    'USAGE',
    "absent.join(' or ')",
    'action.kind',
    'action.ruleId',
    "apiKey ? 'gemini' : 'disabled, no GEMINI_API_KEY'",
    'brief.attempts',
    'brief.droppedClaims',
    'brief.model',
    'brief.status',
    'brief.truncated',
    'bump.brief.status',
    'bump.score.band.padEnd(5)',
    'bumps.length',
    "claim.verified ? 'verified' : 'unverified'",
    'claim.line',
    'considered',
    'content.breaksHere.length',
    'content.confidence',
    'engine.model',
    'entry',
    // A rubric factor id, one of the fixed identifiers the published rubric defines.
    'factor.id',
    'files.length',
    'flag',
    'gaps.length',
    'id',
    'ingest.dependenciesConsidered',
    'mark',
    'megabytes',
    'message',
    'missing.length',
    'move',
    'owner',
    'prefix',
    "process.env.GITHUB_TOKEN ? 'authenticated' : 'anonymous'",
    'projectId',
    '(paced / 1000).toFixed(1)',
    '(engine.pacer.waited() / 1000).toFixed(1)',
    'reads.cacheHits',
    'reads.calls',
    'repo',
    'ruleFor(score.band).id',
    'ruleFor(score.band).kind',
    'run.actionsTaken',
    'run.counts.amber',
    'run.counts.green',
    'run.counts.red',
    'run.id',
    'score.band.padEnd(5)',
    'scored.length',
    'seconds',
    'sources.files.length',
    'stats.cacheHits',
    'stats.calls',
    'String(bump.score.total).padStart(3)',
    'String(factor.points).padStart(2)',
    'String(score.total).padStart(3)',
  ]);

  /** Removes each guarded call whole, so what it wraps is not read as if it were bare. */
  function withoutGuards(source: string): string {
    let out = source;
    for (const guard of ['safeForTerminal(', 'safeBlockForTerminal(']) {
      for (;;) {
        const start = out.indexOf(guard);
        if (start === -1) break;
        let depth = 0;
        let end = start + guard.length - 1;
        for (; end < out.length; end += 1) {
          if (out[end] === '(') depth += 1;
          else if (out[end] === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        out = `${out.slice(0, start)}GUARDED${out.slice(end + 1)}`;
      }
    }
    return out;
  }

  for (const tool of TOOLS) {
    it(`is guarded or built by us in ${tool}`, () => {
      const source = readFileSync(fileURLToPath(new URL(tool, import.meta.url)), 'utf8');
      const bare = withoutGuards(source);
      const found = [...bare.matchAll(/\$\{([^{}]*)\}/g)].map((match) => (match[1] ?? '').trim());

      expect(found.length).toBeGreaterThan(0);
      expect(found.filter((expression) => !OURS.has(expression))).toEqual([]);
    });
  }
});
