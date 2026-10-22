import { createHash, randomBytes } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizePhone(value: string): string {
  return value.replace(/[\s().-]/g, '');
}

export function isValidNormalizedPhone(value: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(value);
}

export function escapeCsv(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
