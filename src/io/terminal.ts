/**
 * A terminal executes what it is handed. Text this agent reads from somewhere else -- a dependency
 * key in a stranger's package.json, a version string in their lockfile, a registry error, prose a
 * model wrote from a publisher's release notes -- reaches the operator's screen through the command
 * line tools, and an escape sequence in it can move the cursor back over the verdict rows already
 * printed and rewrite them. A held bump made to read `green` on screen while the stored record
 * still says `red` defeats the one thing this product exists to do.
 *
 * Every control character is written out as visible text instead: the reader sees `\x1b` where the
 * escape was, and the terminal is handed nothing to act on. The C1 range is included because an
 * eight-bit terminal reads 0x9b as a control sequence introducer with no escape in front of it, so
 * a filter watching only for 0x1b lets it through.
 */

/** The high end of the C1 range, which an eight-bit terminal reads as an introducer. */
const C1_LAST = 0x9f;
const C1_FIRST = 0x80;
const C0_LAST = 0x1f;
const DEL = 0x7f;
const LINE_FEED = 0x0a;

function isControl(code: number): boolean {
  return code <= C0_LAST || code === DEL || (code >= C1_FIRST && code <= C1_LAST);
}

function escaped(code: number): string {
  return '\\x' + code.toString(16).padStart(2, '0');
}

function neutralise(text: string, keepLineFeed: boolean): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (keepLineFeed && code === LINE_FEED) {
      out += character;
      continue;
    }
    out += isControl(code) ? escaped(code) : character;
  }
  return out;
}

/**
 * One row of a report. Line breaks are neutralised along with everything else, because a row that
 * can gain a line can gain a whole fabricated verdict row rather than merely rewriting one.
 *
 * `maxChars` is for values with no schema behind them -- a dependency key or a registry message
 * copied out of a repository this operator does not own. Do not pass it for a model field: those
 * are already bounded by the brief schema, and a cap below their real maximum cuts legitimate
 * output. The cut is always stated rather than silent.
 */
export function safeForTerminal(text: string, maxChars?: number): string {
  const written = neutralise(text, false);
  if (maxChars === undefined) return written;

  // Measured on what is written, not on what arrived. Each control character becomes four
  // characters on screen, so a value of nothing but escapes would sit under a cap applied to the
  // input and still spend four times the room the cap promises.
  //
  // Counted and cut by character rather than by code unit, so an emoji at the boundary is not
  // left as half of itself, and the number is the number the sentence beside it claims.
  const characters = [...written];
  if (characters.length <= maxChars) return written;

  const hidden = characters.length - maxChars;
  return `${characters.slice(0, maxChars).join('')} ... [+${hidden} characters not shown]`;
}

/**
 * What a value with no schema behind it is allowed to spend on screen. A dependency key or a
 * registry message is whatever a stranger's repository says it is, and a manifest can name a
 * megabyte. Model fields are not capped here: the brief schema already bounds them, and a cap
 * below their real maximum cuts a legitimate migration list.
 */
export const UNBOUNDED_FIELD_CAP = 500;

/**
 * The prefix on every line of a quoted block. Deliberately a shape no row these tools print
 * themselves uses: they start at column zero, two spaces or four, so a planted line cannot sit
 * where a real one does however many newlines it carries.
 */
export const BLOCK_PREFIX = '  | ';

/**
 * A block of prose the reader is meant to read as prose. Line feeds survive, so paragraphs and
 * lists stay legible, and every line carries the prefix so none of them can pass for an output row.
 * Everything else a terminal would act on is still written out as text.
 */
export function safeBlockForTerminal(text: string): string {
  return neutralise(text, true)
    .split('\n')
    .map((line) => `${BLOCK_PREFIX}${line}`)
    .join('\n');
}
