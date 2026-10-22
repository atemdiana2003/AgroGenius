import { describe, expect, it } from 'vitest';
import { escapeCsv, hashToken, normalizePhone } from '../../src/common/security';
import { parseEnv } from '../../src/config/env';

describe('security helpers and environment validation', () => {
  it('escapes CSV and neutralizes spreadsheet formulas', () => {
    expect(escapeCsv('=1+1')).toBe('"\'=1+1"');
    expect(escapeCsv('a,"b"')).toBe('"a,""b"""');
  });

  it('normalizes phone whitespace and hashes opaque credentials', () => {
    expect(normalizePhone('+237 6 70-12.34')).toBe('+2376701234');
    expect(hashToken('secret')).not.toBe('secret');
    expect(hashToken('secret')).toBe(hashToken('secret'));
  });

  it('rejects a weak access-token signing secret', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://host/db',
        JWT_ACCESS_SECRET: 'weak',
        DEVICE_TOKEN_PEPPER: 'different-weak-secret',
        COOKIE_SECURE: 'true',
      }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('defaults payment collection off and selects Fapshi sandbox mode', () => {
    const parsed = parseEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/harvestguard_test',
      JWT_ACCESS_SECRET: 'development-test-secret-that-is-at-least-32',
      DEVICE_TOKEN_PEPPER: 'different-development-pepper-at-least-32-characters',
      COOKIE_SECURE: 'false',
    });
    expect(parsed.PAYMENTS_ENABLED).toBe(false);
    expect(parsed.FAPSHI_MODE).toBe('sandbox');
  });

  it('refuses production mock, sandbox, or incomplete Fapshi payment configuration', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://localhost/harvestguard_test',
      JWT_ACCESS_SECRET: 'production-test-secret-that-is-at-least-32',
      DEVICE_TOKEN_PEPPER: 'different-production-pepper-at-least-32-characters',
      COOKIE_SECURE: 'true',
      PAYMENTS_ENABLED: 'true',
    };
    expect(() => parseEnv({ ...base, PAYMENT_PROVIDER: 'mock' })).toThrow(/mock payment provider/);
    expect(() =>
      parseEnv({
        ...base,
        PAYMENT_PROVIDER: 'fapshi',
        FAPSHI_MODE: 'sandbox',
        FAPSHI_API_USER: 'user',
        FAPSHI_API_KEY: 'key',
        FAPSHI_WEBHOOK_SECRET: 'webhook-secret-that-is-at-least-32-characters',
      }),
    ).toThrow(/production Fapshi payments require live mode/);
    expect(() =>
      parseEnv({
        ...base,
        PAYMENT_PROVIDER: 'fapshi',
        FAPSHI_MODE: 'live',
        FAPSHI_API_USER: 'user',
        FAPSHI_API_KEY: 'key',
      }),
    ).toThrow(/webhook secret/);
  });
});
