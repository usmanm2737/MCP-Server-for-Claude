import { describe, expect, it } from 'vitest';
import { contentHash, nowIso, slugify } from '../../src/utils/ids.js';

describe('slugify', () => {
  it('lowercases and dashes non-alphanumeric runs', () => {
    expect(slugify('My Cool Project!!')).toBe('my-cool-project');
  });

  it('trims leading/trailing dashes', () => {
    expect(slugify('--Weird--Name--')).toBe('weird-name');
  });

  it('falls back to a generated slug for an all-punctuation name', () => {
    expect(slugify('!!!')).toMatch(/^project-[0-9a-f]{8}$/);
  });
});

describe('contentHash', () => {
  it('is stable for the same inputs', () => {
    const a = contentHash(['p1', 'decision', 'title', 'summary', 'content']);
    const b = contentHash(['p1', 'decision', 'title', 'summary', 'content']);
    expect(a).toBe(b);
  });

  it('differs when any part differs', () => {
    const a = contentHash(['p1', 'decision', 'title', 'summary', 'content']);
    const b = contentHash(['p1', 'decision', 'title', 'summary', 'different']);
    expect(a).not.toBe(b);
  });

  it('treats null/undefined parts as a distinct empty slot, not string "null"', () => {
    const withNull = contentHash(['a', null, 'b']);
    const withEmpty = contentHash(['a', '', 'b']);
    const withUndefined = contentHash(['a', undefined, 'b']);
    expect(withNull).toBe(withEmpty);
    expect(withNull).toBe(withUndefined);
  });

  it('does not collide across a boundary shift (["ab","c"] vs ["a","bc"])', () => {
    const first = contentHash(['ab', 'c']);
    const second = contentHash(['a', 'bc']);
    expect(first).not.toBe(second);
  });
});

describe('nowIso', () => {
  it('produces a parseable ISO 8601 timestamp', () => {
    const ts = nowIso();
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
  });
});
