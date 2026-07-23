/**
 * Minimal structured logger.
 * Swap the sink for a real service (Pino/Datadog/etc.) in a later sprint —
 * every call site already passes structured context, so the transport is the
 * only thing that changes.
 */
type LogContext = Record<string, unknown>;

function emit(
  level: 'info' | 'warn' | 'error',
  message: string,
  context?: LogContext,
) {
  const entry = {
    level,
    message,
    ...(context ? { context } : {}),
    time: new Date().toISOString(),
  };
  // eslint-disable-next-line no-console
  console[level](JSON.stringify(entry));
}

export const logger = {
  info: (message: string, context?: LogContext) =>
    emit('info', message, context),
  warn: (message: string, context?: LogContext) =>
    emit('warn', message, context),
  error: (message: string, context?: LogContext) =>
    emit('error', message, context),
};
