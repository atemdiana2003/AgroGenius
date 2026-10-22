import jwt from 'jsonwebtoken';
import type { AppEnv } from '../config/env';

export function createAccessToken(user: { id: string; role: string }, env: AppEnv): string {
  return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: 'harvestguard-api',
    audience: 'harvestguard-client',
  });
}
