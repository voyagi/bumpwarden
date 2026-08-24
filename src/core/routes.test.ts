import { describe, expect, it } from 'vitest';
import { absoluteUrl, bumpPath, projectPath } from './routes.js';

describe('dashboard paths', () => {
  it('escapes the slash in a repository id so the path stays one segment', () => {
    expect(projectPath('voyagi/bumpwarden-demo-app')).toBe(
      '/projects/voyagi%2Fbumpwarden-demo-app',
    );
  });

  it('escapes a bump key, which carries a slash, a hash and an at sign', () => {
    expect(bumpPath('voyagi/demo', 'voyagi/demo#glob@13.0.6')).toBe(
      '/projects/voyagi%2Fdemo/bumps/voyagi%2Fdemo%23glob%4013.0.6',
    );
  });
});

describe('absolute links written into a GitHub issue', () => {
  it('writes no link at all when the service does not know its own url', () => {
    expect(absoluteUrl(null, '/audit')).toBeNull();
  });

  it('joins base and path without doubling the slash between them', () => {
    expect(absoluteUrl('https://bumpwarden.example.com/', '/audit')).toBe(
      'https://bumpwarden.example.com/audit',
    );
  });

  it('strips every trailing slash, not only the last one', () => {
    expect(absoluteUrl('https://bumpwarden.example.com///', '/audit')).toBe(
      'https://bumpwarden.example.com/audit',
    );
  });

  it('leaves the slashes inside the base url alone', () => {
    expect(absoluteUrl('https://example.com/bumpwarden', '/rubric')).toBe(
      'https://example.com/bumpwarden/rubric',
    );
  });
});
