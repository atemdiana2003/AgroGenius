import { Router } from 'express';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../prisma-client';
import { IdSchema, ReadingSchema } from '@harvestguard/contracts';
import type { AppEnv } from '../config/env';
import { AppError, notFound } from '../common/errors';
import { asyncHandler, pagination, success, validate } from '../common/http';
import { hashToken } from '../common/security';
import { runIdempotent } from '../common/idempotency';
import { requireActiveUnit } from '../common/units';
import { estimateMissingDays } from '../common/trial';
import { requireAuth, requireRole } from '../middleware/auth';

const QualitySchema = z.object({
  batchId: IdSchema,
  observedAt: z.string().datetime({ offset: true }),
  discardedQuantity: z
    .number()
    .finite()
    .min(0)
    .refine((value) => Number.isInteger(value * 1000), 'Use no more than three decimal places.'),
  unit: z.enum(['KG', 'CRATE', 'PIECE']),
  firmness: z.enum(['FIRM', 'SOFT', 'MIXED', 'NOT_ASSESSED']),
  visibleMold: z.boolean(),
  leakage: z.boolean(),
  shriveling: z.boolean(),
  qualityScore: z.number().int().min(1).max(5).optional(),
  notes: z.string().max(2000).optional(),
  clientOperationId: z.string().uuid().optional(),
});

const DeviceReadingSchema = z.object({
  batchId: IdSchema,
  sensorId: IdSchema,
  storageUnitId: IdSchema.optional(),
  recordedAt: z.string().datetime({ offset: true }),
  temperatureC: z.number().finite().min(-10).max(60),
  relativeHumidityPercent: z.number().finite().min(0).max(100),
  source: z.literal('SENSOR'),
  clientOperationId: z.string().uuid(),
});

export function preservationRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();

  router.post(
    '/readings',
    requireAuth(prisma, env),
    requireRole('FARMER', 'ADMIN'),
    asyncHandler(async (request, response) => {
      const input = validate(ReadingSchema, request.body);
      if (input.source === 'SENSOR') {
        throw new AppError(
          400,
          'DEVICE_AUTH_REQUIRED',
          'Hardware readings must use the device-authenticated endpoint.',
        );
      }
      if (
        input.temperatureC < env.TEMPERATURE_MIN_C ||
        input.temperatureC > env.TEMPERATURE_MAX_C
      ) {
        throw new AppError(
          400,
          'TEMPERATURE_OUT_OF_RANGE',
          'Temperature is outside the configured plausible input range.',
        );
      }
      if (input.recordedAt && new Date(input.recordedAt).getTime() > Date.now() + 5 * 60 * 1000) {
        throw new AppError(
          400,
          'INVALID_READING_TIME',
          'Reading time cannot be more than five minutes in the future.',
        );
      }
      const executed = await runIdempotent(
        prisma,
        {
          actorId: request.auth!.userId,
          clientOperationId: input.clientOperationId ?? request.header('Idempotency-Key'),
          entity: 'SensorReading',
          operation: 'CREATE',
          payload: input,
        },
        async (tx) => {
          const batch = await tx.harvestBatch.findFirst({
            where:
              request.auth!.role === 'ADMIN'
                ? { id: input.batchId }
                : { id: input.batchId, ownerId: request.auth!.userId },
          });
          if (!batch) throw notFound();
          if (
            input.storageUnitId &&
            batch.storageUnitId &&
            input.storageUnitId !== batch.storageUnitId
          ) {
            throw new AppError(
              400,
              'STORAGE_UNIT_MISMATCH',
              'The reading storage unit does not match the batch.',
            );
          }
          const reading = await tx.sensorReading.create({
            data: {
              batchId: input.batchId,
              actorId: request.auth!.userId,
              sensorId: null,
              storageUnitId: input.storageUnitId ?? batch.storageUnitId,
              recordedAt: new Date(input.recordedAt),
              temperatureC: input.temperatureC,
              relativeHumidityPercent: input.relativeHumidityPercent,
              source: input.source,
              metadata: input.source === 'SIMULATED' ? { label: 'SIMULATED TEST DATA' } : undefined,
              clientOperationId: input.clientOperationId,
            },
          });
          await createExperimentalWarning(tx, {
            recipientId: batch.ownerId,
            readingId: reading.id,
            temperatureC: input.temperatureC,
            relativeHumidityPercent: input.relativeHumidityPercent,
            env,
          });
          return reading;
        },
      );
      response.setHeader('Idempotency-Replayed', String(executed.replayed));
      return success(response, executed.value, executed.replayed ? 200 : 201);
    }),
  );

  router.post(
    '/device/readings',
    asyncHandler(async (request, response) => {
      const authorization = request.header('authorization');
      if (!authorization?.startsWith('Device ')) {
        throw new AppError(401, 'DEVICE_AUTH_REQUIRED', 'A device credential is required.');
      }
      const rawToken = authorization.slice('Device '.length);
      const credential = await prisma.deviceCredential.findUnique({
        where: { tokenHash: hashToken(`${env.DEVICE_TOKEN_PEPPER}:${rawToken}`) },
        include: { sensor: true, user: true },
      });
      const sensor = credential?.sensor;
      if (!credential?.active || !credential.user.active || !sensor?.active) {
        throw new AppError(
          401,
          'DEVICE_AUTH_INVALID',
          'The device credential is invalid or inactive.',
        );
      }
      const input = validate(DeviceReadingSchema, request.body);
      if (
        input.temperatureC < env.TEMPERATURE_MIN_C ||
        input.temperatureC > env.TEMPERATURE_MAX_C
      ) {
        throw new AppError(
          400,
          'TEMPERATURE_OUT_OF_RANGE',
          'Temperature is outside the configured plausible input range.',
        );
      }
      if (new Date(input.recordedAt).getTime() > Date.now() + 5 * 60 * 1000) {
        throw new AppError(
          400,
          'INVALID_READING_TIME',
          'Reading time cannot be more than five minutes in the future.',
        );
      }
      if (input.sensorId !== credential.sensorId) {
        throw new AppError(
          403,
          'DEVICE_SENSOR_MISMATCH',
          'The device is not authorized for this sensor.',
        );
      }
      const batch = await prisma.harvestBatch.findFirst({
        where: { id: input.batchId, ownerId: credential.userId },
      });
      if (!batch) throw notFound();
      if (batch.storageUnitId !== sensor.storageUnitId) {
        throw new AppError(
          400,
          'STORAGE_UNIT_MISMATCH',
          'The sensor and batch are not associated with the same storage unit.',
        );
      }
      const result = await runIdempotent(
        prisma,
        {
          actorId: credential.userId,
          clientOperationId: input.clientOperationId,
          entity: 'SensorReading',
          operation: 'DEVICE_CREATE',
          payload: input,
        },
        async (tx) => {
          const reading = await tx.sensorReading.create({
            data: {
              batchId: input.batchId,
              sensorId: credential.sensorId,
              storageUnitId: sensor.storageUnitId,
              recordedAt: new Date(input.recordedAt),
              temperatureC: input.temperatureC,
              relativeHumidityPercent: input.relativeHumidityPercent,
              source: 'SENSOR',
              metadata: { ingestion: 'authenticated-device' },
              clientOperationId: input.clientOperationId,
            },
          });
          await createExperimentalWarning(tx, {
            recipientId: credential.userId,
            readingId: reading.id,
            temperatureC: input.temperatureC,
            relativeHumidityPercent: input.relativeHumidityPercent,
            env,
          });
          return reading;
        },
      );
      await prisma.deviceCredential.update({
        where: { id: credential.id },
        data: { lastUsedAt: new Date() },
      });
      response.setHeader('Idempotency-Replayed', String(result.replayed));
      return success(response, result.value, result.replayed ? 200 : 201);
    }),
  );

  router.get(
    '/batches/:id/readings',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const batchId = validate(IdSchema, request.params.id);
      const { page, pageSize, skip, take } = pagination(request.query);
      const batch = await prisma.harvestBatch.findFirst({
        where:
          request.auth!.role === 'ADMIN'
            ? { id: batchId }
            : { id: batchId, ownerId: request.auth!.userId },
        select: { id: true },
      });
      if (!batch) throw notFound();
      const where = { batchId };
      const [items, total] = await prisma.$transaction([
        prisma.sensorReading.findMany({ where, orderBy: { recordedAt: 'asc' }, skip, take }),
        prisma.sensorReading.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  router.post(
    '/quality-observations',
    requireAuth(prisma, env),
    requireRole('FARMER', 'ADMIN'),
    asyncHandler(async (request, response) => {
      const input = validate(QualitySchema, request.body);
      if (new Date(input.observedAt).getTime() > Date.now() + 5 * 60 * 1000) {
        throw new AppError(
          400,
          'INVALID_OBSERVATION_TIME',
          'Observation time cannot be in the future.',
        );
      }
      const result = await runIdempotent(
        prisma,
        {
          actorId: request.auth!.userId,
          clientOperationId: input.clientOperationId ?? request.header('Idempotency-Key'),
          entity: 'QualityObservation',
          operation: 'CREATE',
          payload: input,
        },
        async (tx) => {
          const batch = await tx.harvestBatch.findFirst({
            where:
              request.auth!.role === 'ADMIN'
                ? { id: input.batchId }
                : { id: input.batchId, ownerId: request.auth!.userId },
          });
          if (!batch) throw notFound();
          if (input.unit !== batch.unit)
            throw new AppError(
              400,
              'UNIT_MISMATCH',
              'Observation quantity unit must match the batch.',
            );
          await requireActiveUnit(tx, input.unit);
          if (input.discardedQuantity > Number(batch.remainingQuantity)) {
            throw new AppError(
              400,
              'DISCARD_EXCEEDS_REMAINING',
              'Discarded quantity exceeds the remaining batch quantity.',
            );
          }
          const remainingAfterDiscard = Number(batch.remainingQuantity) - input.discardedQuantity;
          if (input.discardedQuantity > 0) {
            const activeListings = await tx.produceListing.aggregate({
              where: {
                batchId: batch.id,
                status: { in: ['ACTIVE', 'PARTIALLY_SOLD', 'RESERVED'] },
                availableUntil: { gt: new Date() },
              },
              _sum: { remainingQuantity: true },
            });
            if (Number(activeListings._sum.remainingQuantity ?? 0) > remainingAfterDiscard) {
              throw new AppError(
                409,
                'LISTING_INVENTORY_RESERVED',
                'Close or reduce active listings before recording spoilage that would over-promise inventory.',
              );
            }
          }
          const observation = await tx.qualityObservation.create({
            data: {
              batchId: input.batchId,
              observerId: request.auth!.userId,
              observedAt: new Date(input.observedAt),
              discardedQuantity: input.discardedQuantity,
              unit: input.unit,
              firmness: input.firmness,
              visibleMold: input.visibleMold,
              leakage: input.leakage,
              shriveling: input.shriveling,
              qualityScore: input.qualityScore,
              notes: input.notes,
              clientOperationId: input.clientOperationId,
            },
          });
          if (input.discardedQuantity > 0) {
            const updated = await tx.harvestBatch.updateMany({
              where: {
                id: batch.id,
                version: batch.version,
                remainingQuantity: batch.remainingQuantity,
              },
              data: {
                remainingQuantity: { decrement: input.discardedQuantity },
                version: { increment: 1 },
                status:
                  Number(batch.remainingQuantity) === input.discardedQuantity
                    ? 'SPOILED'
                    : batch.status,
              },
            });
            if (updated.count !== 1)
              throw new AppError(
                409,
                'VERSION_CONFLICT',
                'The batch changed while recording spoilage.',
              );
            await tx.inventoryMovement.create({
              data: {
                batchId: batch.id,
                actorId: request.auth!.userId,
                delta: -input.discardedQuantity,
                reason: 'SPOILAGE',
                note: 'Discarded quantity recorded in quality observation.',
              },
            });
          }
          return observation;
        },
      );
      response.setHeader('Idempotency-Replayed', String(result.replayed));
      return success(response, result.value, result.replayed ? 200 : 201);
    }),
  );

  router.get(
    '/trials/:id/comparison',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const trialGroupId = validate(IdSchema, request.params.id);
      const trial = await prisma.preservationTrial.findUnique({
        where: { id: trialGroupId },
        include: {
          groups: {
            include: {
              batches: {
                where: request.auth!.role === 'ADMIN' ? {} : { ownerId: request.auth!.userId },
                include: {
                  readings: { orderBy: { recordedAt: 'asc' } },
                  observations: { orderBy: { observedAt: 'asc' } },
                },
              },
            },
          },
        },
      });
      if (!trial || trial.groups.every((group) => group.batches.length === 0)) throw notFound();
      return success(response, {
        trial: {
          id: trial.id,
          label: trial.label,
          startedAt: trial.startedAt,
          endedAt: trial.endedAt,
          protocolNotes: trial.protocolNotes,
          limitationNotes: trial.limitationNotes,
        },
        groups: trial.groups.map((group) => ({
          id: group.id,
          label: group.label,
          type: group.type,
          initialMass: group.initialMass,
          unit: group.unit,
          batches: group.batches.map((batch) => ({
            id: batch.id,
            storageMethod: batch.storageMethod,
            initialMass: batch.initialQuantity,
            remainingSaleableMass: batch.remainingQuantity,
            readings: batch.readings,
            discardedQuantity: batch.observations.reduce(
              (sum, item) => sum + Number(item.discardedQuantity),
              0,
            ),
            observations: batch.observations,
            missingObservationDays: estimateMissingDays(
              trial.startedAt,
              trial.endedAt ?? new Date(),
              batch.observations.map((item) => item.observedAt),
            ),
          })),
        })),
        limitations: trial.limitationNotes,
        experimentalThresholds: {
          temperatureMinC: env.EXPERIMENTAL_TEMP_MIN_C,
          temperatureMaxC: env.EXPERIMENTAL_TEMP_MAX_C,
          relativeHumidityMinPercent: env.EXPERIMENTAL_RH_MIN_PERCENT,
          relativeHumidityMaxPercent: env.EXPERIMENTAL_RH_MAX_PERCENT,
          disclaimer:
            'Project comparison thresholds are experimental and are not universal food-safety limits or certifications.',
        },
      });
    }),
  );

  return router;
}

async function createExperimentalWarning(
  transaction: Prisma.TransactionClient,
  input: {
    recipientId: string;
    readingId: string;
    temperatureC: number;
    relativeHumidityPercent: number;
    env: AppEnv;
  },
) {
  const outOfRange =
    input.temperatureC < input.env.EXPERIMENTAL_TEMP_MIN_C ||
    input.temperatureC > input.env.EXPERIMENTAL_TEMP_MAX_C ||
    input.relativeHumidityPercent < input.env.EXPERIMENTAL_RH_MIN_PERCENT ||
    input.relativeHumidityPercent > input.env.EXPERIMENTAL_RH_MAX_PERCENT;
  if (!outOfRange) return;
  await transaction.notification.createMany({
    data: [
      {
        recipientId: input.recipientId,
        event: 'STORAGE_WARNING',
        payload: {
          readingId: input.readingId,
          temperatureC: input.temperatureC,
          relativeHumidityPercent: input.relativeHumidityPercent,
          label: 'EXPERIMENTAL PROJECT THRESHOLD',
          disclaimer: 'Not a universal food-safety limit or certification.',
        },
        channel: 'IN_APP',
        deliveryStatus: 'PENDING',
        deduplicationKey: `storage-reading:${input.readingId}`,
      },
    ],
    skipDuplicates: true,
  });
}
