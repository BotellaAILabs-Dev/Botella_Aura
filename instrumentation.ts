/**
 * Runs once when the server starts. Reports which integrations are
 * configured (variable names only — never values) so a missing or partly
 * pasted credential shows up in the deployment log at boot, not as a failed
 * webhook later. Never stops the app: every integration is optional.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { checkEnv, formatEnvReport } = await import('@/lib/env-check');
  const { logger } = await import('@/lib/logger');
  const production = process.env.VERCEL_ENV === 'production' || (process.env.NODE_ENV === 'production' && !process.env.VERCEL_ENV);
  const report = checkEnv(process.env, { production });
  const lines = formatEnvReport(report);
  if (report.errors.length) logger.error('environment: configuration problems', { report: lines });
  else logger.info('environment: configuration', { report: lines });
}
