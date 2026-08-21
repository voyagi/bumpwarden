import { describe, expect, it } from 'vitest';
import { bumpManifestRange } from './manifest-edit.js';
import { MANIFEST_JSON } from '../testkit/fixtures.js';

describe('bumping a manifest range', () => {
  it('keeps the caret the project chose', () => {
    const edit = bumpManifestRange(MANIFEST_JSON, 'express', '5.0.0');
    expect(edit?.from).toBe('^4.18.2');
    expect(edit?.to).toBe('^5.0.0');
    expect(edit?.text).toContain('"express": "^5.0.0"');
  });

  it('keeps a tilde', () => {
    expect(bumpManifestRange(MANIFEST_JSON, 'vitest', '4.2.0')?.to).toBe('~4.2.0');
  });

  it('keeps an exact pin exact', () => {
    expect(bumpManifestRange(MANIFEST_JSON, 'hono', '4.14.0')?.to).toBe('4.14.0');
  });

  it('changes nothing else in the file', () => {
    const edit = bumpManifestRange(MANIFEST_JSON, 'express', '5.0.0');
    const before = MANIFEST_JSON.split('\n').filter((line) => !line.includes('express'));
    const after = edit?.text.split('\n').filter((line) => !line.includes('express'));
    expect(after).toEqual(before);
  });

  it('reports the dependency it could not find', () => {
    expect(bumpManifestRange(MANIFEST_JSON, 'not-installed', '1.0.0')).toBeNull();
  });

  const unsupported: Array<[string, string]> = [
    ['a git url', '"pkg": "github:owner/repo#v1"'],
    ['a workspace protocol', '"pkg": "workspace:*"'],
    ['a dist-tag', '"pkg": "latest"'],
    ['a range union', '"pkg": ">=1.0.0 <2.0.0"'],
    ['a wildcard', '"pkg": "*"'],
    // Rewriting only the head of this would drop the second alternative and change what installs.
    ['an alternation that starts like a caret range', '"pkg": "^1.0.0 || ^2.0.0"'],
    ['a caret range with a trailing comparator', '"pkg": "^1.0.0 <1.9.0"'],
  ];

  it.each(unsupported)('refuses to rewrite %s', (_label, line) => {
    expect(bumpManifestRange(`{ ${line} }`, 'pkg', '2.0.0')).toBeNull();
  });

  it('rewrites a package listed in two dependency blocks', () => {
    const manifest =
      '{ "dependencies": { "pkg": "^1.0.0" }, "devDependencies": { "pkg": "^1.0.0" } }';
    const edit = bumpManifestRange(manifest, 'pkg', '2.0.0');
    expect(edit?.occurrences).toBe(2);
    expect(edit?.text).not.toContain('1.0.0');
  });

  it('does not match a package whose name merely ends with the same letters', () => {
    const manifest = '{ "dependencies": { "express": "^4.0.0", "my-express": "^1.0.0" } }';
    const edit = bumpManifestRange(manifest, 'express', '5.0.0');
    expect(edit?.text).toContain('"my-express": "^1.0.0"');
  });

  it('handles a scoped name, whose slash is not a regex wildcard', () => {
    const manifest = '{ "dependencies": { "@types/node": "^24.0.0" } }';
    expect(bumpManifestRange(manifest, '@types/node', '24.13.0')?.to).toBe('^24.13.0');
  });

  it('edits a range that was written with padding, and drops the padding', () => {
    const manifest = '{ "dependencies": { "pkg": " ^1.0.0 " } }';
    const edit = bumpManifestRange(manifest, 'pkg', '2.0.0');
    expect(edit?.to).toBe('^2.0.0');
    expect(edit?.text).toContain('"pkg": "^2.0.0"');
  });

  it('keeps a prerelease candidate intact', () => {
    const manifest = '{ "dependencies": { "pkg": "1.0.0" } }';
    expect(bumpManifestRange(manifest, 'pkg', '2.0.0-rc.1')?.to).toBe('2.0.0-rc.1');
  });
});
