import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createPrismaClient } from '../../src/common/prisma-client';
import { createApp } from '../../src/app';
import { parseEnv } from '../../src/config/env';

const prisma = createPrismaClient(
  'postgresql://postgres:postgres@127.0.0.1:5432/harvestguard_test',
);
const env = parseEnv({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/harvestguard_test',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'test-secret-please-use-a-long-random-value',
  ACCESS_TOKEN_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_DAYS: '30',
  LOG_LEVEL: 'silent',
  COOKIE_SECURE: 'false',
  SMS_PROVIDER: 'simulated',
  DEVICE_TOKEN_PEPPER: 'test-pepper-please-use-another-long-secret',
  RESET_TOKEN_TTL_MINUTES: '30',
  TEMPERATURE_MIN_C: '-10',
  TEMPERATURE_MAX_C: '60',
  EXPERIMENTAL_TEMP_MIN_C: '8',
  EXPERIMENTAL_TEMP_MAX_C: '15',
  EXPERIMENTAL_RH_MIN_PERCENT: '70',
  EXPERIMENTAL_RH_MAX_PERCENT: '95',
});
const app = createApp(prisma, env);
const productionApp = createApp(prisma, { ...env, NODE_ENV: 'production', COOKIE_SECURE: true });
const rateLimitedApp = createApp(prisma, env);

afterAll(async () => prisma.$disconnect());

describe('HTTP foundation', () => {
  it('returns a request ID and a simple health response without requiring the database', async () => {
    const response = await request(app).get('/health').expect(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('rejects protected resources without a bearer token using the stable error envelope', async () => {
    const response = await request(app).get('/api/batches').expect(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('returns 404 for unknown routes without exposing internals', async () => {
    const response = await request(app).get('/api/does-not-exist').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error).not.toHaveProperty('stack');
  });

  it('rejects cookie-authenticated mutations without an allowed Origin', async () => {
    const rejected = await request(app)
      .post('/api/unknown-cookie-mutation')
      .set('Cookie', 'hg_refresh=opaque-test-cookie')
      .expect(403);
    expect(rejected.body.error.code).toBe('CSRF_ORIGIN_REJECTED');

    await request(app)
      .post('/api/unknown-cookie-mutation')
      .set('Cookie', 'hg_refresh=opaque-test-cookie')
      .set('Origin', 'http://localhost:5173')
      .expect(404);
  });

  it('uses only the explicitly configured trusted proxy hop count', () => {
    const proxyConfiguredApp = createApp(prisma, { ...env, TRUST_PROXY_HOPS: 1 });
    expect(proxyConfiguredApp.get('trust proxy')).toBe(1);
    expect(app.get('trust proxy')).toBe(0);
  });

  it('keeps production password reset uniformly unavailable without revealing account existence', async () => {
    const knownShape = await request(productionApp)
      .post('/api/auth/password-reset/request')
      .send({ identifier: 'user@example.invalid' })
      .expect(503);
    const arbitraryIdentifier = await request(productionApp)
      .post('/api/auth/password-reset/request')
      .send({ identifier: 'not-an-account' })
      .expect(503);

    expect(knownShape.body.error.code).toBe('RESET_DELIVERY_UNAVAILABLE');
    expect(arbitraryIdentifier.body.error.code).toBe(knownShape.body.error.code);
    expect(arbitraryIdentifier.body.error.requestId).toBe(
      arbitraryIdentifier.headers['x-request-id'],
    );
  });

  it('uses the standard request-ID error envelope when authentication is rate limited', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(rateLimitedApp).post('/api/auth/password-reset/request').send({}).expect(400);
    }
    const response = await request(rateLimitedApp)
      .post('/api/auth/password-reset/request')
      .send({})
      .expect(429);

    expect(response.body.error.code).toBe('RATE_LIMITED');
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
  });
});
