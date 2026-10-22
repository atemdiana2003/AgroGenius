import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AppEnv } from '../config/env';
import { AppError, notFound } from '../common/errors';
import { asyncHandler, success, validate } from '../common/http';
import type { PrismaClient } from '../prisma-client';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  createFapshiPaymentProvider,
  createMockPaymentProvider,
  PaymentProviderError,
} from '../payments/provider';
import type { PaymentProvider, PaymentProviderStatus } from '../payments/provider';

const WebhookSchema = z
  .object({
    transId: z.string().min(1).max(120),
    status: z.enum(['SUCCESSFUL', 'FAILED', 'EXPIRED']),
    amount: z.number().int().safe().positive().optional(),
    externalId: z.string().min(1).max(100).optional(),
    userId: z.string().min(1).max(100).optional(),
  })
  .passthrough();

function safePayment(payment: {
  id: string;
  publicReference: string;
  offerId: string;
  amountXaf: number;
  currency: string;
  provider: string;
  providerMode: 'SANDBOX' | 'LIVE' | 'SIMULATED';
  checkoutUrl: string | null;
  status: string;
  safeFailureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: payment.id,
    reference: payment.publicReference,
    offerId: payment.offerId,
    amount: payment.amountXaf,
    currency: payment.currency,
    provider: payment.provider,
    mode: payment.providerMode === 'SIMULATED' ? 'simulated' : payment.providerMode.toLowerCase(),
    checkoutUrl: payment.checkoutUrl,
    status: payment.status,
    failureCode: payment.safeFailureCode,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    completedAt: payment.completedAt,
  };
}

function sameSecret(expected: string | undefined, supplied: string | undefined): boolean {
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function providerStatusMatches(
  payment: {
    providerTransactionId: string | null;
    publicReference: string;
    payerId: string;
    amountXaf: number;
  },
  status: PaymentProviderStatus,
): boolean {
  return (
    status.transId === payment.providerTransactionId &&
    status.externalId === payment.publicReference &&
    status.userId === payment.payerId &&
    status.amount === payment.amountXaf
  );
}

export function paymentRoutes(
  prisma: PrismaClient,
  env: AppEnv,
  injectedProvider?: PaymentProvider,
) {
  const router = Router();
  const provider =
    injectedProvider ??
    (env.PAYMENTS_ENABLED && env.PAYMENT_PROVIDER === 'fapshi'
      ? createFapshiPaymentProvider(env)
      : createMockPaymentProvider());

  async function persistVerifiedStatus(
    paymentId: string,
    status: PaymentProviderStatus,
    webhook?: {
      payloadStatus: 'SUCCESSFUL' | 'FAILED' | 'EXPIRED';
      deduplicationKey: string;
      matchesStatus: boolean;
    },
  ) {
    return prisma.$transaction(async (tx) => {
      const payment = await tx.paymentIntent.findUnique({ where: { id: paymentId } });
      if (!payment) throw notFound();
      if (!providerStatusMatches(payment, status)) {
        if (webhook) {
          const event = await tx.paymentProviderEvent.createMany({
            data: [
              {
                paymentId,
                providerTransId: status.transId,
                payloadStatus: webhook.payloadStatus,
                verifiedStatus: status.status,
                deduplicationKey: webhook.deduplicationKey,
                outcome: 'STATUS_MISMATCH',
                processedAt: new Date(),
              },
            ],
            skipDuplicates: true,
          });
          if (!event.count) {
            const current = await tx.paymentIntent.findUniqueOrThrow({ where: { id: payment.id } });
            return { payment: current, verified: false };
          }
        }
        if (webhook && !webhook.matchesStatus) {
          await tx.auditLog.create({
            data: {
              actorId: payment.payerId,
              action: 'PAYMENT_WEBHOOK_PAYLOAD_MISMATCH',
              entityType: 'PaymentIntent',
              entityId: payment.id,
            },
          });
        }
        await tx.auditLog.create({
          data: {
            actorId: payment.payerId,
            action: 'PAYMENT_VERIFICATION_MISMATCH',
            entityType: 'PaymentIntent',
            entityId: payment.id,
          },
        });
        return { payment, verified: false };
      }

      if (webhook) {
        const event = await tx.paymentProviderEvent.createMany({
          data: [
            {
              paymentId,
              providerTransId: status.transId,
              payloadStatus: webhook.payloadStatus,
              verifiedStatus: status.status,
              deduplicationKey: webhook.deduplicationKey,
              outcome: webhook.matchesStatus ? 'VERIFIED' : 'WEBHOOK_STATUS_MISMATCH',
              processedAt: new Date(),
            },
          ],
          skipDuplicates: true,
        });
        if (!event.count) {
          const current = await tx.paymentIntent.findUniqueOrThrow({ where: { id: payment.id } });
          return { payment: current, verified: true };
        }
        if (!webhook.matchesStatus) {
          await tx.auditLog.create({
            data: {
              actorId: payment.payerId,
              action: 'PAYMENT_WEBHOOK_PAYLOAD_MISMATCH',
              entityType: 'PaymentIntent',
              entityId: payment.id,
            },
          });
        }
      }

      const isTerminal = ['SUCCESSFUL', 'FAILED', 'EXPIRED'].includes(status.status);
      const shouldAdvance =
        !(payment.status === 'PENDING' && status.status === 'CREATED') &&
        ['CREATED', 'PENDING'].includes(payment.status);
      const update = shouldAdvance
        ? await tx.paymentIntent.updateMany({
            where: { id: payment.id, status: { in: ['CREATED', 'PENDING'] } },
            data: {
              status: status.status,
              safeFailureCode:
                status.status === 'FAILED'
                  ? 'PROVIDER_PAYMENT_FAILED'
                  : status.status === 'EXPIRED'
                    ? 'PROVIDER_PAYMENT_EXPIRED'
                    : null,
              completedAt: isTerminal ? new Date() : null,
            },
          })
        : { count: 0 };
      if (update.count === 1 && payment.status !== status.status) {
        await tx.auditLog.create({
          data: {
            actorId: payment.payerId,
            action: `PAYMENT_${status.status}`,
            entityType: 'PaymentIntent',
            entityId: payment.id,
          },
        });
      }
      const current = await tx.paymentIntent.findUniqueOrThrow({ where: { id: payment.id } });
      return { payment: current, verified: true };
    });
  }

  async function readProviderStatus(transId: string) {
    try {
      return await provider.getPaymentStatus(transId);
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        const status = ['PROVIDER_UNAVAILABLE', 'PROVIDER_RATE_LIMITED'].includes(error.safeCode)
          ? 503
          : 502;
        throw new AppError(
          status,
          error.safeCode,
          'The payment provider status could not be verified.',
        );
      }
      throw error;
    }
  }

  async function refreshStatus(paymentId: string) {
    const payment = await prisma.paymentIntent.findUnique({ where: { id: paymentId } });
    if (!payment) throw notFound();
    if (['SUCCESSFUL', 'FAILED', 'EXPIRED'].includes(payment.status)) return payment;
    if (!payment.providerTransactionId) {
      throw new AppError(
        409,
        'PAYMENT_RECONCILIATION_REQUIRED',
        'The provider initiation result is uncertain; support must reconcile it before retrying.',
      );
    }
    const nextCheckAt = new Date();
    const checkBefore = new Date(nextCheckAt.getTime() - 11_000);
    const claim = await prisma.paymentIntent.updateMany({
      where: {
        id: payment.id,
        status: { in: ['CREATED', 'PENDING'] },
        OR: [{ lastProviderCheckAt: null }, { lastProviderCheckAt: { lt: checkBefore } }],
      },
      data: { lastProviderCheckAt: nextCheckAt },
    });
    if (!claim.count) {
      return prisma.paymentIntent.findUniqueOrThrow({ where: { id: payment.id } });
    }
    const providerStatus = await readProviderStatus(payment.providerTransactionId);
    const result = await persistVerifiedStatus(payment.id, providerStatus);
    if (!result.verified) {
      throw new AppError(
        502,
        'PAYMENT_PROVIDER_DATA_MISMATCH',
        'The provider status did not match this payment; no payment status was changed.',
      );
    }
    return result.payment;
  }

  async function waitForInitialPaymentResult(
    payment: Awaited<ReturnType<typeof prisma.paymentIntent.findUniqueOrThrow>>,
  ) {
    let current = payment;
    for (let attempt = 0; current.status === 'CREATED' && attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: payment.id } });
    }
    return current;
  }

  router.post(
    '/offers/:id',
    requireAuth(prisma, env),
    requireRole('BUYER'),
    asyncHandler(async (request, response) => {
      if (!env.PAYMENTS_ENABLED) {
        throw new AppError(503, 'PAYMENTS_DISABLED', 'Payment collection is not enabled.');
      }
      validate(z.object({}).strict(), request.body ?? {});
      const offerId = validate(z.string().uuid(), request.params.id);
      const idempotencyKey = validate(z.string().uuid(), request.header('Idempotency-Key'));
      const offer = await prisma.buyerOffer.findUnique({ where: { id: offerId } });
      if (!offer || offer.buyerId !== request.auth!.userId) throw notFound();
      if (offer.status !== 'ACCEPTED' || !offer.confirmedAt) {
        throw new AppError(
          409,
          'OFFER_NOT_PAYABLE',
          'Payment is available only for a seller-confirmed accepted offer.',
        );
      }
      if (offer.offeredPrice === null || offer.currency !== 'XAF') {
        throw new AppError(
          409,
          'PAYMENT_AMOUNT_UNAVAILABLE',
          'This offer has no agreed XAF payment amount.',
        );
      }
      const amount = Number(offer.offeredPrice);
      if (!Number.isSafeInteger(amount) || amount < 100) {
        throw new AppError(
          409,
          'PAYMENT_AMOUNT_UNAVAILABLE',
          'The agreed offer amount must be an integer of at least 100 XAF.',
        );
      }
      const fingerprint = createHash('sha256')
        .update(`${request.auth!.userId}:${offer.id}:${amount}:XAF`)
        .digest('hex');
      let existing = await prisma.paymentIntent.findUnique({
        where: {
          payerId_idempotencyKey: {
            payerId: request.auth!.userId,
            idempotencyKey,
          },
        },
      });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new AppError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'This idempotency key was already used for a different payment request.',
          );
        }
        if (existing.status === 'CREATED') {
          existing = await waitForInitialPaymentResult(existing);
        }
        if (existing.status === 'CREATED') {
          throw new AppError(
            409,
            'PAYMENT_INITIATION_IN_PROGRESS',
            'The existing payment request is being initialized; do not submit another key.',
          );
        }
        if (existing.status === 'FAILED') {
          throw new AppError(
            502,
            existing.safeFailureCode ?? 'PAYMENT_PROVIDER_FAILED',
            'The payment provider rejected the existing payment request.',
            [
              {
                paymentId: existing.id,
                reference: existing.publicReference,
                status: existing.status,
              },
            ],
          );
        }
        return success(
          response,
          safePayment(existing),
          existing.status === 'INITIATION_UNKNOWN' ? 202 : 200,
        );
      }
      const priorPayment = await prisma.paymentIntent.findFirst({
        where: {
          offerId: offer.id,
          status: { in: ['CREATED', 'PENDING', 'SUCCESSFUL', 'INITIATION_UNKNOWN'] },
        },
      });
      if (priorPayment) {
        throw new AppError(
          409,
          'PAYMENT_ALREADY_INITIATED',
          'This confirmed offer already has a pending or completed payment.',
        );
      }

      let payment: Awaited<ReturnType<typeof prisma.paymentIntent.create>>;
      try {
        payment = await prisma.$transaction(async (tx) => {
          const created = await tx.paymentIntent.create({
            data: {
              payerId: request.auth!.userId,
              offerId: offer.id,
              amountXaf: amount,
              provider: env.PAYMENT_PROVIDER === 'fapshi' ? 'FAPSHI' : 'MOCK',
              providerMode:
                env.PAYMENT_PROVIDER === 'fapshi'
                  ? env.FAPSHI_MODE === 'live'
                    ? 'LIVE'
                    : 'SANDBOX'
                  : 'SIMULATED',
              idempotencyKey,
              requestFingerprint: fingerprint,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: request.auth!.userId,
              action: 'PAYMENT_CREATED',
              entityType: 'PaymentIntent',
              entityId: created.id,
            },
          });
          return created;
        });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) {
          throw error;
        }
        let raced = await prisma.paymentIntent.findUnique({
          where: {
            payerId_idempotencyKey: {
              payerId: request.auth!.userId,
              idempotencyKey,
            },
          },
        });
        if (!raced) throw error;
        if (raced.requestFingerprint !== fingerprint) {
          throw new AppError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'This idempotency key was already used for a different payment request.',
          );
        }
        if (raced.status === 'CREATED') {
          raced = await waitForInitialPaymentResult(raced);
        }
        if (raced.status === 'CREATED') {
          throw new AppError(
            409,
            'PAYMENT_INITIATION_IN_PROGRESS',
            'The existing payment request is being initialized; do not submit another key.',
          );
        }
        return success(
          response,
          safePayment(raced),
          raced.status === 'INITIATION_UNKNOWN' ? 202 : 200,
        );
      }

      let initiated: Awaited<ReturnType<PaymentProvider['createPayment']>> | null = null;
      let initiationError: PaymentProviderError | null = null;
      try {
        initiated = await provider.createPayment({
          amount,
          userId: payment.payerId,
          externalId: payment.publicReference,
          message: 'HarvestGuard accepted offer payment',
        });
      } catch (error) {
        initiationError =
          error instanceof PaymentProviderError
            ? error
            : new PaymentProviderError('PROVIDER_UNAVAILABLE', true);
      }

      if (initiated) {
        payment = await prisma.$transaction(async (tx) => {
          const updated = await tx.paymentIntent.update({
            where: { id: payment.id },
            data: {
              providerTransactionId: initiated.transId,
              checkoutUrl: initiated.link,
              status: 'PENDING',
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: payment.payerId,
              action: 'PAYMENT_PENDING',
              entityType: 'PaymentIntent',
              entityId: payment.id,
            },
          });
          return updated;
        });
      } else if (initiationError) {
        payment = await prisma.$transaction(async (tx) => {
          const updated = await tx.paymentIntent.update({
            where: { id: payment.id },
            data: {
              status: initiationError.uncertain ? 'INITIATION_UNKNOWN' : 'FAILED',
              safeFailureCode: initiationError.safeCode,
              completedAt: initiationError.uncertain ? null : new Date(),
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: payment.payerId,
              action: initiationError.uncertain
                ? 'PAYMENT_INITIATION_UNKNOWN'
                : 'PAYMENT_INITIATION_FAILED',
              entityType: 'PaymentIntent',
              entityId: payment.id,
            },
          });
          return updated;
        });
      }
      if (payment.status === 'FAILED') {
        throw new AppError(
          502,
          payment.safeFailureCode ?? 'PAYMENT_PROVIDER_FAILED',
          'The payment provider rejected the payment request.',
          [
            {
              paymentId: payment.id,
              reference: payment.publicReference,
              status: payment.status,
            },
          ],
        );
      }
      return success(
        response,
        safePayment(payment),
        payment.status === 'INITIATION_UNKNOWN' ? 202 : 201,
      );
    }),
  );

  router.get(
    '/:id',
    requireAuth(prisma, env),
    rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false }),
    asyncHandler(async (request, response) => {
      const id = validate(z.string().uuid(), request.params.id);
      const payment = await prisma.paymentIntent.findUnique({ where: { id } });
      if (!payment || payment.payerId !== request.auth!.userId) throw notFound();
      const current = await refreshStatus(payment.id);
      return success(response, safePayment(current));
    }),
  );

  router.post(
    '/fapshi/webhook',
    asyncHandler(async (request, response) => {
      if (
        !env.PAYMENTS_ENABLED ||
        env.PAYMENT_PROVIDER !== 'fapshi' ||
        !sameSecret(env.FAPSHI_WEBHOOK_SECRET, request.header('x-wh-secret'))
      ) {
        throw new AppError(
          401,
          'INVALID_WEBHOOK',
          'The payment notification could not be verified.',
        );
      }
      const webhook = validate(WebhookSchema, request.body);
      const deduplicationKey = `${webhook.transId}:${webhook.status}`;
      const payment = await prisma.paymentIntent.findUnique({
        where: { providerTransactionId: webhook.transId },
      });
      if (!payment) {
        const authoritative = await readProviderStatus(webhook.transId);
        await prisma.paymentProviderEvent.createMany({
          data: [
            {
              providerTransId: webhook.transId,
              payloadStatus: webhook.status,
              verifiedStatus: authoritative.status,
              deduplicationKey,
              outcome: 'UNMATCHED',
              processedAt: new Date(),
            },
          ],
          skipDuplicates: true,
        });
        return response.status(200).json({ data: { received: true }, meta: {} });
      }

      const existingEvent = await prisma.paymentProviderEvent.findUnique({
        where: { deduplicationKey },
      });
      if (existingEvent) return response.status(200).json({ data: { received: true }, meta: {} });

      const authoritative = await readProviderStatus(webhook.transId);
      if (
        authoritative.status !== webhook.status ||
        (webhook.amount !== undefined && authoritative.amount !== webhook.amount) ||
        (webhook.externalId !== undefined && authoritative.externalId !== webhook.externalId) ||
        (webhook.userId !== undefined && authoritative.userId !== webhook.userId)
      ) {
        await persistVerifiedStatus(payment.id, authoritative, {
          payloadStatus: webhook.status,
          deduplicationKey,
          matchesStatus: false,
        });
        return response.status(200).json({ data: { received: true }, meta: {} });
      }
      try {
        await persistVerifiedStatus(payment.id, authoritative, {
          payloadStatus: webhook.status,
          deduplicationKey,
          matchesStatus: true,
        });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) {
          throw error;
        }
      }
      return response.status(200).json({ data: { received: true }, meta: {} });
    }),
  );

  return router;
}
