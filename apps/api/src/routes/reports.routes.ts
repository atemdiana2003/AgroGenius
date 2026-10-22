import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../prisma-client';
import { IdSchema } from '@harvestguard/contracts';
import type { AppEnv } from '../config/env';
import { AppError, notFound } from '../common/errors';
import { asyncHandler, pagination, success, validate } from '../common/http';
import { requireAuth, requireRole } from '../middleware/auth';

export function reportRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();
  router.use(requireAuth(prisma, env));

  router.post(
    '/',
    requireRole('FARMER', 'BUYER'),
    asyncHandler(async (request, response) => {
      const input = validate(
        z.object({
          listingId: IdSchema.optional(),
          subject: z.string().trim().min(3).max(160),
          details: z.string().trim().min(5).max(2000),
        }),
        request.body,
      );
      if (input.listingId) {
        const listing = await prisma.produceListing.findUnique({
          where: { id: input.listingId },
          select: { id: true, ownerId: true },
        });
        if (!listing) throw notFound();
        if (listing.ownerId === request.auth!.userId) {
          throw new AppError(400, 'SELF_REPORT', 'You cannot report your own listing.');
        }
      }
      const report = await prisma.userReport.create({
        data: { ...input, authorId: request.auth!.userId },
      });
      return success(response, report, 201);
    }),
  );

  router.get(
    '/mine',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where = { authorId: request.auth!.userId };
      const [reports, total] = await prisma.$transaction([
        prisma.userReport.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.userReport.count({ where }),
      ]);
      return success(response, reports, 200, { page, pageSize, total });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const report = await prisma.userReport.findFirst({
        where: { id, authorId: request.auth!.userId },
      });
      if (!report) throw notFound();
      return success(response, report);
    }),
  );

  return router;
}
