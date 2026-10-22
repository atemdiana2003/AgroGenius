import type { AppEnv } from '../config/env';

export type FapshiStatus = 'CREATED' | 'PENDING' | 'SUCCESSFUL' | 'FAILED' | 'EXPIRED';

export type PaymentProviderStatus = {
  transId: string;
  status: FapshiStatus;
  amount: number;
  externalId: string;
  userId: string;
};

export type PaymentLink = {
  transId: string;
  link: string | null;
};

export interface PaymentProvider {
  createPayment(input: {
    amount: number;
    userId: string;
    externalId: string;
    message: string;
  }): Promise<PaymentLink>;
  getPaymentStatus(transId: string): Promise<PaymentProviderStatus>;
}

export class PaymentProviderError extends Error {
  constructor(
    public readonly safeCode: string,
    public readonly uncertain: boolean,
  ) {
    super('Payment provider request failed.');
    this.name = 'PaymentProviderError';
  }
}

const FAPSHI_HOSTS = {
  sandbox: 'https://sandbox.fapshi.com',
  live: 'https://live.fapshi.com',
} as const;

function isFapshiCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'fapshi.com' || url.hostname.endsWith('.fapshi.com')) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function createFapshiPaymentProvider(
  env: AppEnv,
  fetcher: typeof fetch = fetch,
): PaymentProvider {
  if (!env.FAPSHI_API_USER || !env.FAPSHI_API_KEY) {
    throw new Error('Fapshi API credentials are required when the Fapshi provider is enabled.');
  }
  const baseUrl = FAPSHI_HOSTS[env.FAPSHI_MODE];

  async function request(path: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          apiuser: env.FAPSHI_API_USER!,
          apikey: env.FAPSHI_API_KEY!,
          ...init.headers,
        },
        signal: AbortSignal.timeout(8_000),
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new PaymentProviderError('PROVIDER_INVALID_RESPONSE', true);
      }
      if (!response.ok) {
        const safeCode =
          response.status === 429
            ? 'PROVIDER_RATE_LIMITED'
            : response.status === 401 || response.status === 403
              ? 'PROVIDER_AUTH_FAILED'
              : 'PROVIDER_REJECTED';
        throw new PaymentProviderError(safeCode, response.status >= 500);
      }
      return body;
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      throw new PaymentProviderError('PROVIDER_UNAVAILABLE', true);
    }
  }

  return {
    async createPayment(input) {
      const result = await request('/initiate-pay', {
        method: 'POST',
        body: JSON.stringify({
          amount: input.amount,
          userId: input.userId,
          externalId: input.externalId,
          message: input.message,
        }),
      });
      if (
        typeof result !== 'object' ||
        result === null ||
        !('transId' in result) ||
        typeof result.transId !== 'string' ||
        !result.transId ||
        !('link' in result) ||
        typeof result.link !== 'string' ||
        !isFapshiCheckoutUrl(result.link)
      ) {
        throw new PaymentProviderError('PROVIDER_INVALID_RESPONSE', true);
      }
      return { transId: result.transId, link: result.link };
    },
    async getPaymentStatus(transId) {
      const result = await request(`/payment-status/${encodeURIComponent(transId)}`, {
        method: 'GET',
      });
      if (typeof result !== 'object' || result === null) {
        throw new PaymentProviderError('PROVIDER_INVALID_RESPONSE', false);
      }
      const value = result as Record<string, unknown>;
      if (
        value.transId !== transId ||
        !['CREATED', 'PENDING', 'SUCCESSFUL', 'FAILED', 'EXPIRED'].includes(String(value.status)) ||
        !Number.isSafeInteger(value.amount) ||
        typeof value.externalId !== 'string' ||
        typeof value.userId !== 'string'
      ) {
        throw new PaymentProviderError('PROVIDER_INVALID_RESPONSE', false);
      }
      return {
        transId,
        status: value.status as FapshiStatus,
        amount: value.amount as number,
        externalId: value.externalId,
        userId: value.userId,
      };
    },
  };
}

export function createMockPaymentProvider(): PaymentProvider {
  const transactions = new Map<string, PaymentProviderStatus>();
  return {
    async createPayment(input) {
      const transId = `mock-${input.externalId}`;
      transactions.set(transId, {
        transId,
        status: 'PENDING',
        amount: input.amount,
        externalId: input.externalId,
        userId: input.userId,
      });
      return { transId, link: null };
    },
    async getPaymentStatus(transId) {
      const transaction = transactions.get(transId);
      if (!transaction) throw new PaymentProviderError('PROVIDER_NOT_FOUND', false);
      return { ...transaction };
    },
  };
}
