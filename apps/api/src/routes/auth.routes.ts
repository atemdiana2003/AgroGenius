import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import argon2 from 'argon2';
import type { PrismaClient } from '../prisma-client';
import { LoginSchema, RegisterSchema } from '@harvestguard/contracts';
import { z } from 'zod';
import type { AppEnv } from '../config/env';
import { AppError, unauthorized } from '../common/errors';
import { createAccessToken } from '../common/auth';
import { hashToken, isValidNormalizedPhone, normalizePhone, randomToken } from '../common/security';
import { asyncHandler, success, validate } from '../common/http';

const ResetRequestSchema = z.object({ identifier: z.string().trim().min(3).max(254) });
const ResetConfirmSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(12).max(128),
});
const LogoutSchema = z.object({ refreshToken: z.string().min(20).max(200).optional() });

type RefreshTransport = 'cookie' | 'body';

function refreshTransport(request: {
  header: (name: string) => string | undefined;
}): RefreshTransport {
  const configured = request.header('x-refresh-transport') ?? 'cookie';
  if (configured !== 'cookie' && configured !== 'body') {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'X-Refresh-Transport must be either cookie or body.',
    );
  }
  return configured;
}

function deliverRefreshToken(
  response: Response,
  env: AppEnv,
  transport: RefreshTransport,
  token: string,
  expiresAt: Date,
) {
  if (transport === 'cookie') {
    response.cookie('hg_refresh', token, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/api/auth',
      expires: expiresAt,
    });
    return {};
  }
  return { refreshToken: token };
}

function publicUser(user: {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  role: string;
  community: string;
  preferredLanguage: string;
  smsConsent: boolean;
  createdAt: Date;
}) {
  return {
    id: user.id,
    displayName: user.displayName,
    phone: user.phone,
    email: user.email,
    role: user.role,
    community: user.community,
    preferredLanguage: user.preferredLanguage,
    smsConsent: user.smsConsent,
    createdAt: user.createdAt,
  };
}

export function authRoutes(prisma: PrismaClient, env: AppEnv) {
  const router = Router();
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_request, response) => {
      response.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many authentication requests; retry later.',
          details: [],
          requestId: response.locals.requestId,
        },
      });
    },
  });

  router.post(
    '/register',
    authLimiter,
    asyncHandler(async (request, response) => {
      const input = validate(RegisterSchema, request.body);
      const phone = input.phone ? normalizePhone(input.phone) : null;
      if (phone && !isValidNormalizedPhone(phone)) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'Provide a valid phone number in international or local digits format.',
          [{ path: 'phone', message: 'Phone number must contain 7 to 15 digits.' }],
        );
      }
      const email = input.email?.toLowerCase() ?? null;
      const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
      const user = await prisma.user.create({
        data: {
          displayName: input.displayName,
          phone,
          email,
          passwordHash,
          role: input.role,
          community: input.community,
          preferredLanguage: input.preferredLanguage,
          smsConsent: input.smsConsent,
        },
      });
      return success(response, publicUser(user), 201);
    }),
  );

  router.post(
    '/login',
    authLimiter,
    asyncHandler(async (request, response) => {
      const input = validate(LoginSchema, request.body);
      const transport = refreshTransport(request);
      const identifier = input.identifier.includes('@')
        ? input.identifier.toLowerCase()
        : normalizePhone(input.identifier);
      const user = await prisma.user.findFirst({
        where: input.identifier.includes('@') ? { email: identifier } : { phone: identifier },
      });
      if (!user?.active || !(await argon2.verify(user.passwordHash, input.password))) {
        throw unauthorized('The supplied credentials are invalid.');
      }
      const refreshToken = randomToken();
      const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400000);
      await prisma.refreshToken.create({
        data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiresAt },
      });
      const refresh = deliverRefreshToken(response, env, transport, refreshToken, refreshExpiresAt);
      return success(response, {
        user: publicUser(user),
        accessToken: createAccessToken(user, env),
        tokenType: 'Bearer',
        expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
        ...refresh,
      });
    }),
  );

  router.post(
    '/refresh',
    authLimiter,
    asyncHandler(async (request, response) => {
      const transport = refreshTransport(request);
      const token =
        transport === 'cookie' ? request.cookies?.hg_refresh : request.body?.refreshToken;
      if (typeof token !== 'string') throw unauthorized('A refresh token is required.');
      const tokenHash = hashToken(token);
      const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (!stored || stored.revokedAt || stored.expiresAt <= new Date() || !stored.user.active) {
        throw unauthorized('The refresh token is invalid or expired.');
      }
      const nextToken = randomToken();
      const nextExpiry = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400000);
      await prisma.$transaction(async (tx) => {
        const revoked = await tx.refreshToken.updateMany({
          where: { id: stored.id, revokedAt: null, expiresAt: { gt: new Date() } },
          data: { revokedAt: new Date() },
        });
        if (revoked.count !== 1) throw unauthorized('The refresh token has already been used.');
        await tx.refreshToken.create({
          data: { userId: stored.userId, tokenHash: hashToken(nextToken), expiresAt: nextExpiry },
        });
      });
      const refresh = deliverRefreshToken(response, env, transport, nextToken, nextExpiry);
      return success(response, {
        user: publicUser(stored.user),
        accessToken: createAccessToken(stored.user, env),
        tokenType: 'Bearer',
        expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
        ...refresh,
      });
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (request, response) => {
      const input = validate(LogoutSchema, request.body ?? {});
      const transport = refreshTransport(request);
      const token = transport === 'cookie' ? request.cookies?.hg_refresh : input.refreshToken;
      if (typeof token === 'string') {
        await prisma.refreshToken.updateMany({
          where: { tokenHash: hashToken(token), revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      response.clearCookie('hg_refresh', {
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: 'lax',
        path: '/api/auth',
      });
      return success(response, { loggedOut: true });
    }),
  );

  router.post(
    '/password-reset/request',
    authLimiter,
    asyncHandler(async (request, response) => {
      const { identifier } = validate(ResetRequestSchema, request.body);
      if (env.NODE_ENV === 'production') {
        throw new AppError(
          503,
          'RESET_DELIVERY_UNAVAILABLE',
          'Password reset delivery is not configured. Contact the service administrator.',
        );
      }
      const user = await prisma.user.findFirst({
        where: identifier.includes('@')
          ? { email: identifier.toLowerCase(), active: true }
          : { phone: normalizePhone(identifier), active: true },
      });
      let devResetToken: string | undefined;
      if (user) {
        const token = randomToken();
        const expiresAt = new Date(Date.now() + env.RESET_TOKEN_TTL_MINUTES * 60000);
        await prisma.$transaction(async (tx) => {
          await tx.passwordResetToken.updateMany({
            where: { userId: user.id, usedAt: null },
            data: { usedAt: new Date() },
          });
          await tx.passwordResetToken.create({
            data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
          });
        });
        if (env.NODE_ENV === 'development') devResetToken = token;
      }
      return success(response, {
        message: 'If the account exists, reset instructions will be provided.',
        ...(devResetToken ? { developmentOnlyResetToken: devResetToken } : {}),
      });
    }),
  );

  router.post(
    '/password-reset/confirm',
    authLimiter,
    asyncHandler(async (request, response) => {
      const input = validate(ResetConfirmSchema, request.body);
      const tokenHash = hashToken(input.token);
      const stored = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
      if (!stored || stored.usedAt || stored.expiresAt <= new Date()) {
        throw new AppError(400, 'RESET_TOKEN_INVALID', 'The reset token is invalid or expired.');
      }
      const passwordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.passwordResetToken.updateMany({
          where: { id: stored.id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
        if (claimed.count !== 1) {
          throw new AppError(400, 'RESET_TOKEN_INVALID', 'The reset token is invalid or expired.');
        }
        await tx.user.update({
          where: { id: stored.userId },
          data: { passwordHash, version: { increment: 1 } },
        });
        await tx.refreshToken.updateMany({
          where: { userId: stored.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
      return success(response, { passwordReset: true });
    }),
  );

  return router;
}
