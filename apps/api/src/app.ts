import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { Prisma } from './prisma-client';
import type { PrismaClient } from './prisma-client';
import crypto from 'node:crypto';
import type { AppEnv } from './config/env';
import { AppError } from './common/errors';
import { authRoutes } from './routes/auth.routes';
import { batchesRoutes } from './routes/batches.routes';
import { preservationRoutes } from './routes/preservation.routes';
import { marketRoutes } from './routes/market.routes';
import { marketplaceRoutes } from './routes/marketplace.routes';
import { notificationRoutes } from './routes/notifications.routes';
import { adminRoutes } from './routes/admin.routes';
import { syncRoutes } from './routes/sync.routes';
import { reportRoutes } from './routes/reports.routes';
import { profileRoutes } from './routes/profile.routes';
import { farmsRoutes } from './routes/farms.routes';
import { unitRoutes } from './routes/units.routes';
import { paymentRoutes } from './routes/payments.routes';
import type { PaymentProvider } from './payments/provider';

export function createApp(prisma: PrismaClient, env: AppEnv, paymentProvider?: PaymentProvider) {
  const app = express();
  const logger = pino({
    level: env.LOG_LEVEL,
    redact: [
      'password',
      'passwordHash',
      'token',
      'refreshToken',
      'accessToken',
      'authorization',
      'cookie',
      'smsApiKey',
      'deviceKey',
    ],
  });

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.use((request, response, next) => {
    const supplied = request.header('x-request-id');
    const requestId =
      supplied && /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : crypto.randomUUID();
    response.setHeader('X-Request-Id', requestId);
    response.locals.requestId = requestId;
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (_request, response) => String(response.getHeader('X-Request-Id')),
      serializers: {
        req(request) {
          return { id: request.id, method: request.method, url: request.url };
        },
        res(response) {
          return { statusCode: response.statusCode };
        },
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed.'));
        }
      },
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 240,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_request, response) => {
        response.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests; retry later.',
            details: [],
            requestId: response.locals.requestId,
          },
        });
      },
    }),
  );
  app.use(express.json({ limit: '256kb', strict: true }));
  app.use(cookieParser());
  const cookieMutationOriginGuard: RequestHandler = (request, _response, next) => {
    if (
      request.cookies?.hg_refresh &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      (!request.header('origin') || !env.allowedOrigins.includes(request.header('origin')!))
    ) {
      next(
        new AppError(
          403,
          'CSRF_ORIGIN_REJECTED',
          'Cookie-authenticated requests must originate from an allowed application origin.',
        ),
      );
      return;
    }
    next();
  };
  app.use(cookieMutationOriginGuard);

  app.get('/health', (_request, response) =>
    response.status(200).json({
      data: { status: 'ok' },
      meta: {},
    }),
  );
  app.get('/ready', async (_request, response, next) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      response.status(200).json({ data: { status: 'ready' }, meta: {} });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api/auth', authRoutes(prisma, env));
  app.use('/api/auth/me', profileRoutes(prisma, env));
  app.use('/api/me', profileRoutes(prisma, env));
  app.use('/api/farms', farmsRoutes(prisma, env));
  app.use('/api/units', unitRoutes(prisma));
  app.use('/api/batches', batchesRoutes(prisma, env));
  app.use('/api', preservationRoutes(prisma, env));
  app.use('/api', marketRoutes(prisma, env));
  app.use('/api', marketplaceRoutes(prisma, env));
  app.use('/api/notifications', notificationRoutes(prisma, env));
  app.use('/api/admin', adminRoutes(prisma, env));
  app.use('/api/sync', syncRoutes(prisma, env));
  app.use('/api/reports', reportRoutes(prisma, env));
  app.use('/api/payments', paymentRoutes(prisma, env, paymentProvider));

  app.use((_request, response) => {
    response.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested endpoint was not found.',
        details: [],
        requestId: response.locals.requestId,
      },
    });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    void _next;
    let safeError: AppError;
    if (error instanceof AppError) {
      safeError = error;
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      safeError = new AppError(
        409,
        'DUPLICATE_RESOURCE',
        'A record with the supplied unique value already exists.',
      );
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      safeError = new AppError(
        409,
        'TRANSACTION_CONFLICT',
        'The operation conflicted with another update; retry safely.',
      );
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      safeError = new AppError(404, 'NOT_FOUND', 'The requested resource was not found.');
    } else if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2003' || error.code === 'P2004')
    ) {
      safeError = new AppError(
        error.code === 'P2003' ? 409 : 400,
        error.code === 'P2003' ? 'CONSTRAINT_CONFLICT' : 'VALIDATION_ERROR',
        'The operation violates a data integrity rule.',
      );
    } else if (error instanceof SyntaxError && 'body' in error) {
      safeError = new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      safeError = new AppError(
        413,
        'REQUEST_TOO_LARGE',
        'The request body exceeds the allowed size.',
      );
    } else {
      safeError = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
      logger.error({ err: error, requestId: response.locals.requestId }, 'request failed');
    }
    response.status(safeError.status).json({
      error: {
        code: safeError.code,
        message: safeError.message,
        details: safeError.details,
        requestId: response.locals.requestId,
      },
    });
  };
  app.use(errorHandler);
  return app;
}
