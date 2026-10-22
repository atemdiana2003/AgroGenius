import { Router } from 'express';
import type { Prisma, PrismaClient } from '../prisma-client';
import { ListingSchema, OfferSchema, IdSchema } from '@harvestguard/contracts';
import { z } from 'zod';
import type { AppEnv } from '../config/env';
import { AppError, notFound } from '../common/errors';
import { asyncHandler, pagination, success, validate } from '../common/http';
import { runIdempotent } from '../common/idempotency';
import { requireActiveUnit } from '../common/units';
import { requireAuth, requireRole } from '../middleware/auth';

const OfferPatchSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    status: z.enum(['ACCEPTED', 'REJECTED', 'WITHDRAWN']),
  })
  .strict();

export function marketplaceRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();

  router.get(
    '/listings',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where: Prisma.ProduceListingWhereInput = {
        status: { in: ['ACTIVE', 'PARTIALLY_SOLD'] },
        availableUntil: { gt: new Date() },
        remainingQuantity: { gt: 0 },
      };
      if (typeof request.query.cropId === 'string')
        where.batch = { cropId: validate(IdSchema, request.query.cropId) };
      if (typeof request.query.community === 'string')
        where.collectionArea = { contains: request.query.community, mode: 'insensitive' };
      if (typeof request.query.unit === 'string')
        where.unit = validate(z.enum(['KG', 'CRATE', 'PIECE']), request.query.unit);
      const [items, total] = await prisma.$transaction([
        prisma.produceListing.findMany({
          where,
          select: {
            id: true,
            batchId: true,
            quantity: true,
            remainingQuantity: true,
            unit: true,
            askingPrice: true,
            currency: true,
            availableFrom: true,
            availableUntil: true,
            collectionArea: true,
            contactPreference: true,
            contactConsent: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            batch: { select: { crop: { select: { id: true, name: true } }, harvestAt: true } },
            owner: { select: { displayName: true, community: true } },
          },
          orderBy: [{ availableUntil: 'asc' }, { createdAt: 'desc' }],
          skip,
          take,
        }),
        prisma.produceListing.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  router.post(
    '/listings',
    requireAuth(prisma, env),
    requireRole('FARMER'),
    asyncHandler(async (request, response) => {
      const input = validate(ListingSchema, request.body);
      if (input.askingPrice && !input.currency)
        throw new AppError(400, 'CURRENCY_REQUIRED', 'Currency is required with an asking price.');
      if (!input.askingPrice && input.currency)
        throw new AppError(400, 'PRICE_REQUIRED', 'An asking price is required with currency.');
      const until = new Date(input.availableUntil);
      if (until <= new Date())
        throw new AppError(400, 'INVALID_AVAILABILITY', 'Listing expiry must be in the future.');
      const result = await runIdempotent(
        prisma,
        {
          actorId: request.auth!.userId,
          clientOperationId: input.clientOperationId ?? request.header('Idempotency-Key'),
          entity: 'ProduceListing',
          operation: 'CREATE',
          payload: input,
        },
        async (tx) => {
          await requireActiveUnit(tx, input.unit);
          const batch = await tx.harvestBatch.findFirst({
            where: { id: input.batchId, ownerId: request.auth!.userId },
          });
          if (!batch) throw notFound();
          if (batch.unit !== input.unit)
            throw new AppError(400, 'UNIT_MISMATCH', 'Listing unit must match the batch unit.');
          if (input.quantity > Number(batch.remainingQuantity)) {
            throw new AppError(
              409,
              'INSUFFICIENT_INVENTORY',
              'Listing quantity exceeds remaining batch inventory.',
            );
          }
          const active = await tx.produceListing.aggregate({
            where: {
              batchId: batch.id,
              status: { in: ['ACTIVE', 'PARTIALLY_SOLD', 'RESERVED'] },
              availableUntil: { gt: new Date() },
            },
            _sum: { remainingQuantity: true },
          });
          const alreadyListed = Number(active._sum.remainingQuantity ?? 0);
          if (alreadyListed + input.quantity > Number(batch.remainingQuantity)) {
            throw new AppError(
              409,
              'INSUFFICIENT_UNLISTED_INVENTORY',
              'Other active listings already use this batch quantity.',
            );
          }
          const batchUpdated = await tx.harvestBatch.updateMany({
            where: {
              id: batch.id,
              version: batch.version,
              remainingQuantity: batch.remainingQuantity,
            },
            data: { version: { increment: 1 }, status: 'LISTED' },
          });
          if (batchUpdated.count !== 1) {
            throw new AppError(
              409,
              'VERSION_CONFLICT',
              'The batch changed while the listing was being published.',
            );
          }
          const created = await tx.produceListing.create({
            data: {
              ownerId: request.auth!.userId,
              batchId: batch.id,
              quantity: input.quantity,
              remainingQuantity: input.quantity,
              unit: input.unit,
              askingPrice: input.askingPrice,
              currency: input.currency,
              availableFrom: input.availableFrom ? new Date(input.availableFrom) : null,
              availableUntil: until,
              collectionArea: input.collectionArea,
              contactPreference: input.contactPreference,
              contactConsent: input.contactConsent,
            },
            include: { batch: { include: { crop: true } } },
          });
          await tx.auditLog.create({
            data: {
              actorId: request.auth!.userId,
              action: 'LISTING_CREATED',
              entityType: 'ProduceListing',
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
    '/listings/:id',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const listing = await prisma.produceListing.findUnique({
        where: { id },
        select: {
          id: true,
          quantity: true,
          remainingQuantity: true,
          unit: true,
          askingPrice: true,
          currency: true,
          availableFrom: true,
          availableUntil: true,
          collectionArea: true,
          contactPreference: true,
          contactConsent: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          batch: {
            select: {
              crop: { select: { id: true, name: true } },
              harvestAt: true,
              storageMethod: true,
            },
          },
          owner: { select: { displayName: true, community: true } },
        },
      });
      if (
        !listing ||
        !['ACTIVE', 'PARTIALLY_SOLD'].includes(listing.status) ||
        listing.availableUntil <= new Date()
      )
        throw notFound();
      return success(response, listing);
    }),
  );

  router.patch(
    '/listings/:id',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(
        z
          .object({
            expectedVersion: z.number().int().positive(),
            availableUntil: z.string().datetime({ offset: true }).optional(),
            collectionArea: z.string().trim().min(1).max(180).optional(),
            contactPreference: z.enum(['IN_APP', 'PHONE_AFTER_REQUEST']).optional(),
            contactConsent: z.boolean().optional(),
            status: z.enum(['ACTIVE', 'HIDDEN', 'EXPIRED']).optional(),
          })
          .strict(),
        request.body,
      );
      const listing = await prisma.produceListing.findFirst({
        where: { id, ...(request.auth!.role === 'ADMIN' ? {} : { ownerId: request.auth!.userId }) },
      });
      if (!listing) throw notFound();
      if (input.expectedVersion !== listing.version) {
        throw new AppError(409, 'VERSION_CONFLICT', 'The listing changed since it was loaded.', [
          { currentVersion: listing.version },
        ]);
      }
      const update = {
        availableUntil: input.availableUntil,
        collectionArea: input.collectionArea,
        contactPreference: input.contactPreference,
        contactConsent: input.contactConsent,
        status: input.status,
      };
      if (update.availableUntil && new Date(update.availableUntil) <= new Date()) {
        update.status = 'EXPIRED';
      }
      const updatedListing = await prisma.$transaction(async (tx) => {
        const changed = await tx.produceListing.updateMany({
          where: { id, version: listing.version },
          data: {
            ...update,
            ...(update.availableUntil ? { availableUntil: new Date(update.availableUntil) } : {}),
            version: { increment: 1 },
          },
        });
        if (!changed.count)
          throw new AppError(409, 'VERSION_CONFLICT', 'The listing changed during the update.');
        const updated = await tx.produceListing.findUnique({ where: { id } });
        if (!updated) throw notFound();
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: 'LISTING_UPDATED',
            entityType: 'ProduceListing',
            entityId: id,
          },
        });
        if (updated.status === 'ACTIVE' && listing.status !== 'ACTIVE') {
          await tx.harvestBatch.updateMany({
            where: { id: listing.batchId, status: 'STORED' },
            data: { status: 'LISTED', version: { increment: 1 } },
          });
        } else if (
          ['HIDDEN', 'EXPIRED'].includes(updated.status) &&
          ['ACTIVE', 'PARTIALLY_SOLD', 'RESERVED'].includes(listing.status)
        ) {
          const remainingListings = await tx.produceListing.count({
            where: {
              batchId: listing.batchId,
              id: { not: id },
              status: { in: ['ACTIVE', 'PARTIALLY_SOLD', 'RESERVED'] },
              availableUntil: { gt: new Date() },
            },
          });
          if (remainingListings === 0) {
            await tx.harvestBatch.updateMany({
              where: { id: listing.batchId, status: 'LISTED' },
              data: { status: 'STORED', version: { increment: 1 } },
            });
          }
        }
        return updated;
      });
      return success(response, updatedListing);
    }),
  );

  router.post(
    '/listings/:id/offers',
    requireAuth(prisma, env),
    requireRole('BUYER'),
    asyncHandler(async (request, response) => {
      const listingId = validate(IdSchema, request.params.id);
      const input = validate(OfferSchema, request.body);
      const listing = await prisma.produceListing.findUnique({ where: { id: listingId } });
      if (
        !listing ||
        !['ACTIVE', 'PARTIALLY_SOLD'].includes(listing.status) ||
        listing.availableUntil <= new Date() ||
        Number(listing.remainingQuantity) <= 0
      ) {
        throw new AppError(
          409,
          'LISTING_UNAVAILABLE',
          'The listing is no longer accepting offers.',
        );
      }
      if (listing.ownerId === request.auth!.userId)
        throw new AppError(400, 'SELF_OFFER', 'You cannot submit an offer to your own listing.');
      if (input.unit !== listing.unit || input.quantity > Number(listing.remainingQuantity)) {
        throw new AppError(
          400,
          'OFFER_MISMATCH',
          'Offer unit or quantity does not match current availability.',
        );
      }
      if (input.offeredPrice && !input.currency)
        throw new AppError(400, 'CURRENCY_REQUIRED', 'Currency is required with an offer price.');
      const result = await runIdempotent(
        prisma,
        {
          actorId: request.auth!.userId,
          clientOperationId: input.clientOperationId ?? request.header('Idempotency-Key'),
          entity: 'BuyerOffer',
          operation: 'CREATE',
          payload: input,
        },
        async (tx) => {
          await requireActiveUnit(tx, input.unit);
          const created = await tx.buyerOffer.create({
            data: {
              listingId,
              buyerId: request.auth!.userId,
              quantity: input.quantity,
              unit: input.unit,
              offeredPrice: input.offeredPrice,
              currency: input.currency,
              message: input.message,
            },
          });
          await tx.notification.create({
            data: {
              recipientId: listing.ownerId,
              event: 'BUYER_OFFER',
              payload: { offerId: created.id, listingId },
              channel: 'IN_APP',
              deliveryStatus: 'PENDING',
              deduplicationKey: `offer:${created.id}:received`,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: request.auth!.userId,
              action: 'OFFER_SUBMITTED',
              entityType: 'BuyerOffer',
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
    '/offers',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where: Prisma.BuyerOfferWhereInput =
        request.auth!.role === 'ADMIN'
          ? {}
          : request.auth!.role === 'BUYER'
            ? { buyerId: request.auth!.userId }
            : { listing: { ownerId: request.auth!.userId } };
      const [items, total] = await prisma.$transaction([
        prisma.buyerOffer.findMany({
          where,
          include: { listing: true },
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        prisma.buyerOffer.count({ where }),
      ]);
      return success(response, items, 200, { page, pageSize, total });
    }),
  );

  router.get(
    '/offers/:id',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const offer = await prisma.buyerOffer.findUnique({
        where: { id },
        include: {
          listing: {
            select: { id: true, ownerId: true, status: true, unit: true, remainingQuantity: true },
          },
        },
      });
      if (!offer) throw notFound();
      const permitted =
        request.auth!.role === 'ADMIN' ||
        (request.auth!.role === 'BUYER' && offer.buyerId === request.auth!.userId) ||
        (request.auth!.role === 'FARMER' && offer.listing.ownerId === request.auth!.userId);
      if (!permitted) throw notFound();
      return success(response, offer);
    }),
  );

  router.patch(
    '/offers/:id',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(OfferPatchSchema, request.body);
      const offer = await prisma.buyerOffer.findUnique({
        where: { id },
        include: { listing: true },
      });
      if (!offer) throw notFound();
      const isBuyer = offer.buyerId === request.auth!.userId && request.auth!.role === 'BUYER';
      const isOwner =
        offer.listing.ownerId === request.auth!.userId && request.auth!.role === 'FARMER';
      const isAdmin = request.auth!.role === 'ADMIN';
      if (input.status === 'WITHDRAWN' ? !isBuyer : !(isOwner || isAdmin)) {
        throw new AppError(
          403,
          'FORBIDDEN',
          'Only the buyer can withdraw; only the listing owner or administrator can decide an offer.',
        );
      }
      if (offer.version !== input.expectedVersion) {
        throw new AppError(409, 'VERSION_CONFLICT', 'The offer changed since it was loaded.', [
          { currentVersion: offer.version },
        ]);
      }
      if (offer.status !== 'PENDING' || offer.confirmedAt) {
        throw new AppError(
          409,
          'INVALID_OFFER_TRANSITION',
          'Only a pending, unconfirmed offer can be updated.',
        );
      }
      if (
        input.status === 'ACCEPTED' &&
        (!['ACTIVE', 'PARTIALLY_SOLD'].includes(offer.listing.status) ||
          offer.listing.availableUntil <= new Date() ||
          Number(offer.quantity) > Number(offer.listing.remainingQuantity) ||
          (offer.listing.askingPrice !== null &&
            offer.offeredPrice !== null &&
            offer.currency !== offer.listing.currency))
      ) {
        throw new AppError(
          409,
          'LISTING_UNAVAILABLE',
          'The listing can no longer accept this offer.',
        );
      }
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.buyerOffer.updateMany({
          where: { id, version: input.expectedVersion, status: 'PENDING' },
          data: { status: input.status, version: { increment: 1 } },
        });
        if (!result.count)
          throw new AppError(409, 'VERSION_CONFLICT', 'The offer changed during the update.');
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: `OFFER_${input.status}`,
            entityType: 'BuyerOffer',
            entityId: id,
          },
        });
        return tx.buyerOffer.findUnique({ where: { id }, include: { listing: true } });
      });
      return success(response, updated);
    }),
  );

  router.post(
    '/offers/:id/confirm-sale',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(
        z.object({ expectedVersion: z.number().int().positive() }),
        request.body,
      );
      const result = await prisma.$transaction(
        async (tx) => {
          const offer = await tx.buyerOffer.findUnique({
            where: { id },
            include: { listing: true },
          });
          if (!offer) throw notFound();
          if (
            request.auth!.role !== 'ADMIN' &&
            !(request.auth!.role === 'FARMER' && offer.listing.ownerId === request.auth!.userId)
          ) {
            throw new AppError(403, 'FORBIDDEN', 'Only the listing owner can confirm this sale.');
          }
          if (offer.status !== 'ACCEPTED' || offer.confirmedAt) {
            throw new AppError(
              409,
              'INVALID_SALE_STATE',
              'Only an accepted, unconfirmed offer can be recorded as a sale.',
            );
          }
          if (offer.version !== input.expectedVersion) {
            throw new AppError(409, 'VERSION_CONFLICT', 'The offer changed since it was loaded.', [
              { currentVersion: offer.version },
            ]);
          }
          const batch = await tx.harvestBatch.findUnique({ where: { id: offer.listing.batchId } });
          if (!batch) throw notFound();
          const quantity = Number(offer.quantity);
          if (
            quantity > Number(offer.listing.remainingQuantity) ||
            quantity > Number(batch.remainingQuantity)
          ) {
            throw new AppError(
              409,
              'INSUFFICIENT_INVENTORY',
              'Available inventory is lower than the accepted offer.',
            );
          }
          const listingResult = await tx.produceListing.updateMany({
            where: {
              id: offer.listingId,
              version: offer.listing.version,
              remainingQuantity: { gte: quantity },
            },
            data: {
              remainingQuantity: { decrement: quantity },
              version: { increment: 1 },
              status:
                Number(offer.listing.remainingQuantity) === quantity ? 'SOLD' : 'PARTIALLY_SOLD',
            },
          });
          const batchResult = await tx.harvestBatch.updateMany({
            where: { id: batch.id, version: batch.version, remainingQuantity: { gte: quantity } },
            data: {
              remainingQuantity: { decrement: quantity },
              version: { increment: 1 },
              status: Number(batch.remainingQuantity) === quantity ? 'SOLD' : 'PARTIALLY_SOLD',
            },
          });
          if (listingResult.count !== 1 || batchResult.count !== 1) {
            throw new AppError(
              409,
              'INVENTORY_CONFLICT',
              'Inventory changed during sale confirmation.',
            );
          }
          const confirmedAt = new Date();
          const offerResult = await tx.buyerOffer.updateMany({
            where: { id, version: offer.version, confirmedAt: null },
            data: { confirmedAt, version: { increment: 1 } },
          });
          if (!offerResult.count)
            throw new AppError(409, 'VERSION_CONFLICT', 'This sale has already been recorded.');
          const movement = await tx.inventoryMovement.create({
            data: {
              batchId: batch.id,
              actorId: request.auth!.userId,
              delta: -quantity,
              reason: 'SALE',
              note: `Confirmed sale for offer ${offer.id}.`,
              listingId: offer.listingId,
              offerId: offer.id,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: request.auth!.userId,
              action: 'SALE_CONFIRMED',
              entityType: 'BuyerOffer',
              entityId: offer.id,
            },
          });
          return { offerId: offer.id, confirmedAt, movement };
        },
        { isolationLevel: 'Serializable' },
      );
      return success(response, result, 201);
    }),
  );

  router.post(
    '/listings/:id/contact-requests',
    requireAuth(prisma, env),
    requireRole('BUYER'),
    asyncHandler(async (request, response) => {
      const listingId = validate(IdSchema, request.params.id);
      const input = validate(
        z.object({ message: z.string().max(1000).optional() }),
        request.body ?? {},
      );
      const listing = await prisma.produceListing.findUnique({ where: { id: listingId } });
      if (
        !listing ||
        !['ACTIVE', 'PARTIALLY_SOLD'].includes(listing.status) ||
        listing.availableUntil <= new Date()
      )
        throw notFound();
      if (listing.ownerId === request.auth!.userId)
        throw new AppError(
          400,
          'SELF_CONTACT',
          'You cannot request contact from your own listing.',
        );
      const contactRequest = await prisma.$transaction(async (tx) => {
        const created = await tx.contactRequest.create({
          data: { listingId, requesterId: request.auth!.userId, message: input.message },
        });
        await tx.notification.create({
          data: {
            recipientId: listing.ownerId,
            event: 'CONTACT_REQUEST',
            payload: { contactRequestId: created.id, listingId },
            channel: 'IN_APP',
            deliveryStatus: 'PENDING',
            deduplicationKey: `contact-request:${created.id}`,
          },
        });
        return created;
      });
      return success(response, contactRequest, 201);
    }),
  );

  router.patch(
    '/contact-requests/:id',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(z.object({ status: z.enum(['APPROVED', 'REJECTED']) }), request.body);
      const contact = await prisma.contactRequest.findUnique({
        where: { id },
        include: { listing: true },
      });
      if (!contact) throw notFound();
      if (
        request.auth!.role !== 'ADMIN' &&
        !(request.auth!.role === 'FARMER' && contact.listing.ownerId === request.auth!.userId)
      ) {
        throw new AppError(
          403,
          'FORBIDDEN',
          'Only the listing owner can decide a contact request.',
        );
      }
      if (
        input.status === 'APPROVED' &&
        (contact.listing.contactPreference !== 'PHONE_AFTER_REQUEST' ||
          !contact.listing.contactConsent)
      ) {
        throw new AppError(
          403,
          'CONTACT_NOT_CONSENTED',
          'This listing has not consented to phone contact sharing.',
        );
      }
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.contactRequest.updateMany({
          where: { id, status: 'REQUESTED' },
          data: { status: input.status, reviewedAt: new Date() },
        });
        if (!result.count) {
          throw new AppError(
            409,
            'CONTACT_REQUEST_ALREADY_REVIEWED',
            'This contact request has already been reviewed.',
          );
        }
        const changed = await tx.contactRequest.findUnique({ where: { id } });
        if (!changed) throw notFound();
        await tx.auditLog.create({
          data: {
            actorId: request.auth!.userId,
            action: `CONTACT_REQUEST_${input.status}`,
            entityType: 'ContactRequest',
            entityId: id,
          },
        });
        return changed;
      });
      return success(response, updated);
    }),
  );

  router.get(
    '/contact-requests/:id',
    requireAuth(prisma, env),
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const contact = await prisma.contactRequest.findUnique({
        where: { id },
        include: { listing: { include: { owner: true } }, requester: true },
      });
      if (!contact) throw notFound();
      const isBuyer =
        contact.requesterId === request.auth!.userId && request.auth!.role === 'BUYER';
      const isOwner =
        contact.listing.ownerId === request.auth!.userId && request.auth!.role === 'FARMER';
      if (!isBuyer && !isOwner && request.auth!.role !== 'ADMIN') throw notFound();
      const contactDetails =
        isBuyer && contact.status === 'APPROVED' && contact.listing.contactConsent
          ? { phone: contact.listing.owner.phone }
          : undefined;
      return success(response, {
        id: contact.id,
        status: contact.status,
        createdAt: contact.createdAt,
        requester: isOwner ? { displayName: contact.requester.displayName } : undefined,
        owner: isBuyer
          ? {
              displayName: contact.listing.owner.displayName,
              community: contact.listing.owner.community,
            }
          : undefined,
        contactDetails,
      });
    }),
  );

  return router;
}
