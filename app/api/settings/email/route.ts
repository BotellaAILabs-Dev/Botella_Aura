import { requireActiveCompany } from '@/lib/auth-helpers';
import { can } from '@/lib/rbac';
import {
  activeEmailTransport,
  describeEmailTransport,
  emailConfigProblems,
  isEmailConfigured,
  sendTestEmail,
} from '@/lib/email';
import { getAppUrl, isLocalAppUrl } from '@/lib/app-url';
import { recordAudit } from '@/server/services/audit.service';
import { getRequestMeta, handleRouteError, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Email delivery diagnostics.
 *
 * GET  — is a provider configured, which one, and what's missing.
 * POST — actually send a test message to the signed-in user and report the
 *        real provider response.
 *
 * This exists because "the UI said Mail Sent but nothing arrived" is
 * unanswerable without a way to see the transport truth from inside the app.
 */
export async function GET() {
  try {
    const { membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to view email settings.', 403);
    }
    const appUrl = getAppUrl();
    return jsonOk({
      configured: isEmailConfigured(),
      transport: activeEmailTransport(),
      description: describeEmailTransport(),
      problems: emailConfigProblems(),
      appUrl,
      appUrlIsLocal: isLocalAppUrl(appUrl),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/settings/email — send a real test email to the current user. */
export async function POST(req: Request) {
  try {
    const { user, company, membership } = await requireActiveCompany();
    if (!can(membership.role, 'company:update')) {
      return jsonError('You do not have permission to send a test email.', 403);
    }
    if (!user.email) {
      return jsonError('Your account has no email address.', 400);
    }

    const result = await sendTestEmail(user.email);
    await recordAudit({
      action: 'EMAIL_TEST_SENT',
      userId: user.id,
      companyId: company.id,
      metadata: {
        to: user.email,
        transport: result.transport,
        delivered: result.delivered,
        error: result.error ?? null,
      },
      ...getRequestMeta(req),
    });

    return jsonOk({
      delivered: result.delivered,
      transport: result.transport,
      notConfigured: Boolean(result.notConfigured),
      error: result.error ?? null,
      to: user.email,
      description: describeEmailTransport(),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
