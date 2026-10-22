import { Router } from 'express';
import type { PrismaClient } from '../prisma-client';
import { asyncHandler, success } from '../common/http';

export function unitRoutes(prisma: PrismaClient) {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_request, response) => {
      const units = await prisma.unitReference.findMany({
        where: { active: true },
        select: { code: true, label: true, description: true },
        orderBy: { label: 'asc' },
      });
      return success(response, units);
    }),
  );

  return router;
}
