import { Router } from 'express';
import type { Prisma, PrismaClient } from '../prisma-client';
import { BatchStatusSchema, CreateBatchSchema, IdSchema } from '@harvestguard/contracts';
import { z } from 'zod';
import type { AppEnv } from '../config/env';
import { AppError, notFound } from '../common/errors';
import { asyncHandler, pagination, success, validate } from '../common/http';
import { runIdempotent } from '../common/idempotency';
import { requireActiveUnit } from '../common/units';
import { requireAuth, requireRole } from '../middleware/auth';

const BatchPatchSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    notes: z.string().max(2000).nullable().optional(),
    storageUnitId: IdSchema.nullable().optional(),
    baselineCondition: z.string().max(1000).nullable().optional(),
  })
  .strict();
const MovementSchema = z.object({
  expectedVersion: z.number().int().positive(),
  delta: z
    .number()
    .finite()
    .refine(
      (value) => value !== 0 && Number.isInteger(value * 1000),
      'Use a non-zero quantity with no more than three decimal places.',
    ),
  reason: z.enum(['SPOILAGE', 'ADJUSTMENT', 'RELEASE']),
  note: z.string().trim().min(1).max(500),
});

export function batchesRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();
  router.use(requireAuth(prisma, env));

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where: Prisma.HarvestBatchWhereInput =
        request.auth!.role === 'ADMIN' ? {} : { ownerId: request.auth!.userId };
      if (typeof request.query.status === 'string') {
        where.status = validate(BatchStatusSchema, request.query.status);
      }
      if (typeof request.query.cropId === 'string') {
        where.cropId = validate(IdSchema, request.query.cropId);
      }
      if (typeof request.query.community === 'string') where.community = request.query.community;
      const [items, total] = await prisma.$transaction([
        prisma.harvestBatch.findMany({
          where,
          include: { crop: true, storageUnit: true, trialGroup: true },
          orderBy: { harvestAt: 'desc' },
          skip,
          take,
        }),
        prisma.harvestBatch.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  router.post(
    '/',
    requireRole('FARMER'),
    asyncHandler(async (request, response) => {
      const input = validate(CreateBatchSchema, request.body);
      if (new Date(input.harvestAt).getTime() > Date.now() + 5 * 60 * 1000) {
        throw new AppError(400, 'INVALID_HARVEST_DATE', 'Harvest time cannot be in the future.');
      }
      const result = await runIdempotent(
        prisma,
        {
          actorId: request.auth!.userId,
          clientOperationId: input.clientOperationId ?? request.header('Idempotency-Key'),
          entity: 'HarvestBatch',
          operation: 'CREATE',
          payload: input,
        },
        async (tx) => {
          await requireActiveUnit(tx, input.unit);
          const crop = await tx.crop.findUnique({ where: { id: input.cropId } });
          if (!crop?.active)
            throw new AppError(400, 'CROP_UNAVAILABLE', 'The selected crop is unavailable.');
          if (input.storageUnitId) {
            const unit = await tx.storageUnit.findFirst({
              where: {
                id: input.storageUnitId,
                OR: [{ ownerId: request.auth!.userId }, { ownerId: null }],
              },
            });
            if (!unit) throw notFound();
          }
          if (input.trialGroupId) {
            const group = await tx.trialGroup.findUnique({ where: { id: input.trialGroupId } });
            if (!group) throw notFound('The preservation trial group was not found.');
          }
          const created = await tx.harvestBatch.create({
            data: {
              ownerId: request.auth!.userId,
              cropId: input.cropId,
              harvestAt: new Date(input.harvestAt),
              initialQuantity: input.quantity,
              remainingQuantity: input.quantity,
              unit: input.unit,
              community: input.community,
              storageMethod: input.storageMethod,
              storageUnitId: input.storageUnitId,
              trialGroupId: input.trialGroupId,
              notes: input.notes,
              baselineCondition: input.baselineCondition,
            },
            include: { crop: true, storageUnit: true, trialGroup: true },
          });
          await tx.inventoryMovement.create({
            data: {
              batchId: created.id,
              actorId: request.auth!.userId,
              delta: input.quantity,
              reason: 'ADJUSTMENT',
              note: 'Initial recorded harvest quantity.',
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: request.auth!.userId,
              action: 'BATCH_CREATED',
              entityType: 'HarvestBatch',
              entityId: created.id,
            },
          });
          return created;
        },
      );
      response.setHeader('Idempotency-Replayed', String(result.replayed));
      return success(response, result.value, result.replayed ? 200 : 201);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const batch = await prisma.harvestBatch.findFirst({
        where: request.auth!.role === 'ADMIN' ? { id } : { id, ownerId: request.auth!.userId },
        include: {
          crop: true,
          storageUnit: true,
          trialGroup: true,
          movements: { orderBy: { createdAt: 'desc' } },
        },
      });
      if (!batch) throw notFound();
      return success(response, batch);
    }),
  );

  router.patch(
    '/:id',
    requireRole('FARMER', 'ADMIN'),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(BatchPatchSchema, request.body);
      const batch = await prisma.harvestBatch.findFirst({
        where: request.auth!.role === 'ADMIN' ? { id } : { id, ownerId: request.auth!.userId },
      });
      if (!batch) throw notFound();
      if (batch.version !== input.expectedVersion) {
        throw new AppError(409, 'VERSION_CONFLICT', 'The batch changed since it was loaded.', [
          { currentVersion: batch.version, currentStatus: batch.status },
        ]);
      }
      const changes = {
        notes: input.notes,
        storageUnitId: input.storageUnitId,
        baselineCondition: input.baselineCondition,
      };
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.harvestBatch.updateMany({
          where: {
            id,
            version: input.expectedVersion,
            ...(request.auth!.role === 'ADMIN' ? {} : { ownerId: request.auth!.userId }),
          },
          data: { ...changes, version: { increment: 1 } },
        });
        if (result.count !== 1)
          throw new AppError(409, 'VERSION_CONFLICT', 'The batch changed since it was loaded.');
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: 'BATCH_UPDATED',
            entityType: 'HarvestBatch',
            entityId: id,
          },
        });
        return tx.harvestBatch.findUnique({
          where: { id },
          include: { crop: true, storageUnit: true },
        });
      });
      return success(response, updated);
    }),
  );

  router.post(
    '/:id/movements',
    requireRole('FARMER', 'ADMIN'),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(MovementSchema, request.body);
      const result = await prisma.$transaction(
        async (tx) => {
          const batch = await tx.harvestBatch.findFirst({
            where: request.auth!.role === 'ADMIN' ? { id } : { id, ownerId: request.auth!.userId },
          });
          if (!batch) throw notFound();
          if (batch.version !== input.expectedVersion) {
            throw new AppError(409, 'VERSION_CONFLICT', 'The batch changed since it was loaded.', [
              {
                currentVersion: batch.version,
                remainingQuantity: batch.remainingQuantity.toString(),
              },
            ]);
          }
          const next = Number(batch.remainingQuantity) + input.delta;
          if (next < 0 || next > Number(batch.initialQuantity)) {
            throw new AppError(
              409,
              'INVENTORY_CONFLICT',
              'The adjustment would exceed the valid inventory range.',
            );
          }
          const listed = await tx.produceListing.aggregate({
            where: {
              batchId: id,
              status: { in: ['ACTIVE', 'PARTIALLY_SOLD', 'RESERVED'] },
              availableUntil: { gt: new Date() },
            },
            _sum: { remainingQuantity: true },
          });
          if (next < Number(listed._sum.remainingQuantity ?? 0)) {
            throw new AppError(
              409,
              'LISTING_INVENTORY_RESERVED',
              'Close or reduce active listings before decreasing available batch inventory.',
            );
          }
          if (next === 0 && input.reason !== 'SPOILAGE') {
            throw new AppError(
              400,
              'MOVEMENT_REASON_REQUIRED',
              'A zero balance must be recorded as a sale or spoilage, not an adjustment.',
            );
          }
          if (input.reason === 'SPOILAGE' && input.delta >= 0) {
            throw new AppError(
              400,
              'INVALID_MOVEMENT',
              'Spoilage movements must reduce inventory.',
            );
          }
          if (input.reason === 'RELEASE' && input.delta <= 0) {
            throw new AppError(
              400,
              'INVALID_MOVEMENT',
              'Release movements must increase inventory.',
            );
          }
          const updated = await tx.harvestBatch.updateMany({
            where: {
              id,
              version: input.expectedVersion,
              remainingQuantity: batch.remainingQuantity,
            },
            data: {
              remainingQuantity: next,
              version: { increment: 1 },
              status:
                next === 0 ? (input.reason === 'SPOILAGE' ? 'SPOILED' : 'SOLD') : batch.status,
            },
          });
          if (updated.count !== 1)
            throw new AppError(409, 'VERSION_CONFLICT', 'The batch changed during the adjustment.');
          const movement = await tx.inventoryMovement.create({
            data: {
              batchId: id,
              actorId: request.auth!.userId,
              delta: input.delta,
              reason: input.reason,
              note: input.note,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: request.auth!.userId,
              action: 'INVENTORY_ADJUSTED',
              entityType: 'HarvestBatch',
              entityId: id,
            },
          });
          return { movement, batch: await tx.harvestBatch.findUnique({ where: { id } }) };
        },
        { isolationLevel: 'Serializable' },
      );
      return success(response, result, 201);
    }),
  );

  router.post(
    '/:id/archive',
    requireRole('FARMER', 'ADMIN'),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(
        z.object({ expectedVersion: z.number().int().positive() }),
        request.body,
      );
      const changed = await prisma.harvestBatch.updateMany({
        where: {
          id,
          version: input.expectedVersion,
          ...(request.auth!.role === 'ADMIN' ? {} : { ownerId: request.auth!.userId }),
          remainingQuantity: 0,
          status: { in: ['SOLD', 'SPOILED'] },
        },
        data: { status: 'ARCHIVED', version: { increment: 1 } },
      });
      if (!changed.count) throw notFound('The batch cannot be archived or has changed.');
      const batch = await prisma.harvestBatch.findUnique({ where: { id } });
      return success(response, batch);
    }),
  );

  return router;
}
