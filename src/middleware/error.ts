import type { ErrorHandler } from 'hono';
import { AppError } from '../errors';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as any);
  }

  // PostgreSQL unique violation
  if ((err as any).code === '23505') {
    return c.json(
      { error: { code: 'CONFLICT', message: 'Resource already exists' } },
      409 as any,
    );
  }

  console.error('Unhandled error:', err);
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    500 as any,
  );
};
