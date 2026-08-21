import { describe, expect, it } from 'vitest';
import { ALL_INTERFACES, bindHostname } from './bind.js';

describe('bindHostname', () => {
  it('drops the hostname for the all-interfaces value, which is how Node binds every interface', () => {
    expect(bindHostname(ALL_INTERFACES)).toBeUndefined();
  });

  it('keeps loopback, so a local run is never reachable from the network', () => {
    expect(bindHostname('127.0.0.1')).toBe('127.0.0.1');
  });

  it('keeps any other explicit address the operator sets', () => {
    expect(bindHostname('10.4.0.7')).toBe('10.4.0.7');
  });
});
