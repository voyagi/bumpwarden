export type Severity = 'INFO' | 'WARNING' | 'ERROR';

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const REDACTED = '[redacted]';

/**
 * Field names whose value is a credential whatever it looks like, so the shape is never consulted.
 * Deliberately not a bare `key`: a bump key is the identifier every audit line is searched by, and
 * redacting it would cost more than it protects. A credential stored under that name is still
 * caught by shape below.
 */
const SECRET_KEY = /token|secret|password|credential|authorization|api[_-]?key/i;

/**
 * Shapes this service actually handles: a classic GitHub token, a fine-grained one, a Google API
 * key, and an Authorization header. A value is redacted on shape alone because credentials travel
 * inside strings that are not named like credentials: an SDK error message, a URL, a stack frame.
 */
const SECRET_VALUE = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g,
];

export function scrubText(text: string): string {
  return SECRET_VALUE.reduce((carry, pattern) => carry.replace(pattern, REDACTED), text);
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  // A depth cap rather than a seen-set: log fields are small by construction, and a cycle must end
  // as a marker in the line rather than as a thrown error inside a logging call.
  if (depth >= 6) return '[deep]';
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message) };
  }
  return redactFields(value as LogFields, depth + 1);
}

export function redactFields(fields: LogFields, depth = 0): LogFields {
  const output: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(value, depth);
  }
  return output;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  now?: () => Date;
}

/**
 * One JSON object per line, because that is what Cloud Run's logging agent parses: `severity` and
 * `message` become the log entry's own fields and everything else stays queryable beside them. The
 * writer is injected so a test reads the exact line rather than capturing the process streams.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const emit = (severity: Severity, message: string, fields: LogFields = {}): void => {
    const entry = {
      severity,
      message: scrubText(message),
      time: now().toISOString(),
      ...redactFields(fields),
    };

    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ severity, message: scrubText(message), time: entry.time });
    }
    write(line);
  };

  return {
    info: (message, fields) => emit('INFO', message, fields),
    warn: (message, fields) => emit('WARNING', message, fields),
    error: (message, fields) => emit('ERROR', message, fields),
  };
}

export const log = createLogger();

/** For callers that take a logger but must stay quiet, which is every test that drives a run. */
export const silentLogger: Logger = createLogger({ write: () => undefined });
