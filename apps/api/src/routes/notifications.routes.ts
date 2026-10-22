import { Router } from 'express';
import { Prisma, type PrismaClient } from '../prisma-client';
import { IdSchema } from '@harvestguard/contracts';
import { z } from 'zod';
import type { AppEnv } from '../config/env';
import { AppError, notFound } from '../common/errors';
import { asyncHandler, pagination, success, validate } from '../common/http';
import { requireAuth } from '../middleware/auth';

export function notificationRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();
  router.use(requireAuth(prisma, env));

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const { page, pageSize, skip, take } = pagination(request.query);
      const where = { recipientId: request.auth!.userId, channel: 'IN_APP' as const };
      const [items, total, unread] = await prisma.$transaction([
        prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { ...where, readAt: null } }),
      ]);
      return success(response, items, 200, { page, pageSize, total, unread });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const input = validate(z.object({ read: z.boolean() }).strict(), request.body);
      const changed = await prisma.notification.updateMany({
        where: { id, recipientId: request.auth!.userId, channel: 'IN_APP' },
        data: {
          readAt: input.read ? new Date() : null,
          ...(input.read ? { deliveryStatus: 'READ' } : {}),
        },
      });
      if (!changed.count) throw notFound();
      return success(response, await prisma.notification.findUnique({ where: { id } }));
    }),
  );

  router.post(
    '/:id/sms',
    asyncHandler(async (request, response) => {
      const id = validate(IdSchema, request.params.id);
      const source = await prisma.notification.findFirst({
        where: { id, recipientId: request.auth!.userId, channel: 'IN_APP' },
        include: { recipient: true },
      });
      if (!source) throw notFound();
      const user = source.recipient;
      if (!user.phone || !user.smsConsent || user.smsOptOut) {
        throw new AppError(
          403,
          'SMS_NOT_CONSENTED',
          'SMS requires a phone number and current opt-in consent.',
        );
      }
      if (isQuietNow(user.quietHoursStart, user.quietHoursEnd)) {
        throw new AppError(
          409,
          'SMS_QUIET_HOURS',
          'SMS delivery is deferred during configured quiet hours.',
        );
      }
      if (env.SMS_PROVIDER === 'disabled') {
        return success(response, {
          notification: null,
          provider: 'DISABLED',
          notice: 'SMS is not configured; no message was queued or attempted.',
        });
      }
      const sms = await prisma.notification.upsert({
        where: { deduplicationKey: `sms:${source.id}` },
        create: {
          recipientId: user.id,
          event: source.event,
          payload: source.payload === null ? Prisma.JsonNull : source.payload,
          channel: 'SMS',
          deliveryStatus: 'PENDING',
          deduplicationKey: `sms:${source.id}`,
          attempts: 0,
        },
        update: {},
      });
      if (sms.deliveryStatus === 'SENT' || sms.deliveryStatus === 'SIMULATED') {
        return success(response, { notification: sms, reused: true });
      }
      if (sms.attempts >= 3)
        throw new AppError(409, 'RETRY_LIMIT_REACHED', 'SMS retry limit has been reached.');
      const updated = await prisma.notification.update({
        where: { id: sms.id },
        data: {
          attempts: { increment: 1 },
          deliveryStatus: 'SIMULATED',
          safeError: null,
        },
      });
      return success(response, {
        notification: updated,
        provider: 'SIMULATED_NOOP',
        notice: 'No real SMS was sent; delivery is simulated.',
      });
    }),
  );

  return router;
}

function isQuietNow(start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Douala',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
  const now = Number(parts.slice(0, 2)) * 60 + Number(parts.slice(3, 5));
  const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const from = toMinutes(start);
  const until = toMinutes(end);
  return from <= until ? now >= from && now < until : now >= from || now < until;
}
