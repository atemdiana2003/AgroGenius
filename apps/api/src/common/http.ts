import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, infer as Infer } from 'zod';
import { AppError } from './errors';

export function validate<S extends ZodTypeAny>(schema: S, value: unknown): Infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'The request contains invalid fields.',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

export function asyncHandler(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export function success<T>(response: Response, data: T, status = 200, meta: object = {}) {
  return response.status(status).json({ data, meta });
}

export function pagination(query: Record<string, unknown>) {
  const page = Math.max(1, Math.min(100000, Number(query.page ?? 1)));
  const pageSize = Math.max(1, Math.min(100, Number(query.pageSize ?? 25)));
  if (!Number.isInteger(page) || !Number.isInteger(pageSize)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'page and pageSize must be integers.');
  }
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
