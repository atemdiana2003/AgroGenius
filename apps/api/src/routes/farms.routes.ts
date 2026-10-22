import { Router } from 'express';
import { z } from 'zod';
import { IdSchema } from '@harvestguard/contracts';
import type { PrismaClient } from '../prisma-client';
import type { AppEnv } from '../config/env';
import { AppError, notFound } from '../common/errors';
import { asyncHandler, pagination, success, validate } from '../common/http';
import { requireAuth, requireRole } from '../middleware/auth';

const CoordinateSchema = z.number().finite();
const FarmCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    community: z.string().trim().min(1).max(120),
    latitude: CoordinateSchema.min(-90).max(90).optional(),
    longitude: CoordinateSchema.min(-180).max(180).optional(),
  })
  .strict()
  .refine(
    (farm) => (farm.latitude === undefined) === (farm.longitude === undefined),
    'Provide both coordinates or neither.',
  );

const FarmPatchSchema = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(160).optional(),
    community: z.string().trim().min(1).max(120).optional(),
    latitude: CoordinateSchema.min(-90).max(90).nullable().optional(),
    longitude: CoordinateSchema.min(-180).max(180).nullable().optional(),
  })
  .strict();

export function farmsRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();
  router.use(requireAuth(prisma, env), requireRole('FARMER'));

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where = { ownerId: request.auth!.userId, active: true };
      const [items, total] = await prisma.$transaction([
        prisma.farm.findMany({ where, orderBy: { name: 'asc' }, skip, take }),
        prisma.farm.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (request, response) => {
      const input = validate(FarmCreateSchema, request.body);
      const farm = await prisma.$transaction(async (tx) => {
        const created = await tx.farm.create({ data: { ...input, ownerId: request.auth!.userId } });
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: 'FARM_CREATED',
            entityType: 'Farm',
            entityId: created.id,
          },
        });
        return created;
      });
      return success(response, farm, 201);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const farm = await prisma.farm.findFirst({
        where: { id, ownerId: request.auth!.userId, active: true },
      });
      if (!farm) throw notFound();
      return success(response, farm);
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(FarmPatchSchema, request.body);
      const farm = await prisma.farm.findFirst({
        where: { id, ownerId: request.auth!.userId, active: true },
      });
      if (!farm) throw notFound();
      if (input.expectedVersion !== undefined && input.expectedVersion !== farm.version) {
        throw new AppError(409, 'VERSION_CONFLICT', 'The farm changed since it was loaded.', [
          { currentVersion: farm.version },
        ]);
      }
      const changes = {
        name: input.name,
        community: input.community,
        latitude: input.latitude,
        longitude: input.longitude,
      };
      const latitude =
        changes.latitude === undefined
          ? farm.latitude === null
            ? null
            : Number(farm.latitude)
          : changes.latitude;
      const longitude =
        changes.longitude === undefined
          ? farm.longitude === null
            ? null
            : Number(farm.longitude)
          : changes.longitude;
      if ((latitude === null) !== (longitude === null)) {
        throw new AppError(400, 'INVALID_COORDINATES', 'Set both coordinates or clear both.');
      }
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.farm.updateMany({
          where: { id, ownerId: request.auth!.userId, active: true, version: farm.version },
          data: { ...changes, version: { increment: 1 } },
        });
        if (result.count !== 1) {
          throw new AppError(409, 'VERSION_CONFLICT', 'The farm changed during the update.');
        }
        const value = await tx.farm.findUnique({ where: { id } });
        if (!value) throw notFound();
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: 'FARM_UPDATED',
            entityType: 'Farm',
            entityId: id,
          },
        });
        return value;
      });
      return success(response, updated);
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const farm = await prisma.farm.findFirst({
        where: { id, ownerId: request.auth!.userId, active: true },
      });
      if (!farm) throw notFound();
      const archived = await prisma.$transaction(async (tx) => {
        const result = await tx.farm.updateMany({
          where: { id, ownerId: request.auth!.userId, active: true, version: farm.version },
          data: { active: false, version: { increment: 1 } },
        });
        if (result.count !== 1) {
          throw new AppError(409, 'VERSION_CONFLICT', 'The farm changed during the update.');
        }
        const value = await tx.farm.findUnique({ where: { id } });
        if (!value) throw notFound();
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: 'FARM_ARCHIVED',
            entityType: 'Farm',
            entityId: id,
          },
        });
        return value;
      });
      return success(response, archived);
    }),
  );

  return router;
}
