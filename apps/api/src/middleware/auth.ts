import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '../prisma-client';
import type { AppEnv } from '../config/env';
import { AppError, unauthorized } from '../common/errors';
import { asyncHandler } from '../common/http';
import type { PrismaClient } from '../prisma-client';

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; role: Role };
    }
  }
}

export function requireAuth(prisma: PrismaClient, env: AppEnv) {
  return asyncHandler(async (request: Request, _response: Response, next: NextFunction) => {
    const header = request.header('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const token = header.slice('Bearer '.length);
    let claims: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
      if (typeof decoded === 'string' || !decoded.sub || !decoded.role) throw unauthorized();
      claims = decoded;
    } catch {
      throw unauthorized('The access token is invalid or expired.');
    }
    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, role: true, active: true },
    });
    if (!user?.active) throw unauthorized();
    request.auth = { userId: user.id, role: user.role };
    next();
  });
}

export function requireRole(...roles: Role[]) {
  return (request: Request, _response: Response, next: NextFunction) => {
    if (!request.auth || !roles.includes(request.auth.role)) {
      next(new AppError(403, 'FORBIDDEN', 'You are not allowed to perform this action.'));
      return;
    }
    next();
  };
}
