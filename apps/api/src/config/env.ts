import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      'Expected a PostgreSQL connection URL.',
    ),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  COOKIE_SECURE: booleanFromString,
  SMS_PROVIDER: z.enum(['simulated', 'disabled']).default('simulated'),
  SMS_API_KEY: z.string().optional(),
  PAYMENTS_ENABLED: booleanFromString,
  PAYMENT_PROVIDER: z.enum(['mock', 'fapshi']).default('mock'),
  FAPSHI_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  FAPSHI_API_USER: z.string().trim().min(1).optional(),
  FAPSHI_API_KEY: z.string().trim().min(1).optional(),
  FAPSHI_WEBHOOK_SECRET: z.string().min(32).optional(),
  DEVICE_TOKEN_PEPPER: z.string().min(32),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  TEMPERATURE_MIN_C: z.coerce.number().default(-10),
  TEMPERATURE_MAX_C: z.coerce.number().default(60),
  EXPERIMENTAL_TEMP_MIN_C: z.coerce.number().default(8),
  EXPERIMENTAL_TEMP_MAX_C: z.coerce.number().default(15),
  EXPERIMENTAL_RH_MIN_PERCENT: z.coerce.number().min(0).max(100).default(70),
  EXPERIMENTAL_RH_MAX_PERCENT: z.coerce.number().min(0).max(100).default(95),
});

export type AppEnv = z.infer<typeof EnvSchema> & {
  allowedOrigins: string[];
};

export function parseEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  const values = result.data;
  if (values.TEMPERATURE_MIN_C >= values.TEMPERATURE_MAX_C) {
    throw new Error('Invalid environment configuration: temperature bounds are reversed.');
  }
  if (values.EXPERIMENTAL_TEMP_MIN_C >= values.EXPERIMENTAL_TEMP_MAX_C) {
    throw new Error(
      'Invalid environment configuration: experimental temperature bounds are reversed.',
    );
  }
  if (values.EXPERIMENTAL_RH_MIN_PERCENT > values.EXPERIMENTAL_RH_MAX_PERCENT) {
    throw new Error(
      'Invalid environment configuration: experimental humidity bounds are reversed.',
    );
  }
  if (
    values.EXPERIMENTAL_TEMP_MIN_C < values.TEMPERATURE_MIN_C ||
    values.EXPERIMENTAL_TEMP_MAX_C > values.TEMPERATURE_MAX_C
  ) {
    throw new Error(
      'Invalid environment configuration: experimental temperature thresholds exceed plausible input bounds.',
    );
  }
  if (values.JWT_ACCESS_SECRET === values.DEVICE_TOKEN_PEPPER) {
    throw new Error(
      'Invalid environment configuration: JWT_ACCESS_SECRET and DEVICE_TOKEN_PEPPER must differ.',
    );
  }
  if (values.NODE_ENV === 'production' && !values.COOKIE_SECURE) {
    throw new Error('Invalid environment configuration: COOKIE_SECURE must be true in production.');
  }
  if (
    values.PAYMENTS_ENABLED &&
    values.PAYMENT_PROVIDER === 'mock' &&
    values.NODE_ENV === 'production'
  ) {
    throw new Error(
      'Invalid environment configuration: the mock payment provider is not allowed in production.',
    );
  }
  if (values.PAYMENTS_ENABLED && values.PAYMENT_PROVIDER === 'fapshi') {
    if (!values.FAPSHI_API_USER || !values.FAPSHI_API_KEY || !values.FAPSHI_WEBHOOK_SECRET) {
      throw new Error(
        'Invalid environment configuration: enabled Fapshi payments require API user, API key, and webhook secret.',
      );
    }
    if (values.NODE_ENV === 'production' && values.FAPSHI_MODE !== 'live') {
      throw new Error(
        'Invalid environment configuration: production Fapshi payments require live mode.',
      );
    }
  }
  if (
    values.NODE_ENV === 'production' &&
    values.FAPSHI_MODE === 'live' &&
    values.PAYMENT_PROVIDER !== 'fapshi'
  ) {
    throw new Error(
      'Invalid environment configuration: live Fapshi mode requires the Fapshi provider.',
    );
  }
  const allowedOrigins = values.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error(
        'Invalid environment configuration: ALLOWED_ORIGINS must contain complete origins.',
      );
    }
    if (
      !['http:', 'https:'].includes(parsedOrigin.protocol) ||
      parsedOrigin.origin !== origin ||
      parsedOrigin.username ||
      parsedOrigin.password
    ) {
      throw new Error(
        'Invalid environment configuration: ALLOWED_ORIGINS entries must be exact http(s) origins without paths.',
      );
    }
  }
  return {
    ...values,
    allowedOrigins,
  };
}
