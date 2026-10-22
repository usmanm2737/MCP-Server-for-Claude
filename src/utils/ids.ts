import { createHash, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.length > 0 ? base : `project-${randomUUID().slice(0, 8)}`;
}

/** Stable content hash used to detect duplicate activities/imports. */
export function contentHash(parts: ReadonlyArray<string | null | undefined>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part ?? '');
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}
