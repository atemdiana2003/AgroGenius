import { Router } from 'express';
import type { Prisma, PrismaClient } from '../prisma-client';
import { IdSchema } from '@harvestguard/contracts';
import { z } from 'zod';
import type { AppEnv } from '../config/env';
import { AppError, notFound } from '../common/errors';
import { asyncHandler, pagination, success, validate } from '../common/http';
import { escapeCsv, hashToken, randomToken } from '../common/security';
import { requireActiveUnit } from '../common/units';
import { estimateMissingDays } from '../common/trial';
import { requireAuth, requireRole } from '../middleware/auth';

const CropSchema = z.object({
  name: z.string().trim().min(1).max(100),
  validatedForTrial: z.boolean().default(false),
  active: z.boolean().default(true),
});
const MarketSchema = z.object({
  name: z.string().trim().min(1).max(160),
  community: z.string().trim().min(1).max(120),
  region: z.string().trim().min(1).max(120),
});
const TrialSchema = z.object({
  label: z.string().trim().min(1).max(120),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).optional(),
  protocolNotes: z.string().max(4000).optional(),
  limitationNotes: z.string().max(4000).optional(),
  isDemo: z.boolean().default(false),
});
const TrialGroupSchema = z.object({
  trialId: IdSchema,
  label: z.string().trim().min(1).max(120),
  type: z.enum(['COOLER_TEST', 'SHADED_CONTROL']),
  initialMass: z
    .number()
    .finite()
    .positive()
    .refine((value) => Number.isInteger(value * 1000), 'Use no more than three decimal places.'),
  unit: z.enum(['KG', 'CRATE', 'PIECE']).default('KG'),
  notes: z.string().max(2000).optional(),
});

export function adminRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();
  router.use(requireAuth(prisma, env), requireRole('ADMIN'));

  router.get(
    '/units',
    asyncHandler(async (_request, response) => {
      const units = await prisma.unitReference.findMany({ orderBy: { code: 'asc' } });
      return success(response, units);
    }),
  );
  router.patch(
    '/units/:code',
    asyncHandler(async (request, response) => {
      const code = validate(z.enum(['KG', 'CRATE', 'PIECE']), request.params.code);
      const input = validate(
        z
          .object({
            label: z.string().trim().min(1).max(80).optional(),
            description: z.string().trim().max(240).nullable().optional(),
            active: z.boolean().optional(),
          })
          .strict(),
        request.body,
      );
      const unit = await prisma.$transaction(async (tx) => {
        const updated = await tx.unitReference.update({ where: { code }, data: input });
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: 'UNIT_REFERENCE_UPDATED',
            entityType: 'UnitReference',
            entityId: code,
            metadata: input,
          },
        });
        return updated;
      });
      return success(response, unit);
    }),
  );

  router.post(
    '/crops',
    asyncHandler(async (request, response) => {
      const input = validate(CropSchema, request.body);
      return success(response, await prisma.crop.create({ data: input }), 201);
    }),
  );
  router.patch(
    '/crops/:id',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(
        z
          .object({
            name: z.string().trim().min(1).max(100).optional(),
            validatedForTrial: z.boolean().optional(),
            active: z.boolean().optional(),
          })
          .strict(),
        request.body,
      );
      const crop = await prisma.$transaction(async (tx) => {
        const updated = await tx.crop.update({ where: { id }, data: input });
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: 'CROP_REFERENCE_UPDATED',
            entityType: 'Crop',
            entityId: id,
            metadata: input,
          },
        });
        return updated;
      });
      return success(response, crop);
    }),
  );
  router.post(
    '/markets',
    asyncHandler(async (request, response) => {
      const input = validate(MarketSchema, request.body);
      return success(response, await prisma.market.create({ data: input }), 201);
    }),
  );
  router.patch(
    '/markets/:id',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(
        z
          .object({
            name: z.string().trim().min(1).max(160).optional(),
            community: z.string().trim().min(1).max(120).optional(),
            region: z.string().trim().min(1).max(120).optional(),
            active: z.boolean().optional(),
          })
          .strict(),
        request.body,
      );
      const market = await prisma.$transaction(async (tx) => {
        const updated = await tx.market.update({ where: { id }, data: input });
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: 'MARKET_REFERENCE_UPDATED',
            entityType: 'Market',
            entityId: id,
            metadata: input,
          },
        });
        return updated;
      });
      return success(response, market);
    }),
  );
  router.post(
    '/trials',
    asyncHandler(async (request, response) => {
      const input = validate(TrialSchema, request.body);
      if (input.endedAt && new Date(input.endedAt) < new Date(input.startedAt)) {
        throw new AppError(
          400,
          'INVALID_TRIAL_DATES',
          'Trial end time must be after its start time.',
        );
      }
      return success(
        response,
        await prisma.preservationTrial.create({
          data: {
            ...input,
            startedAt: new Date(input.startedAt),
            endedAt: input.endedAt ? new Date(input.endedAt) : null,
          },
        }),
        201,
      );
    }),
  );
  router.post(
    '/trial-groups',
    asyncHandler(async (request, response) => {
      const input = validate(TrialGroupSchema, request.body);
      await requireActiveUnit(prisma, input.unit);
      const trial = await prisma.preservationTrial.findUnique({
        where: { id: input.trialId },
        select: { id: true },
      });
      if (!trial) throw notFound('The preservation trial was not found.');
      return success(response, await prisma.trialGroup.create({ data: input }), 201);
    }),
  );

  router.post(
    '/storage-units',
    asyncHandler(async (request, response) => {
      const input = validate(
        z.object({
          label: z.string().trim().min(1).max(120),
          method: z.enum(['COOLER', 'SHADED_CONTROL', 'OTHER']),
          community: z.string().trim().min(1).max(120),
        }),
        request.body,
      );
      return success(
        response,
        await prisma.storageUnit.create({
          data: { ...input, isDemo: input.label.toLowerCase().includes('demo') },
        }),
        201,
      );
    }),
  );

  router.post(
    '/sensors',
    asyncHandler(async (request, response) => {
      const input = validate(
        z.object({
          storageUnitId: IdSchema,
          identity: z.string().trim().min(1).max(160),
          sensorType: z.string().trim().min(1).max(100),
          calibrationNotes: z.string().max(2000).optional(),
        }),
        request.body,
      );
      const sensor = await prisma.sensor.create({ data: input });
      return success(response, sensor, 201);
    }),
  );

  router.post(
    '/devices',
    asyncHandler(async (request, response) => {
      const input = validate(
        z.object({
          userId: IdSchema,
          sensorId: IdSchema,
          label: z.string().trim().min(1).max(120),
        }),
        request.body,
      );
      const [user, sensor] = await Promise.all([
        prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, role: true } }),
        prisma.sensor.findUnique({ where: { id: input.sensorId } }),
      ]);
      if (!user || user.role !== 'FARMER' || !sensor)
        throw notFound('The farmer or sensor was not found.');
      const rawToken = randomToken();
      const device = await prisma.deviceCredential.create({
        data: {
          userId: input.userId,
          sensorId: input.sensorId,
          label: input.label,
          tokenHash: hashToken(`${env.DEVICE_TOKEN_PEPPER}:${rawToken}`),
        },
      });
      return success(response, { id: device.id, label: device.label, token: rawToken }, 201);
    }),
  );

  router.get(
    '/metrics',
    asyncHandler(async (_request, response) => {
      const [
        activeFarmers,
        buyers,
        batches,
        listings,
        offers,
        notifications,
        priceObservations,
        completedBuyerConnections,
        listedQuantityByUnit,
        spoilageByUnit,
      ] = await Promise.all([
        prisma.user.count({ where: { role: 'FARMER', active: true } }),
        prisma.user.count({ where: { role: 'BUYER', active: true } }),
        prisma.harvestBatch.count(),
        prisma.produceListing.count(),
        prisma.buyerOffer.count(),
        prisma.notification.count(),
        prisma.priceObservation.count(),
        prisma.buyerOffer.count({ where: { confirmedAt: { not: null } } }),
        prisma.produceListing.groupBy({
          by: ['unit'],
          where: {
            status: { in: ['ACTIVE', 'PARTIALLY_SOLD', 'RESERVED'] },
            availableUntil: { gt: new Date() },
          },
          _sum: { remainingQuantity: true },
        }),
        prisma.qualityObservation.groupBy({
          by: ['unit'],
          _sum: { discardedQuantity: true },
        }),
      ]);
      return success(response, {
        activeFarmers,
        buyers,
        recordedHarvestBatches: batches,
        listings,
        listedQuantityByUnit: listedQuantityByUnit.map((item) => ({
          unit: item.unit,
          quantity: item._sum.remainingQuantity?.toString() ?? '0',
        })),
        offers,
        notificationsAndAlerts: notifications,
        validPriceObservations: priceObservations,
        observedSpoilageQuantityByUnit: spoilageByUnit.map((item) => ({
          unit: item.unit,
          quantity: item._sum.discardedQuantity?.toString() ?? '0',
        })),
        completedBuyerConnections,
        definitions: {
          completedBuyerConnections: 'Offers with an owner-recorded confirmedAt timestamp.',
          observedSpoilage:
            'Sum of discardedQuantity recorded in quality observations; not an inferred loss rate.',
          lossReductionOrProfit:
            'Not calculated; requires a measured baseline and suitable comparison evidence.',
        },
      });
    }),
  );

  router.get(
    '/reports',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where: Prisma.UserReportWhereInput = {};
      if (typeof request.query.status === 'string') {
        where.status = validate(
          z.enum(['OPEN', 'REVIEWED', 'RESOLVED', 'DISMISSED']),
          request.query.status,
        );
      }
      const [items, total] = await prisma.$transaction([
        prisma.userReport.findMany({
          where,
          include: {
            author: { select: { id: true, displayName: true, role: true } },
            listing: { select: { id: true, status: true } },
          },
          orderBy: { createdAt: 'asc' },
          skip,
          take,
        }),
        prisma.userReport.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  router.patch(
    '/reports/:id',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(
        z.object({
          status: z.enum(['REVIEWED', 'RESOLVED', 'DISMISSED']),
          outcome: z.string().trim().min(1).max(2000),
        }),
        request.body,
      );
      const updated = await prisma.$transaction(async (tx) => {
        const report = await tx.userReport.update({
          where: { id },
          data: { ...input, moderatorId: request.auth!.userId },
        });
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: `REPORT_${input.status}`,
            entityType: 'UserReport',
            entityId: id,
            metadata: { outcome: input.outcome },
          },
        });
        return report;
      });
      return success(response, updated);
    }),
  );

  router.post(
    '/listings/:id/moderate',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(
        z.object({
          status: z.enum(['ACTIVE', 'HIDDEN', 'EXPIRED']),
          note: z.string().trim().min(1).max(1000),
        }),
        request.body,
      );
      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.produceListing.update({
          where: { id },
          data: { status: input.status, moderationNote: input.note, version: { increment: 1 } },
        });
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: `LISTING_MODERATED_${input.status}`,
            entityType: 'ProduceListing',
            entityId: id,
            metadata: { note: input.note },
          },
        });
        return changed;
      });
      return success(response, updated);
    }),
  );

  router.get(
    '/exports/batches.csv',
    asyncHandler(async (request, response) => {
      const { skip, take } = pagination(request.query);
      const [batches, total] = await prisma.$transaction([
        prisma.harvestBatch.findMany({
          include: { crop: true, trialGroup: true },
          orderBy: { createdAt: 'asc' },
          skip,
          take,
        }),
        prisma.harvestBatch.count(),
      ]);
      const headers = [
        'batch_id',
        'crop',
        'harvest_at_utc',
        'initial_quantity',
        'remaining_quantity',
        'unit',
        'status',
        'community',
        'storage_method',
        'trial_group',
        'trial_type',
      ];
      const lines = batches.map((batch) =>
        [
          batch.id,
          batch.crop.name,
          batch.harvestAt.toISOString(),
          batch.initialQuantity.toString(),
          batch.remainingQuantity.toString(),
          batch.unit,
          batch.status,
          batch.community,
          batch.storageMethod,
          batch.trialGroup?.label ?? '',
          batch.trialGroup?.type ?? '',
        ]
          .map(escapeCsv)
          .join(','),
      );
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', 'attachment; filename="harvestguard-batches.csv"');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Export-Total', String(total));
      response.status(200).send([headers.map(escapeCsv).join(','), ...lines].join('\r\n'));
    }),
  );

  router.get(
    '/exports/prices.csv',
    asyncHandler(async (request, response) => {
      const { skip, take } = pagination(request.query);
      const [prices, total] = await prisma.$transaction([
        prisma.priceObservation.findMany({
          include: { crop: true, market: true },
          orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
          skip,
          take,
        }),
        prisma.priceObservation.count(),
      ]);
      const headers = [
        'observation_id',
        'crop',
        'market',
        'community',
        'region',
        'amount',
        'currency',
        'price_unit',
        'observed_at_utc',
        'source',
        'demo_data',
      ];
      const lines = prices.map((price) =>
        [
          price.id,
          price.crop.name,
          price.market.name,
          price.market.community,
          price.market.region,
          price.amount.toString(),
          price.currency,
          price.unit,
          price.observedAt.toISOString(),
          price.source,
          price.isDemo ? 'DEMO ONLY' : 'NO',
        ]
          .map(escapeCsv)
          .join(','),
      );
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', 'attachment; filename="harvestguard-prices.csv"');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Export-Total', String(total));
      response.status(200).send([headers.map(escapeCsv).join(','), ...lines].join('\r\n'));
    }),
  );

  router.get(
    '/exports/readings.csv',
    asyncHandler(async (request, response) => {
      const { skip, take } = pagination(request.query);
      const [readings, total] = await prisma.$transaction([
        prisma.sensorReading.findMany({
          include: {
            batch: { include: { crop: true } },
            sensor: { select: { identity: true } },
            storageUnit: { select: { label: true } },
          },
          orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
          skip,
          take,
        }),
        prisma.sensorReading.count(),
      ]);
      const headers = [
        'reading_id',
        'recorded_at_utc',
        'ingested_at_utc',
        'temperature_c',
        'relative_humidity_percent',
        'source',
        'simulated',
        'batch_id',
        'crop',
        'sensor_identity',
        'storage_unit',
        'provenance',
      ];
      const lines = readings.map((reading) =>
        [
          reading.id,
          reading.recordedAt.toISOString(),
          reading.ingestedAt.toISOString(),
          reading.temperatureC.toString(),
          reading.relativeHumidityPercent.toString(),
          reading.source,
          reading.source === 'SIMULATED' ? 'YES' : 'NO',
          reading.batchId,
          reading.batch.crop.name,
          reading.sensor?.identity ?? '',
          reading.storageUnit?.label ?? '',
          reading.metadata === null ? '' : JSON.stringify(reading.metadata),
        ]
          .map(escapeCsv)
          .join(','),
      );
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', 'attachment; filename="harvestguard-readings.csv"');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Export-Total', String(total));
      response.status(200).send([headers.map(escapeCsv).join(','), ...lines].join('\r\n'));
    }),
  );

  router.get(
    '/exports/quality-observations.csv',
    asyncHandler(async (request, response) => {
      const { skip, take } = pagination(request.query);
      const [observations, total] = await prisma.$transaction([
        prisma.qualityObservation.findMany({
          include: {
            batch: {
              include: {
                crop: true,
                trialGroup: { select: { label: true, type: true } },
              },
            },
          },
          orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
          skip,
          take,
        }),
        prisma.qualityObservation.count(),
      ]);
      const headers = [
        'observation_id',
        'observed_at_utc',
        'batch_id',
        'crop',
        'trial_group',
        'trial_type',
        'firmness',
        'visible_mold',
        'leakage',
        'shriveling',
        'quality_score',
        'discarded_quantity',
        'unit',
      ];
      const lines = observations.map((observation) =>
        [
          observation.id,
          observation.observedAt.toISOString(),
          observation.batchId,
          observation.batch.crop.name,
          observation.batch.trialGroup?.label ?? '',
          observation.batch.trialGroup?.type ?? '',
          observation.firmness,
          observation.visibleMold,
          observation.leakage,
          observation.shriveling,
          observation.qualityScore ?? '',
          observation.discardedQuantity.toString(),
          observation.unit,
        ]
          .map(escapeCsv)
          .join(','),
      );
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader(
        'Content-Disposition',
        'attachment; filename="harvestguard-quality-observations.csv"',
      );
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Export-Total', String(total));
      response.status(200).send([headers.map(escapeCsv).join(','), ...lines].join('\r\n'));
    }),
  );

  router.get(
    '/exports/trial-comparisons.csv',
    asyncHandler(async (request, response) => {
      const { skip, take } = pagination(request.query);
      const [batches, total] = await prisma.$transaction([
        prisma.harvestBatch.findMany({
          where: { trialGroupId: { not: null } },
          include: {
            crop: true,
            trialGroup: { include: { trial: true } },
            observations: {
              select: { observedAt: true },
              orderBy: { observedAt: 'asc' },
              take: 366,
            },
            _count: { select: { readings: true, observations: true } },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take,
        }),
        prisma.harvestBatch.count({ where: { trialGroupId: { not: null } } }),
      ]);
      const batchIds = batches.map((batch) => batch.id);
      const discardedByBatch = batchIds.length
        ? await prisma.qualityObservation.groupBy({
            by: ['batchId'],
            where: { batchId: { in: batchIds } },
            _sum: { discardedQuantity: true },
          })
        : [];
      const discardedById = new Map(
        discardedByBatch.map((item) => [
          item.batchId,
          item._sum.discardedQuantity?.toString() ?? '0',
        ]),
      );
      const headers = [
        'trial_id',
        'trial',
        'trial_started_at_utc',
        'trial_ended_at_utc',
        'protocol',
        'limitations',
        'trial_demo',
        'group_id',
        'group',
        'group_type',
        'initial_group_mass',
        'unit',
        'batch_id',
        'crop',
        'initial_mass',
        'remaining_saleable_mass',
        'discarded_quantity',
        'reading_count',
        'quality_observation_count',
        'missing_observation_days_utc',
        'observation_dates_truncated',
      ];
      const lines = batches.map((batch) => {
        const group = batch.trialGroup!;
        const trial = group.trial;
        const missingDays = estimateMissingDays(
          trial.startedAt,
          trial.endedAt ?? new Date(),
          batch.observations.map((observation) => observation.observedAt),
        );
        return [
          trial.id,
          trial.label,
          trial.startedAt.toISOString(),
          trial.endedAt?.toISOString() ?? '',
          trial.protocolNotes ?? '',
          trial.limitationNotes ?? '',
          trial.isDemo ? 'DEMO ONLY' : 'NO',
          group.id,
          group.label,
          group.type,
          group.initialMass.toString(),
          group.unit,
          batch.id,
          batch.crop.name,
          batch.initialQuantity.toString(),
          batch.remainingQuantity.toString(),
          discardedById.get(batch.id) ?? '0',
          batch._count.readings,
          batch._count.observations,
          missingDays.join(';'),
          batch._count.observations > batch.observations.length ? 'YES' : 'NO',
        ]
          .map(escapeCsv)
          .join(',');
      });
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader(
        'Content-Disposition',
        'attachment; filename="harvestguard-trial-comparisons.csv"',
      );
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Export-Total', String(total));
      response.status(200).send([headers.map(escapeCsv).join(','), ...lines].join('\r\n'));
    }),
  );

  router.get(
    '/audit',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where: Prisma.AuditLogWhereInput = {};
      if (typeof request.query.entityType === 'string') where.entityType = request.query.entityType;
      if (typeof request.query.entityId === 'string') where.entityId = request.query.entityId;
      const [items, total] = await prisma.$transaction([
        prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.auditLog.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  return router;
}
