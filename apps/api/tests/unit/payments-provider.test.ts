import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env';
import { createFapshiPaymentProvider, PaymentProviderError } from '../../src/payments/provider';

const env = parseEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/harvestguard_test',
  JWT_ACCESS_SECRET: 'payment-provider-test-jwt-secret-at-least-32',
  DEVICE_TOKEN_PEPPER: 'payment-provider-test-pepper-distinct-32chars',
  COOKIE_SECURE: 'false',
  FAPSHI_MODE: 'sandbox',
  FAPSHI_API_USER: 'sandbox-user',
  FAPSHI_API_KEY: 'sandbox-secret',
});

describe('Fapshi provider adapter', () => {
  it('uses documented sandbox endpoints, headers, and collection fields', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/initiate-pay')) {
        return new Response(
          JSON.stringify({
            transId: 'provider-transaction',
            link: 'https://checkout.fapshi.com/pay/opaque',
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          transId: 'provider-transaction',
          status: 'PENDING',
          amount: 1500,
          externalId: 'public-reference',
          userId: 'user-reference',
        }),
        { status: 200 },
      );
    });
    const adapter = createFapshiPaymentProvider(env, fetcher);
    const created = await adapter.createPayment({
      amount: 1500,
      userId: 'user-reference',
      externalId: 'public-reference',
      message: 'HarvestGuard accepted offer payment',
    });
    const status = await adapter.getPaymentStatus(created.transId);

    expect(created.link).toBe('https://checkout.fapshi.com/pay/opaque');
    expect(status.status).toBe('PENDING');
    expect(calls[0].url).toBe('https://sandbox.fapshi.com/initiate-pay');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      amount: 1500,
      userId: 'user-reference',
      externalId: 'public-reference',
      message: 'HarvestGuard accepted offer payment',
    });
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('apiuser')).toBe('sandbox-user');
    expect(headers.get('apikey')).toBe('sandbox-secret');
    expect(calls[1].url).toBe('https://sandbox.fapshi.com/payment-status/provider-transaction');
    expect(calls[1].init?.method).toBe('GET');
    expect(calls[1].init?.body).toBeUndefined();
  });

  it('rejects a checkout URL outside Fapshi and never exposes provider error content', async () => {
    const adapter = createFapshiPaymentProvider(
      env,
      async () =>
        new Response(
          JSON.stringify({
            transId: 'provider-transaction',
            link: 'https://attacker.invalid/collect',
          }),
          { status: 200 },
        ),
    );
    await expect(
      adapter.createPayment({
        amount: 1500,
        userId: 'user-reference',
        externalId: 'public-reference',
        message: 'test',
      }),
    ).rejects.toMatchObject({
      safeCode: 'PROVIDER_INVALID_RESPONSE',
      uncertain: true,
    });
  });

  it('marks network errors as uncertain rather than retrying initiation', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('raw transport detail');
    });
    const adapter = createFapshiPaymentProvider(env, fetcher);
    let captured: unknown;
    try {
      await adapter.createPayment({
        amount: 1500,
        userId: 'user-reference',
        externalId: 'public-reference',
        message: 'test',
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PaymentProviderError);
    expect(captured).toMatchObject({ safeCode: 'PROVIDER_UNAVAILABLE', uncertain: true });
    expect((captured as Error).message).not.toContain('raw transport detail');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
