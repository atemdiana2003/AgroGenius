import argon2 from 'argon2';
import { createPrismaClient } from '../src/common/prisma-client';

const prisma = createPrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const displayName = process.env.ADMIN_DISPLAY_NAME?.trim();
  const community = process.env.ADMIN_COMMUNITY?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (process.env.CONFIRM_ADMIN_PROVISION !== 'true') {
    throw new Error('Set CONFIRM_ADMIN_PROVISION=true to explicitly provision one administrator.');
  }
  if (!email || !displayName || !community || !password || password.length < 16) {
    throw new Error(
      'Set ADMIN_EMAIL, ADMIN_DISPLAY_NAME, ADMIN_COMMUNITY, and a unique ADMIN_PASSWORD of at least 16 characters.',
    );
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error(
      'An account already exists for ADMIN_EMAIL; this command never upgrades or resets an existing account.',
    );
  }
  const user = await prisma.user.create({
    data: {
      email,
      displayName,
      community,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      role: 'ADMIN',
      smsConsent: false,
    },
    select: { id: true, email: true, role: true },
  });
  process.stdout.write(`Provisioned administrator id=${user.id} email=${user.email}.\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `Administrator provisioning failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
