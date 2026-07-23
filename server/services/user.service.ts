import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/password';
import { recordAudit } from '@/server/services/audit.service';

/** Thrown when signup is attempted with an already-registered email. */
export class EmailAlreadyInUseError extends Error {
  readonly status = 409;
  constructor() {
    super('An account with this email already exists.');
    this.name = 'EmailAlreadyInUseError';
  }
}

export async function getUserByEmail(email: string) {
  return db.user.findUnique({ where: { email: email.toLowerCase() } });
}

export async function getUserById(id: string) {
  return db.user.findUnique({ where: { id } });
}

interface CreateUserWithPasswordInput {
  name: string;
  email: string;
  password: string;
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null };
}

/**
 * Create a local (email/password) user and write a USER_SIGNED_UP audit entry
 * atomically. New users default to SystemRole.OWNER — they will own the company
 * they create during onboarding.
 */
export async function createUserWithPassword(
  input: CreateUserWithPasswordInput,
) {
  const email = input.email.toLowerCase();

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) throw new EmailAlreadyInUseError();

  const passwordHash = await hashPassword(input.password);

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const user = await tx.user.create({
      data: {
        name: input.name,
        email,
        passwordHash,
        role: 'OWNER',
      },
      select: { id: true, name: true, email: true, role: true },
    });

    await recordAudit(
      {
        action: 'USER_SIGNED_UP',
        userId: user.id,
        metadata: { method: 'credentials' },
        ipAddress: input.requestMeta?.ipAddress,
        userAgent: input.requestMeta?.userAgent,
      },
      tx,
    );

    return user;
  });
}
