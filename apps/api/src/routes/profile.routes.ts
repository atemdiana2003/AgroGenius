import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../prisma-client';
import type { AppEnv } from '../config/env';
import { AppError, notFound } from '../common/errors';
import { asyncHandler, success, validate } from '../common/http';
import { requireAuth } from '../middleware/auth';

const QuietHourSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  .nullable();

const ProfilePatchSchema = z
  .object({
    expectedVersion: z.number().int().positive().optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    community: z.string().trim().min(1).max(120).optional(),
    preferredLanguage: z.string().trim().min(2).max(12).optional(),
    cooperative: z.string().trim().max(160).nullable().optional(),
    smsConsent: z.boolean().optional(),
    smsOptOut: z.boolean().optional(),
    quietHoursStart: QuietHourSchema.optional(),
    quietHoursEnd: QuietHourSchema.optional(),
  })
  .strict();

const ProfileSelect = {
  id: true,
  displayName: true,
  phone: true,
  email: true,
  role: true,
  community: true,
  preferredLanguage: true,
  cooperative: true,
  smsConsent: true,
  smsOptOut: true,
  quietHoursStart: true,
  quietHoursEnd: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  version: true,
} as const;

export function profileRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();
  router.use(requireAuth(prisma, env));

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const user = await prisma.user.findUnique({
        where: { id: request.auth!.userId },
        select: ProfileSelect,
      });
      if (!user) throw notFound();
      return success(response, user);
    }),
  );

  router.patch(
    '/',
    asyncHandler(async (request, response) => {
      const input = validate(ProfilePatchSchema, request.body);
      const current = await prisma.user.findUnique({
        where: { id: request.auth!.userId },
        select: {
          id: true,
          version: true,
          smsConsent: true,
          smsOptOut: true,
          quietHoursStart: true,
          quietHoursEnd: true,
        },
      });
      if (!current) throw notFound();
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        throw new AppError(409, 'VERSION_CONFLICT', 'The profile changed since it was loaded.', [
          { currentVersion: current.version },
        ]);
      }

      const smsConsent = input.smsConsent ?? current.smsConsent;
      const smsOptOut = input.smsOptOut ?? current.smsOptOut;
      const quietHoursStart =
        input.quietHoursStart === undefined ? current.quietHoursStart : input.quietHoursStart;
      const quietHoursEnd =
        input.quietHoursEnd === undefined ? current.quietHoursEnd : input.quietHoursEnd;
      if (smsConsent && smsOptOut) {
        throw new AppError(
          400,
          'INVALID_SMS_PREFERENCES',
          'SMS consent and opt-out cannot both be enabled.',
        );
      }
      if ((quietHoursStart === null) !== (quietHoursEnd === null)) {
        throw new AppError(
          400,
          'INVALID_QUIET_HOURS',
          'Set both quiet-hour boundaries or clear both.',
        );
      }

      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.user.updateMany({
          where: { id: current.id, version: current.version },
          data: {
            displayName: input.displayName,
            community: input.community,
            preferredLanguage: input.preferredLanguage,
            cooperative: input.cooperative,
            smsConsent: input.smsConsent,
            smsOptOut: input.smsOptOut,
            quietHoursStart: input.quietHoursStart,
            quietHoursEnd: input.quietHoursEnd,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          throw new AppError(409, 'VERSION_CONFLICT', 'The profile changed during the update.');
        }
        const profile = await tx.user.findUnique({
          where: { id: current.id },
          select: ProfileSelect,
        });
        if (!profile) throw notFound();
        await tx.auditLog.create({
          data: {
            actorId: current.id,
            action: 'PROFILE_UPDATED',
            entityType: 'User',
            entityId: current.id,
            metadata: { fields: Object.keys(input).filter((field) => field !== 'expectedVersion') },
          },
        });
        return profile;
      });
      return success(response, updated);
    }),
  );

  return router;
}
