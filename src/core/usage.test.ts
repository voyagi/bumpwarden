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
    expect(result.sites.length).toBeLessThanOrEqual(25);
    expect(result.sites.length).toBeGreaterThan(0);
  });

  it('does not look for call sites in files that never import the package', () => {
    const decoy = { path: 'src/decoy.ts', text: 'const note = "res.sendfile is gone";' };
    const result = classifyUsage('express', EXPRESS_NOTES, [decoy]);
    expect(result.match).toBe('unused');
  });
});
