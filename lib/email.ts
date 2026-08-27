import { logger } from '@/lib/logger';

/**
 * Email transport abstraction.
 *
 * IMPORTANT (client review, Phase 1): `sendEmail` used to swallow every
 * failure and silently fall back to a console log, so the UI happily reported
 * "Mail sent" while nothing ever left the building. It now returns a truthful
 * `EmailResult` — callers persist and display the real outcome, and provide a
 * copyable link whenever delivery did not actually happen.
 *
 * Transport selection (first configured wins):
 *   SMTP_HOST → SMTP · RESEND_API_KEY → Resend · else → console (dev only).
 */
export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body — always required (the accessible fallback). */
  text: string;
  /** Optional HTML body. Providers that support it get both parts. */
  html?: string;
  replyTo?: string;
}

export type EmailTransportId = 'smtp' | 'resend' | 'console';

export interface EmailResult {
  /** True ONLY when a real provider accepted the message. */
  delivered: boolean;
  transport: EmailTransportId;
  /** Provider-side id when available (useful for support tickets). */
  providerId?: string;
  /** Human-readable failure reason when `delivered` is false. */
  error?: string;
  /**
   * True when no provider is configured at all — a setup problem, not a
   * transient failure. The UI phrases these very differently.
   */
  notConfigured?: boolean;
}

/** Which transport would handle the next send, without sending anything. */
export function activeEmailTransport(): EmailTransportId {
  if (process.env.SMTP_HOST) return 'smtp';
  if (process.env.RESEND_API_KEY) return 'resend';
  return 'console';
}

/** Is a real (non-console) email provider configured? */
export function isEmailConfigured(): boolean {
  return activeEmailTransport() !== 'console';
}

/** One-line, non-secret description of the mail setup, for admin UIs. */
export function describeEmailTransport(): string {
  switch (activeEmailTransport()) {
    case 'smtp':
      return `SMTP · ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`;
    case 'resend':
      return `Resend · from ${process.env.EMAIL_FROM || 'onboarding@resend.dev'}`;
    default:
      return 'Not configured — emails are only written to the server log';
  }
}

/**
 * What's missing for real delivery. Empty array = ready to send.
 * Used by the settings diagnostics panel so setup is self-service.
 */
export function emailConfigProblems(): string[] {
  const problems: string[] = [];
  const transport = activeEmailTransport();

  if (transport === 'console') {
    problems.push(
      'No email provider configured. Set RESEND_API_KEY + EMAIL_FROM, or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS.',
    );
    return problems;
  }
  if (transport === 'smtp') {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      problems.push(
        'SMTP_HOST is set but SMTP_USER/SMTP_PASS are missing — most providers reject unauthenticated sends.',
      );
    }
    if (!process.env.EMAIL_FROM && !process.env.SMTP_USER) {
      problems.push('Set EMAIL_FROM to the address messages should come from.');
    }
  }
  if (transport === 'resend' && !process.env.EMAIL_FROM) {
    problems.push(
      'EMAIL_FROM is not set — Resend will use its shared onboarding@resend.dev sender, which is rate-limited and often filtered.',
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

function consoleTransport(message: EmailMessage): EmailResult {
  logger.warn(
    '[email] No provider configured — message logged instead of sent',
    { to: message.to, subject: message.subject, text: message.text },
  );
  return {
    delivered: false,
    transport: 'console',
    notConfigured: true,
    error:
      'No email provider is configured, so this message was only written to the server log.',
  };
}

async function resendTransport(message: EmailMessage): Promise<EmailResult> {
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
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };
    if (!res.ok) {
      const error =
        body.message ||
        body.name ||
        `Resend rejected the message (HTTP ${res.status}).`;
      logger.error('email: Resend send failed', { status: res.status, error });
      return { delivered: false, transport: 'resend', error };
    }
    logger.info('email: sent via Resend', { to: message.to, id: body.id });
    return { delivered: true, transport: 'resend', providerId: body.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('email: Resend transport error', { error });
    return { delivered: false, transport: 'resend', error };
  }
}

/**
 * SMTP transport (nodemailer). Works with any provider that gives SMTP
 * credentials (Gmail app password, SendGrid, Mailgun, Zoho, SES, Office 365).
 * nodemailer is imported lazily so it is never bundled where it isn't used.
 */
async function smtpTransport(message: EmailMessage): Promise<EmailResult> {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || '';
  try {
    const nodemailer = (await import('nodemailer')).default;
    const port = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    });
    const info = await transporter.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    });

    // nodemailer reports per-recipient acceptance — a 250 for zero recipients
    // is not a delivery, and we must not claim it was one.
    const accepted = (info.accepted ?? []) as unknown[];
    if (accepted.length === 0) {
      const error =
        `The SMTP server accepted the connection but rejected the recipient` +
        `${info.response ? ` (${info.response})` : ''}.`;
      logger.error('email: SMTP rejected recipient', { to: message.to, error });
      return { delivered: false, transport: 'smtp', error };
    }
    logger.info('email: sent via SMTP', { to: message.to, id: info.messageId });
    return { delivered: true, transport: 'smtp', providerId: info.messageId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('email: SMTP transport error', { error });
    return { delivered: false, transport: 'smtp', error };
  }
}

/**
 * Send one message and report what actually happened. Never throws — callers
 * get a result they can persist and show.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  switch (activeEmailTransport()) {
    case 'smtp':
      return smtpTransport(message);
    case 'resend':
      return resendTransport(message);
    default:
      return consoleTransport(message);
  }
}

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

/** Minimal, client-safe HTML wrapper (inline styles only — no external CSS). */
function wrap(heading: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.55;color:#111827;max-width:520px;margin:0 auto;padding:24px">',
    `<h1 style="font-size:18px;margin:0 0 12px">${heading}</h1>`,
    bodyHtml,
    cta
      ? `<p style="margin:24px 0"><a href="${cta.url}" style="background:#111827;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600">${cta.label}</a></p>` +
        `<p style="font-size:12px;color:#6b7280;word-break:break-all">Or paste this link into your browser:<br>${cta.url}</p>`
      : '',
    '<p style="font-size:12px;color:#6b7280;margin-top:24px">Botella Aura — your AI marketing co-pilot.</p>',
    '</div>',
  ].join('');
}

/** Password-reset email. */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
): Promise<EmailResult> {
  return sendEmail({
    to,
    subject: 'Reset your Botella Aura password',
    text: [
      'We received a request to reset your Botella Aura password.',
      '',
      `Reset it here (valid for 1 hour): ${resetUrl}`,
      '',
      'If you did not request this, you can safely ignore this email.',
    ].join('\n'),
    html: wrap(
      'Reset your password',
      '<p style="margin:0">We received a request to reset your Botella Aura password. This link is valid for 1 hour.</p>',
      { label: 'Reset password', url: resetUrl },
    ),
  });
}

/** Team invitation email. */
export async function sendInvitationEmail(
  to: string,
  acceptUrl: string,
  companyName: string,
  inviterName?: string | null,
): Promise<EmailResult> {
  const by = inviterName ? ` by ${inviterName}` : '';
  return sendEmail({
    to,
    subject: `You've been invited to ${companyName} on Botella Aura`,
    text: [
      `You've been invited${by} to join ${companyName} on Botella Aura.`,
      '',
      `Accept your invitation here (valid for 7 days): ${acceptUrl}`,
      '',
      'If you did not expect this, you can ignore this email.',
    ].join('\n'),
    html: wrap(
      `Join ${companyName} on Botella Aura`,
      `<p style="margin:0">You've been invited${by} to collaborate on ${companyName}'s marketing. This invitation is valid for 7 days.</p>`,
      { label: 'Accept invitation', url: acceptUrl },
    ),
  });
}

/** Self-test message used by the email diagnostics panel in Settings. */
export async function sendTestEmail(to: string): Promise<EmailResult> {
  const when = new Date().toISOString();
  return sendEmail({
    to,
    subject: 'Botella Aura — email delivery test',
    text: [
      'This is a test message from Botella Aura.',
      '',
      `If you are reading it, outbound email works. Transport: ${describeEmailTransport()}.`,
      `Sent at ${when}.`,
    ].join('\n'),
    html: wrap(
      'Email delivery works',
      `<p style="margin:0">This is a test message from Botella Aura. If you are reading it, outbound email is working.</p>` +
        `<p style="font-size:12px;color:#6b7280">Transport: ${describeEmailTransport()}<br>Sent at ${when}</p>`,
    ),
  });
}

/**
 * One-time code for connecting a data source by email.
 *
 * Deliberately plain: no link and no button. A code the recipient types back
 * into a page they already have open cannot be turned into a click-through
 * phishing lure the way an action link can.
 */
export async function sendConnectorVerificationEmail(
  to: string,
  code: string,
  connectorName: string,
  minutesValid: number,
): Promise<EmailResult> {
  return sendEmail({
    to,
    subject: `${code} is your Botella Aura verification code`,
    text: [
      `Your verification code for connecting ${connectorName} is: ${code}`,
      '',
      `It expires in ${minutesValid} minutes and can be used once.`,
      '',
      'If you did not request this, ignore this email — nothing was connected.',
    ].join('\n'),
    html: wrap(
      `Verify ${connectorName}`,
      `<p style="margin:0 0 16px">Enter this code to finish connecting <strong>${connectorName}</strong>:</p>` +
        `<p style="margin:0;font-size:30px;letter-spacing:7px;font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</p>` +
        `<p style="margin:16px 0 0;font-size:13px;color:#6b7280">Expires in ${minutesValid} minutes. Single use. If you did not request it, ignore this email — nothing was connected.</p>`,
    ),
  });
}
