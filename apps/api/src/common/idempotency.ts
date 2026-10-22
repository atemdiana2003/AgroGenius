import type { Prisma, PrismaClient } from '../prisma-client';
import { AppError } from './errors';
import { hashToken } from './security';

export async function runIdempotent<T>(
  prisma: PrismaClient,
  input: {
    actorId: string;
    clientOperationId?: string;
    entity: string;
    operation: string;
    payload?: unknown;
  },
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  const requestHash = hashToken(JSON.stringify(input.payload ?? {}));
  if (!input.clientOperationId) return { value: await prisma.$transaction(work), replayed: false };
  const existing = await prisma.syncOperation.findUnique({
    where: {
      actorId_clientOperationId: {
        actorId: input.actorId,
        clientOperationId: input.clientOperationId,
      },
    },
  });
  if (existing) {
    if (
      existing.entity !== input.entity ||
      existing.operation !== input.operation ||
      existing.requestHash !== requestHash
    ) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This operation ID was already used for a different request.',
      );
    }
    if (existing.status === 'SUCCEEDED' && existing.result !== null) {
      return { value: existing.result as T, replayed: true };
    }
    if (existing.status === 'CONFLICT') {
      throw new AppError(
        409,
        'SYNC_PREVIOUS_CONFLICT',
        'The previous synchronization attempt conflicts with current data; resolve it using a new operation ID.',
        [{ errorCode: existing.safeErrorCode }],
      );
    }
    if (existing.status === 'FAILED') {
      throw new AppError(
        409,
        'SYNC_PREVIOUSLY_FAILED',
        'The previous synchronization attempt failed; correct the request and use a new operation ID.',
        [{ errorCode: existing.safeErrorCode }],
      );
    }
    throw new AppError(
      409,
      'SYNC_IN_PROGRESS',
      'An operation with this ID is already being processed.',
    );
  }
  try {
    const value = await prisma.$transaction(
      async (transaction) => {
        const operation = await transaction.syncOperation.create({
          data: {
            actorId: input.actorId,
            clientOperationId: input.clientOperationId!,
            entity: input.entity,
            operation: input.operation,
            requestHash,
            status: 'PROCESSING',
          },
        });
        const result = await work(transaction);
        const json = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
        await transaction.syncOperation.update({
          where: { id: operation.id },
          data: { status: 'SUCCEEDED', result: json, resultReference: extractId(result) },
        });
        return result;
      },
      { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 },
    );
    return { value, replayed: false };
  } catch (error) {
    const duplicate = await prisma.syncOperation.findUnique({
      where: {
        actorId_clientOperationId: {
          actorId: input.actorId,
          clientOperationId: input.clientOperationId,
        },
      },
    });
    if (duplicate?.status === 'SUCCEEDED' && duplicate.result !== null) {
      if (
        duplicate.entity !== input.entity ||
        duplicate.operation !== input.operation ||
        duplicate.requestHash !== requestHash
      ) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This operation ID was already used for a different request.',
        );
      }
      return { value: duplicate.result as T, replayed: true };
    }
    if (duplicate) {
      if (
        duplicate.entity !== input.entity ||
        duplicate.operation !== input.operation ||
        duplicate.requestHash !== requestHash
      ) {
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This operation ID was already used for a different request.',
        );
      }
      if (duplicate.status === 'CONFLICT' || duplicate.status === 'FAILED') {
        throw new AppError(
          409,
          duplicate.status === 'CONFLICT' ? 'SYNC_PREVIOUS_CONFLICT' : 'SYNC_PREVIOUSLY_FAILED',
          'The previous synchronization attempt was not successful; resolve it using a new operation ID.',
          [{ errorCode: duplicate.safeErrorCode }],
        );
      }
      throw new AppError(
        409,
        'SYNC_IN_PROGRESS',
        'An operation with this ID is already being processed.',
      );
    }

    if (error instanceof AppError || isKnownDatabaseConstraint(error)) {
      const status = error instanceof AppError && error.status === 409 ? 'CONFLICT' : 'FAILED';
      const safeErrorCode = error instanceof AppError ? error.code : 'CONSTRAINT_CONFLICT';
      try {
        await prisma.syncOperation.create({
          data: {
            actorId: input.actorId,
            clientOperationId: input.clientOperationId,
            entity: input.entity,
            operation: input.operation,
            requestHash,
            status,
            safeErrorCode,
          },
        });
      } catch (recordError) {
        if (!isUniqueConstraintError(recordError)) throw recordError;
        const raced = await prisma.syncOperation.findUnique({
          where: {
            actorId_clientOperationId: {
              actorId: input.actorId,
              clientOperationId: input.clientOperationId,
            },
          },
        });
        if (raced?.status === 'SUCCEEDED' && raced.result !== null) {
          if (
            raced.entity !== input.entity ||
            raced.operation !== input.operation ||
            raced.requestHash !== requestHash
          ) {
            throw new AppError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'This operation ID was already used for a different request.',
            );
          }
          return { value: raced.result as T, replayed: true };
        }
      }
    }

    throw error;
  }
}

function extractId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function isKnownDatabaseConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['P2002', 'P2003', 'P2004'].includes(String(error.code))
  );
}
