import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

const storage = new AsyncLocalStorage<{ correlationId: string }>();

export const CORRELATION_HEADER = 'x-correlation-id';

/** Everything awaited inside fn sees this correlation ID, with no parameter passing. */
export const runWithCorrelation = <T>(correlationId: string, fn: () => T): T =>
  storage.run({ correlationId }, fn);

export const currentCorrelationId = () => storage.getStore()?.correlationId ?? randomUUID();

export const createLogger = (service: string) =>
  pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    mixin: () => {
      const store = storage.getStore();
      return store ? { correlationId: store.correlationId } : {};
    },
  });

/** Express middleware: reuse the caller's correlation ID, or start a new one. */
export function correlationMiddleware(
  req: { headers: Record<string, string | string[] | undefined> },
  res: { setHeader(name: string, value: string): unknown },
  next: () => void,
) {
  const incoming = req.headers[CORRELATION_HEADER];
  const id = typeof incoming === 'string' ? incoming : randomUUID();
  res.setHeader(CORRELATION_HEADER, id);
  runWithCorrelation(id, next);
}
