import { createHash } from 'node:crypto';

const MAX_LENGTH = 48;
const ENTROPY_LENGTH = 8;
const BASE_LENGTH = MAX_LENGTH - ENTROPY_LENGTH - 1;

function clean(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function identifierSlug(value, fallback = 'project') {
  return (clean(value) || clean(fallback) || 'project').slice(0, MAX_LENGTH);
}

export function uniqueProjectIdentity(value, entropy) {
  const suffix = String(entropy || '').replace(/[^a-z0-9]/gi, '').slice(0, ENTROPY_LENGTH).toLowerCase();
  if (suffix.length !== ENTROPY_LENGTH) throw new Error('Project identity entropy must contain at least eight alphanumeric characters.');
  const base = identifierSlug(value, 'project').slice(0, BASE_LENGTH).replace(/-+$/g, '') || 'project';
  return `${base}-${suffix}`;
}

export function stableBoardIdentity(value, fallback = 'project') {
  const normalized = clean(value) || clean(fallback) || 'project';
  if (normalized.length <= MAX_LENGTH) return normalized;
  const generatedSuffix = normalized.match(/-([a-z0-9]{8})$/)?.[1]
    || createHash('sha256').update(normalized).digest('hex').slice(0, ENTROPY_LENGTH);
  const base = normalized.slice(0, BASE_LENGTH).replace(/-+$/g, '') || 'project';
  return `${base}-${generatedSuffix}`;
}

export const _test = { clean, MAX_LENGTH, ENTROPY_LENGTH, BASE_LENGTH };
