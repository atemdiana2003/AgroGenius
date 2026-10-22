import { Router } from 'express';
import type { PrismaClient } from '../prisma-client';
import { z } from 'zod';
import type { AppEnv } from '../config/env';
import { notFound } from '../common/errors';
import { asyncHandler, pagination, success, validate } from '../common/http';
import { requireAuth } from '../middleware/auth';

export function syncRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();
  router.use(requireAuth(prisma, env));

  router.get(
    '/operations',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where = { actorId: request.auth!.userId };
      const [items, total] = await prisma.$transaction([
        prisma.syncOperation.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.syncOperation.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  router.get(
    '/operations/:clientOperationId',
    asyncHandler(async (request, response) => {
      const clientOperationId = validate(
        z.string().min(1).max(100),
        request.params.clientOperationId,
      );
      const operation = await prisma.syncOperation.findUnique({
        where: { actorId_clientOperationId: { actorId: request.auth!.userId, clientOperationId } },
      });
      if (!operation) throw notFound('The synchronization operation was not found.');
      return success(response, operation);
    }),
  );

  return router;
}
