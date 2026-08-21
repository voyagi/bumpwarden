import type { ReleaseEvidence, UsageMatch, UsageSite } from './types.js';

export interface SourceFile {
  path: string;
  text: string;
}

export interface UsageResult {
  match: UsageMatch;
  symbols: string[];
  sites: UsageSite[];
}

const CODE_SPAN = /`([^`\n]{2,60})`/g;
const REMOVAL_SUBJECT = /\b(?:removed|renamed|dropped|replaced)\s+`?([A-Za-z_$][\w$.]{2,40})`?/gi;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Words that appear inside code spans constantly and would match every file if treated as API. */
const TOO_COMMON = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'function',
  'const',
  'let',
  'var',
  'default',
  'node',
  'npm',
  'main',
  'type',
  'types',
  'module',
  'index',
  'error',
  'options',
  'config',
]);

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function acceptable(candidate: string): boolean {
  const head = candidate.split('.')[0] ?? '';
  return (
    IDENTIFIER.test(candidate) &&
    candidate.length >= 3 &&
    !TOO_COMMON.has(candidate.toLowerCase()) &&
    !TOO_COMMON.has(head.toLowerCase())
  );
}

/**
 * Names the release evidence says changed. Deliberately mechanical: code spans and a short list of
 * removal verbs, nothing inferred. The model refines the wording of a brief later, but this list is
 * what the score is computed from, so it has to be reproducible from the text alone.
 */
export function changedSymbols(release: ReleaseEvidence): string[] {
  const text = [release.notes ?? '', ...release.commitSubjects].join('\n');
  const found = new Set<string>();

  for (const match of text.matchAll(CODE_SPAN)) {
    // Release notes name a method with its call shape, `req.param(name)`. The argument list is
    // documentation, not part of the symbol, so it is dropped before the identifier check.
    const cleaned = (match[1] ?? '').trim().replace(/\([^)]*\)$/, '');
    if (acceptable(cleaned)) found.add(cleaned);
  }
  for (const match of text.matchAll(REMOVAL_SUBJECT)) {
    const name = match[1] ?? '';
    if (acceptable(name)) found.add(name);
  }

  return [...found];
}

export function importsPackage(file: SourceFile, packageName: string): boolean {
  const name = escapeForRegex(packageName);
  const specifier = `['"]${name}(?:/[^'"]*)?['"]`;
  const pattern = new RegExp(
    `(?:from\\s+${specifier}|require\\(\\s*${specifier}|import\\(\\s*${specifier})`,
  );
  return pattern.test(file.text);
}

function sitesForSymbol(file: SourceFile, symbol: string): UsageSite[] {
  const pattern = new RegExp(`\\b${escapeForRegex(symbol)}\\b`);
  const sites: UsageSite[] = [];

  file.text.split('\n').forEach((line, index) => {
    if (pattern.test(line)) {
      sites.push({ path: file.path, line: index + 1, symbol, text: line.trim().slice(0, 160) });
    }
  });

  return sites;
}

export function classifyUsage(
  packageName: string,
  release: ReleaseEvidence,
  files: SourceFile[],
): UsageResult {
  const importers = files.filter((file) => importsPackage(file, packageName));
  const symbols = changedSymbols(release);

  if (importers.length === 0) {
    return { match: 'unused', symbols, sites: [] };
  }

  const sites = importers.flatMap((file) =>
    symbols.flatMap((symbol) => sitesForSymbol(file, symbol)),
  );

  return {
    match: sites.length > 0 ? 'changed-symbol' : 'package-only',
    symbols,
    sites,
  };
}
