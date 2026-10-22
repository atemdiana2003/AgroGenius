import type { Unit } from '../prisma-client';
import type { Prisma, PrismaClient } from '../prisma-client';
import { AppError } from './errors';

export async function requireActiveUnit(
  client: Prisma.TransactionClient | PrismaClient,
  unit: Unit,
) {
  const reference = await client.unitReference.findUnique({
    where: { code: unit },
    select: { active: true },
  });
  if (!reference?.active) {
    throw new AppError(400, 'UNIT_UNAVAILABLE', 'The selected unit is inactive or unavailable.');
  }
}
