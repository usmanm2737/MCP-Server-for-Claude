import { describe, expect, it } from 'vitest';
import { buildFtsQuery } from '../../src/services/search-service.js';

describe('buildFtsQuery', () => {
  it('returns null for an empty or whitespace-only query', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
  });

  it('wraps each whitespace-delimited word as its own quoted literal, ANDed together', () => {
    expect(buildFtsQuery('hello world')).toBe('"hello" "world"');
  });

  it('quotes AND/OR/NOT so they are treated as literal text, not FTS5 operators', () => {
    expect(buildFtsQuery('AND NOT bar')).toBe('"AND" "NOT" "bar"');
  });

  it('escapes embedded double quotes by doubling them, so they cannot break out of the literal', () => {
    expect(buildFtsQuery('say "hi"')).toBe('"say" """hi"""');
  });

  it('keeps a word verbatim, including internal punctuation like ":" or "-" (never read as col:value or a NOT-prefix once quoted)', () => {
    expect(buildFtsQuery('title:foo')).toBe('"title:foo"');
    expect(buildFtsQuery('-excluded')).toBe('"-excluded"');
  });

  it('passes a punctuation-only word through as a (harmlessly unmatchable) quoted literal rather than erroring', () => {
    expect(buildFtsQuery('???')).toBe('"???"');
  });

  it('does not re-join punctuation-separated word fragments, so dates/timestamps match how FTS5 actually indexed them', () => {
    // Regression test: an earlier version stripped punctuation and concatenated the
    // remaining characters (e.g. "2026-10-22T11:41:56.636Z" -> "20261022T114156636Z"),
    // which could never match because FTS5's own tokenizer splits stored text on the
    // same punctuation when indexing it. Passing the word through verbatim and letting
    // FTS5 tokenize the quoted literal the same way it tokenized the index is correct.
    expect(buildFtsQuery('2026-10-22T11:41:56.636Z')).toBe('"2026-10-22T11:41:56.636Z"');
  });
});
