import { logger } from '@/lib/logger';

/**
 * Email transport abstraction.
 *
 * Sprint 1 ships a console transport (logs the message + any action link) so
 * flows like password reset are fully testable without a provider. To go live
 * in a later sprint, implement `sendEmail` against Resend/SendGrid and set
 * RESEND_API_KEY + EMAIL_FROM — NO call sites change.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Add `html` when a provider is wired up. */
  text: string;
}

async function consoleTransport(message: EmailMessage): Promise<void> {
  logger.info('[email:dev] Email dispatched (console transport)', {
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
}

/**
 * Resend transport — used automatically when RESEND_API_KEY is set. Calls the
 * Resend REST API directly (no SDK dependency). Set EMAIL_FROM to a verified
 * sender, e.g. "Botella Aura <no-reply@yourdomain.com>". Falls back to the
 * console transport on any failure so a mail outage never breaks the flow.
 */
async function resendTransport(message: EmailMessage): Promise<void> {
  const from = process.env.EMAIL_FROM || 'Botella Aura <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error('Resend send failed; falling back to console', {
        status: res.status,
        detail: detail.slice(0, 300),
      });
      return consoleTransport(message);
    }
    logger.info('Email sent via Resend', { to: message.to, subject: message.subject });
  } catch (err) {
    logger.error('Resend transport error; falling back to console', {
      error: err instanceof Error ? err.message : String(err),
    });
    return consoleTransport(message);
  }
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (process.env.RESEND_API_KEY) return resendTransport(message);
  return consoleTransport(message);
}

/** Convenience helper for the Sprint 1 password-reset flow. */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
): Promise<void> {
  await sendEmail({
    to,
    subject: 'Reset your Botella Aura password',
    text: [
      'We received a request to reset your Botella Aura password.',
      '',
      `Reset it here (valid for 1 hour): ${resetUrl}`,
      '',
      'If you did not request this, you can safely ignore this email.',
    ].join('\n'),
  });
}

/** Team invitation email (Sprint: team collaboration). */
export async function sendInvitationEmail(
  to: string,
  acceptUrl: string,
  companyName: string,
): Promise<void> {
  await sendEmail({
    to,
    subject: `You've been invited to ${companyName} on Botella Aura`,
    text: [
      `You've been invited to join ${companyName} on Botella Aura.`,
      '',
      `Accept your invitation here (valid for 7 days): ${acceptUrl}`,
      '',
      'If you did not expect this, you can ignore this email.',
    ].join('\n'),
  });
}
