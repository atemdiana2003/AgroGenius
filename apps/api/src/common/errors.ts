export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFound(message = 'The requested resource was not found.'): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function forbidden(message = 'You are not allowed to perform this action.'): AppError {
  return new AppError(403, 'FORBIDDEN', message);
}

export function unauthorized(message = 'Authentication is required.'): AppError {
  return new AppError(401, 'UNAUTHORIZED', message);
}
