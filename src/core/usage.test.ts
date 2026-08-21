import { describe, expect, it } from 'vitest';
import { changedSymbols, classifyUsage, importsPackage } from './usage.js';
import type { ReleaseEvidence } from './types.js';

const EXPRESS_NOTES: ReleaseEvidence = {
  notes: [
    '## Removed methods and properties',
    'The `res.sendfile()` function has been replaced by a camel-cased version `res.sendFile()`.',
    'Express 5 no longer supports the `app.del()` function.',
    'This potentially confusing and dangerous method of retrieving form data has been removed: `req.param(name)`.',
  ].join('\n'),
  notesSource: 'expressjs.com migration guide',
  commitSubjects: [],
};

const ROUTE_FILE = {
  path: 'src/routes/files.ts',
  text: [
    "import express from 'express';",
    '',
    'export const router = express.Router();',
    '',
    "router.get('/:name', (req, res) => {",
    '  res.sendfile(resolve(req.params.name));',
    '});',
  ].join('\n'),
};

function spanNotes(text: string): ReleaseEvidence {
  return { notes: text, notesSource: 'CHANGELOG.md', commitSubjects: [] };
}

describe('importsPackage', () => {
  const table: Array<[string, boolean]> = [
    ["import express from 'express';", true],
    ['import express from "express";', true],
    ["const express = require('express');", true],
    ["const { Router } = await import('express');", true],
    ["import mime from 'express/lib/mime.js';", true],
    ["import x from 'expressive';", false],
    ["import x from 'my-express';", false],
    ['// express is mentioned only in a comment', false],
  ];

  it.each(table)('%s -> %s', (text, expected) => {
    expect(importsPackage({ path: 'a.ts', text }, 'express')).toBe(expected);
  });

  it('handles a scoped package name without treating the slash as a pattern', () => {
    expect(
      importsPackage({ path: 'a.ts', text: "import x from '@google/adk';" }, '@google/adk'),
    ).toBe(true);
    expect(
      importsPackage({ path: 'a.ts', text: "import x from '@googleXadk';" }, '@google/adk'),
    ).toBe(false);
  });
});

describe('changedSymbols', () => {
  it('reads identifiers out of code spans and removal wording', () => {
    const symbols = changedSymbols(EXPRESS_NOTES);
    expect(symbols).toContain('res.sendfile');
    expect(symbols).toContain('res.sendFile');
    expect(symbols).toContain('app.del');
    expect(symbols).toContain('req.param');
  });

  it('drops words that would match every file', () => {
    const symbols = changedSymbols({
      notes: 'The `options` object and the `default` export now return `null`.',
      notesSource: 'x',
      commitSubjects: [],
    });
    expect(symbols).toEqual([]);
  });

  it('returns nothing when the notes could not be read', () => {
    expect(changedSymbols({ notes: null, notesSource: null, commitSubjects: [] })).toEqual([]);
  });

  it('reads a removal subject through whatever spacing the writer used', () => {
    expect(changedSymbols(spanNotes('Removed   parseQuery from the router.'))).toContain(
      'parseQuery',
    );
  });
});

/**
 * The stop list is the whole reason a usage match means something: without it a code span saying
 * `null` would match every file in the repository and every bump would score as a changed symbol.
 * One row per word, because a word quietly dropped from the list is invisible any other way.
 */
describe('spans the symbol reader refuses', () => {
  const COMMON = [
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
  ];

  it.each(COMMON)('ignores `%s`, which appears in every file', (word) => {
    expect(changedSymbols(spanNotes(`The \`${word}\` value changed.`))).toEqual([]);
  });

  it('ignores a member of a common head, so `error.stack` is not treated as API', () => {
    expect(changedSymbols(spanNotes('The `error.stack` field changed.'))).toEqual([]);
  });

  it('keeps a three character name and drops a two character one', () => {
    expect(changedSymbols(spanNotes('Renamed `abc` and `ab` in this release.'))).toEqual(['abc']);
  });

  it('drops a span that is not one identifier', () => {
    expect(changedSymbols(spanNotes('The `foo bar` option and the `1abc` flag changed.'))).toEqual(
      [],
    );
  });

  it('drops the call shape but keeps the name', () => {
    expect(changedSymbols(spanNotes('Use `router.handle(req, res)` instead.'))).toEqual([
      'router.handle',
    ]);
  });
});

describe('classifyUsage', () => {
  it('reports unused when nothing imports the package', () => {
    const result = classifyUsage('express', EXPRESS_NOTES, [
      { path: 'src/other.ts', text: "import hono from 'hono';" },
    ]);
    expect(result.match).toBe('unused');
    expect(result.sites).toEqual([]);
  });

  it('reports package-only when the import exists but no changed symbol appears', () => {
    const result = classifyUsage('express', EXPRESS_NOTES, [
      { path: 'src/app.ts', text: "import express from 'express';\nconst app = express();" },
    ]);
    expect(result.match).toBe('package-only');
    expect(result.sites).toEqual([]);
  });

  it('finds the real call site with its line number', () => {
    const result = classifyUsage('express', EXPRESS_NOTES, [ROUTE_FILE]);
    expect(result.match).toBe('changed-symbol');
    expect(result.sites).toContainEqual({
      path: 'src/routes/files.ts',
      line: 6,
      symbol: 'res.sendfile',
      text: 'res.sendfile(resolve(req.params.name));',
    });
  });

  it('caps the evidence it collects, because one match already decides the factor', () => {
    const many = {
      path: 'src/big.ts',
      text: [
        "import express from 'express';",
        ...Array.from({ length: 200 }, () => 'res.sendfile(x);'),
      ].join('\n'),
    };

    const result = classifyUsage('express', EXPRESS_NOTES, [many]);

    expect(result.match).toBe('changed-symbol');
    expect(result.sites).toHaveLength(25);
  });

  it('counts the cap across files rather than per file', () => {
    const file = (path: string, matches: number) => ({
      path,
      text: [
        "import express from 'express';",
        ...Array.from({ length: matches }, () => 'res.sendfile(x);'),
      ].join('\n'),
    });

    const result = classifyUsage('express', EXPRESS_NOTES, [
      file('src/one.ts', 10),
      file('src/two.ts', 200),
    ]);

    expect(result.sites).toHaveLength(25);
    expect(result.sites.filter((site) => site.path === 'src/one.ts')).toHaveLength(10);
  });

  it('does not look for call sites in files that never import the package', () => {
    const decoy = { path: 'src/decoy.ts', text: 'const note = "res.sendfile is gone";' };
    const result = classifyUsage('express', EXPRESS_NOTES, [decoy]);
    expect(result.match).toBe('unused');
  });
});
