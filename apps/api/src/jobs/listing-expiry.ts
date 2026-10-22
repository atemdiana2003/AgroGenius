import type { PrismaClient } from '../prisma-client';

export async function processListingExpiry(
  prisma: PrismaClient,
  now = new Date(),
): Promise<number> {
  const expiringBefore = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const expiringSoon = await prisma.produceListing.findMany({
    where: {
      status: { in: ['ACTIVE', 'PARTIALLY_SOLD', 'RESERVED'] },
      availableUntil: { gt: now, lte: expiringBefore },
    },
    select: { id: true, ownerId: true, availableUntil: true },
  });
  if (expiringSoon.length) {
    await prisma.notification.createMany({
      data: expiringSoon.map((listing) => ({
        recipientId: listing.ownerId,
        event: 'LISTING_EXPIRING' as const,
        payload: {
          listingId: listing.id,
          expiresAt: listing.availableUntil.toISOString(),
          notice: 'Listing expires within 24 hours.',
        },
        channel: 'IN_APP' as const,
        deliveryStatus: 'PENDING' as const,
        deduplicationKey: `listing-expiring:${listing.id}`,
      })),
      skipDuplicates: true,
    });
  }

  const expired = await prisma.produceListing.findMany({
    where: {
      status: { in: ['ACTIVE', 'PARTIALLY_SOLD', 'RESERVED'] },
      availableUntil: { lte: now },
    },
    select: { id: true, ownerId: true, batchId: true, availableUntil: true },
  });
  if (expired.length === 0) return 0;

  await prisma.$transaction(async (tx) => {
    for (const listing of expired) {
      const updated = await tx.produceListing.updateMany({
        where: {
          id: listing.id,
          status: { in: ['ACTIVE', 'PARTIALLY_SOLD', 'RESERVED'] },
          availableUntil: { lte: now },
        },
        data: { status: 'EXPIRED', version: { increment: 1 } },
      });
      if (!updated.count) continue;
      await tx.notification.createMany({
        data: [
          {
            recipientId: listing.ownerId,
            event: 'LISTING_EXPIRING',
            payload: { listingId: listing.id, expiredAt: listing.availableUntil.toISOString() },
            channel: 'IN_APP',
            deliveryStatus: 'PENDING',
            deduplicationKey: `listing-expired:${listing.id}`,
          },
        ],
        skipDuplicates: true,
      });
      await tx.auditLog.create({
        data: {
          action: 'LISTING_EXPIRED',
          entityType: 'ProduceListing',
          entityId: listing.id,
          metadata: { expiredAt: listing.availableUntil.toISOString() },
        },
      });
      const remainingListings = await tx.produceListing.count({
        where: {
          batchId: listing.batchId,
          id: { not: listing.id },
          status: { in: ['ACTIVE', 'PARTIALLY_SOLD', 'RESERVED'] },
          availableUntil: { gt: now },
        },
      });
      if (remainingListings === 0) {
        await tx.harvestBatch.updateMany({
          where: { id: listing.batchId, status: 'LISTED' },
          data: { status: 'STORED', version: { increment: 1 } },
        });
      }
    }
  });
  return expired.length;
}
