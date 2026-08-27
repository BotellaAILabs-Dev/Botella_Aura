import crypto from 'node:crypto';

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { recordAudit } from '@/server/services/audit.service';
import { isEmailConfigured, sendConnectorVerificationEmail } from '@/lib/email';
import { CONNECTORS } from '@/lib/connectors';
import { ConnectorError } from '@/server/connectors/connection.service';

/**
 * Connect a data source by proving control of its account email.
 *
 * Requested as an alternative to OAuth, and it earns its place: registering an
 * OAuth client is a per-provider, admin-only errand that can block a workspace
 * for days. This does not grant API access — it records WHICH account a
 * connector belongs to, so results can be logged against it and the connection
 * shows as attributable rather than absent, with the account verified rather
 * than merely typed.
 *
 * The code is hashed at rest, single-use, expiring, and attempt-limited.
 */
const CODE_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;
/** Codes are 6 digits — short enough to retype, long enough with the limits above. */
const CODE_DIGITS = 6;

function hash(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode(): string {
  // randomInt is uniform; padStart keeps leading zeros so every code is 6 chars.
  const max = 10 ** CODE_DIGITS;
  return String(crypto.randomInt(0, max)).padStart(CODE_DIGITS, '0');
}

function connectorName(connectorId: string): string {
  return CONNECTORS.find((c) => c.id === connectorId)?.name ?? connectorId;
}

export async function startEmailVerification(args: {
  companyId: string;
  userId: string;
  connectorId: string;
  email: string;
}): Promise<{ sent: boolean; expiresAt: Date; transportNote?: string }> {
  const { companyId, userId, connectorId, email } = args;

  if (!isEmailConfigured()) {
    throw new ConnectorError(
      'Email delivery is not configured on this deployment, so a verification code cannot be sent. ' +
        'Set RESEND_API_KEY + EMAIL_FROM (or the SMTP_* variables) first.',
      409,
    );
  }

  // Supersede any outstanding code for this connector: two live codes would
  // make "the code did not work" ambiguous.
  await db.connectorEmailVerification.deleteMany({
    where: { companyId, connectorId, consumedAt: null },
  });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

  await db.connectorEmailVerification.create({
    data: {
      companyId,
      connectorId,
      email: email.toLowerCase(),
      codeHash: hash(code),
      expiresAt,
    },
  });

  const result = await sendConnectorVerificationEmail(
    email,
    code,
    connectorName(connectorId),
    CODE_TTL_MINUTES,
  );

  if (!result.delivered) {
    logger.error('connectors: verification email failed', {
      connectorId,
      error: result.error,
    });
    throw new ConnectorError(
      `We could not send the code: ${result.error ?? 'unknown mail error'}`,
      502,
    );
  }

  await recordAudit({
    action: 'CONNECTOR_CREDENTIALS_SAVED',
    userId,
    companyId,
    metadata: { connectorId, method: 'email_code', stage: 'code_sent' },
  });

  return { sent: true, expiresAt };
}

export async function confirmEmailVerification(args: {
  companyId: string;
  userId: string;
  connectorId: string;
  code: string;
}): Promise<{ accountLabel: string }> {
  const { companyId, userId, connectorId, code } = args;

  const record = await db.connectorEmailVerification.findFirst({
    where: { companyId, connectorId, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) {
    throw new ConnectorError('No code is pending. Request a new one.', 400);
  }
  if (record.expiresAt.getTime() < Date.now()) {
    await db.connectorEmailVerification.delete({ where: { id: record.id } });
    throw new ConnectorError('That code has expired. Request a new one.', 400);
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    await db.connectorEmailVerification.delete({ where: { id: record.id } });
    throw new ConnectorError(
      'Too many incorrect attempts. Request a new code.',
      429,
    );
  }

  // Constant-time compare so a wrong code leaks nothing through timing.
  const expected = Buffer.from(record.codeHash);
  const supplied = Buffer.from(hash(code.trim()));
  const matches =
    expected.length === supplied.length &&
    crypto.timingSafeEqual(expected, supplied);

  if (!matches) {
    await db.connectorEmailVerification.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    const left = MAX_ATTEMPTS - (record.attempts + 1);
    throw new ConnectorError(
      left > 0
        ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'That code is not right, and you are out of attempts. Request a new code.',
      400,
    );
  }

  await db.connectorEmailVerification.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });

  await db.connection.upsert({
    where: { companyId_connectorId: { companyId, connectorId } },
    create: {
      companyId,
      connectorId,
      kind: 'EMAIL_CODE',
      status: 'CONNECTED',
      accountLabel: record.email,
      verifiedEmail: record.email,
      verifiedAt: new Date(),
      connectedById: userId,
      // Honest about what this connection can and cannot do.
      metadata: {
        method: 'email_code',
        note:
          'Verified by email code. Account ownership is confirmed; automatic metric sync needs OAuth or an API key.',
      },
    },
    update: {
      kind: 'EMAIL_CODE',
      status: 'CONNECTED',
      accountLabel: record.email,
      verifiedEmail: record.email,
      verifiedAt: new Date(),
      errorMessage: null,
    },
  });

  await recordAudit({
    action: 'CONNECTOR_CONNECTED',
    userId,
    companyId,
    metadata: { connectorId, method: 'email_code', email: record.email },
  });

  return { accountLabel: record.email };
}
