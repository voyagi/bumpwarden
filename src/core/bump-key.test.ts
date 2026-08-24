import { describe, expect, it } from 'vitest';
import {
  bodyCarriesKey,
  bumpKey,
  documentId,
  keyFromBody,
  marker,
  repositoryId,
} from './bump-key.js';

const IDENTITY = {
  owner: 'demo',
  repo: 'app',
  dependency: 'express',
  candidateVersion: '5.0.0',
};

describe('the bump key', () => {
  it('is the same on every run for the same bump', () => {
    expect(bumpKey(IDENTITY)).toBe(bumpKey({ ...IDENTITY }));
    expect(bumpKey(IDENTITY)).toBe('demo/app#express@5.0.0');
  });

  it('separates two candidate versions of the same package', () => {
    expect(bumpKey({ ...IDENTITY, candidateVersion: '5.1.0' })).not.toBe(bumpKey(IDENTITY));
  });

  it('separates the same package in two repositories', () => {
    expect(bumpKey({ ...IDENTITY, repo: 'other' })).not.toBe(bumpKey(IDENTITY));
  });

  it('becomes a document id with no slash in it', () => {
    expect(documentId(bumpKey(IDENTITY))).toBe('demo__app#express@5.0.0');
    expect(documentId(bumpKey(IDENTITY))).not.toContain('/');
  });
});

describe('the hidden marker', () => {
  const key = bumpKey(IDENTITY);

  it('survives a round trip through an issue body', () => {
    const body = `${marker(key)}\n\nSome text a reader sees.`;
    expect(keyFromBody(body)).toBe(key);
    expect(bodyCarriesKey(body, key)).toBe(true);
  });

  it('is an HTML comment, so GitHub renders nothing', () => {
    expect(marker(key).startsWith('<!--')).toBe(true);
    expect(marker(key).endsWith('-->')).toBe(true);
  });

  it('does not match a different bump', () => {
    const body = marker(bumpKey({ ...IDENTITY, candidateVersion: '4.19.0' }));
    expect(bodyCarriesKey(body, key)).toBe(false);
  });

  it('reads a body with no marker as unmarked rather than throwing', () => {
    expect(keyFromBody('a plain issue somebody wrote by hand')).toBeNull();
    expect(keyFromBody('<!-- bumpwarden:key= -->')).toBeNull();
    expect(keyFromBody('<!-- bumpwarden:key=truncated')).toBeNull();
  });

  // GitHub's editor and a person copying a body both reflow whitespace, and losing the key would
  // mean opening a second issue for a bump that already has one.
  it('reads a key that came back with padding around it', () => {
    expect(keyFromBody('<!-- bumpwarden:key=  voyagi/demo#glob@13.0.6   -->')).toBe(
      'voyagi/demo#glob@13.0.6',
    );
  });
});

describe('the repository id', () => {
  it('is owner and repo joined the way the watch list and the store spell it', () => {
    expect(repositoryId('voyagi', 'bumpwarden-demo-app')).toBe('voyagi/bumpwarden-demo-app');
  });

  it('is the prefix of every bump key in that repository', () => {
    expect(bumpKey(IDENTITY).startsWith(`${repositoryId(IDENTITY.owner, IDENTITY.repo)}#`)).toBe(
      true,
    );
  });
});
