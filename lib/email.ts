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

export async function sendEmail(message: EmailMessage): Promise<void> {
  // When a provider key exists, branch to the real transport here.
  // if (process.env.RESEND_API_KEY) return resendTransport(message);
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
