import { Router } from 'express';
import type { Prisma, PrismaClient } from '../prisma-client';
import { PriceAlertRuleSchema, PriceObservationSchema, IdSchema } from '@harvestguard/contracts';
import { z } from 'zod';
import type { AppEnv } from '../config/env';
import { AppError, notFound } from '../common/errors';
import { asyncHandler, pagination, success, validate } from '../common/http';
import { runIdempotent } from '../common/idempotency';
import { requireActiveUnit } from '../common/units';
import { requireAuth, requireRole } from '../middleware/auth';

export function marketRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();

  router.get(
    '/crops',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where = { active: true };
      const [items, total] = await prisma.$transaction([
        prisma.crop.findMany({ where, orderBy: { name: 'asc' }, skip, take }),
        prisma.crop.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  router.get(
    '/markets',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where: Prisma.MarketWhereInput = { active: true };
      if (typeof request.query.community === 'string') where.community = request.query.community;
      if (typeof request.query.region === 'string') where.region = request.query.region;
      const [items, total] = await prisma.$transaction([
        prisma.market.findMany({
          where,
          orderBy: [{ region: 'asc' }, { name: 'asc' }],
          skip,
          take,
        }),
        prisma.market.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  router.get(
    '/prices',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where: Prisma.PriceObservationWhereInput = {};
      if (typeof request.query.cropId === 'string')
        where.cropId = validate(IdSchema, request.query.cropId);
      if (typeof request.query.marketId === 'string')
        where.marketId = validate(IdSchema, request.query.marketId);
      if (typeof request.query.from === 'string' || typeof request.query.to === 'string') {
        const from =
          typeof request.query.from === 'string' ? new Date(request.query.from) : undefined;
        const to = typeof request.query.to === 'string' ? new Date(request.query.to) : undefined;
        if (
          (from && Number.isNaN(from.getTime())) ||
          (to && Number.isNaN(to.getTime())) ||
          (from && to && from > to)
        ) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            'Price date filters must be valid timestamps and from must not follow to.',
          );
        }
        where.observedAt = {
          ...(from ? { gte: from } : {}),
          ...(to ? { lte: to } : {}),
        };
      }
      const [items, total] = await prisma.$transaction([
        prisma.priceObservation.findMany({
          where,
          include: { crop: true, market: true },
          orderBy: { observedAt: 'desc' },
          skip,
          take,
        }),
        prisma.priceObservation.count({ where }),
      ]);
      const latest = items[0]?.observedAt;
      return success(response, items, 200, {
        page,
        pageSize,
        total,
        latestObservedAt: latest ?? null,
        freshness: latest
          ? Date.now() - latest.getTime() <= 7 * 86400000
            ? 'RECENT'
            : 'STALE'
          : 'NO_DATA',
        provenance: 'User-entered observations; not an official or automated live price feed.',
      });
    }),
  );

  router.post(
    '/prices',
    requireAuth(prisma, env),
    requireRole('FARMER', 'ADMIN'),
    asyncHandler(async (request, response) => {
      const input = validate(PriceObservationSchema, request.body);
      if (new Date(input.observedAt).getTime() > Date.now() + 5 * 60 * 1000) {
        throw new AppError(
          400,
          'INVALID_OBSERVATION_TIME',
          'Price observation time cannot be in the future.',
        );
      }
      const result = await runIdempotent(
        prisma,
        {
          actorId: request.auth!.userId,
          clientOperationId: input.clientOperationId ?? request.header('Idempotency-Key'),
          entity: 'PriceObservation',
          operation: 'CREATE',
          payload: input,
        },
        async (tx) => {
          await requireActiveUnit(tx, input.unit);
          const [crop, market] = await Promise.all([
            tx.crop.findFirst({ where: { id: input.cropId, active: true } }),
            tx.market.findFirst({ where: { id: input.marketId, active: true } }),
          ]);
          if (!crop || !market) throw notFound('The crop or market reference was not found.');
          const observation = await tx.priceObservation.create({
            data: {
              cropId: input.cropId,
              marketId: input.marketId,
              enteredById: request.auth!.userId,
              amount: input.amount,
              currency: input.currency,
              unit: input.unit,
              observedAt: new Date(input.observedAt),
              source: input.source,
              isDemo: input.source.toLowerCase().includes('demo'),
              clientOperationId: input.clientOperationId,
            },
            include: { crop: true, market: true },
          });
          const rules = await tx.priceAlertRule.findMany({
            where: {
              active: true,
              cropId: input.cropId,
              marketId: input.marketId,
              currency: input.currency,
              unit: input.unit,
            },
          });
          for (const rule of rules) {
            const amount = Number(observation.amount);
            const threshold = Number(rule.targetAmount);
            const reached =
              rule.condition === 'AT_OR_ABOVE' ? amount >= threshold : amount <= threshold;
            if (!reached) continue;
            await tx.notification.createMany({
              data: [
                {
                  recipientId: rule.userId,
                  event: 'TARGET_PRICE_REACHED',
                  payload: {
                    priceObservationId: observation.id,
                    crop: crop.name,
                    market: market.name,
                    amount: observation.amount.toString(),
                    currency: observation.currency,
                    unit: observation.unit,
                    observedAt: observation.observedAt.toISOString(),
                    source: observation.source,
                  },
                  channel: 'IN_APP',
                  deliveryStatus: 'PENDING',
                  deduplicationKey: `price-rule:${rule.id}:observation:${observation.id}`,
                  alertRuleId: rule.id,
                },
              ],
              skipDuplicates: true,
            });
          }
          await tx.auditLog.create({
            data: {
              actorId: request.auth!.userId,
              action: 'PRICE_OBSERVATION_CREATED',
              entityType: 'PriceObservation',
              entityId: observation.id,
            },
          });
          return observation;
        },
      );
      response.setHeader('Idempotency-Replayed', String(result.replayed));
      return success(response, result.value, result.replayed ? 200 : 201);
    }),
  );

  router.get(
    '/price-alert-rules',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where = request.auth!.role === 'ADMIN' ? {} : { userId: request.auth!.userId };
      const [items, total] = await prisma.$transaction([
        prisma.priceAlertRule.findMany({
          where,
          include: { crop: true, market: true },
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        prisma.priceAlertRule.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  router.post(
    '/price-alert-rules',
    requireAuth(prisma, env),
    requireRole('FARMER'),
    asyncHandler(async (request, response) => {
      const input = validate(PriceAlertRuleSchema, request.body);
      await requireActiveUnit(prisma, input.unit);
      const [crop, market] = await Promise.all([
        prisma.crop.findFirst({ where: { id: input.cropId, active: true } }),
        prisma.market.findFirst({ where: { id: input.marketId, active: true } }),
      ]);
      if (!crop || !market) throw notFound('The crop or market reference was not found.');
      const rule = await prisma.priceAlertRule.create({
        data: { ...input, userId: request.auth!.userId },
      });
      return success(response, rule, 201);
    }),
  );

  router.patch(
    '/price-alert-rules/:id',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(
        z
          .object({
            targetAmount: z.number().finite().positive().optional(),
            active: z.boolean().optional(),
            condition: z.enum(['AT_OR_ABOVE', 'AT_OR_BELOW']).optional(),
          })
          .strict(),
        request.body,
      );
      const rule = await prisma.priceAlertRule.updateMany({
        where: { id, ...(request.auth!.role === 'ADMIN' ? {} : { userId: request.auth!.userId }) },
        data: input,
      });
      if (rule.count !== 1) throw notFound();
      return success(
        response,
        await prisma.priceAlertRule.findUnique({
          where: { id },
          include: { crop: true, market: true },
        }),
      );
    }),
  );

  router.delete(
    '/price-alert-rules/:id',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const rule = await prisma.priceAlertRule.deleteMany({
        where: { id, ...(request.auth!.role === 'ADMIN' ? {} : { userId: request.auth!.userId }) },
      });
      if (rule.count !== 1) throw notFound();
      return success(response, { deleted: true });
    }),
  );

  return router;
}
