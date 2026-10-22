import argon2 from 'argon2';
import { createPrismaClient } from '../src/common/prisma-client';

const prisma = createPrismaClient();

async function main() {
  for (const unit of [
    {
      code: 'KG' as const,
      label: 'Kilogram',
      description: 'Metric mass unit; not interchangeable with crates or pieces.',
    },
    {
      code: 'CRATE' as const,
      label: 'Crate',
      description: 'Counted produce container; no mass conversion is defined.',
    },
    {
      code: 'PIECE' as const,
      label: 'Piece',
      description: 'Individual produce item; not interchangeable with mass units.',
    },
  ]) {
    await prisma.unitReference.upsert({
      where: { code: unit.code },
      update: { label: unit.label, description: unit.description },
      create: unit,
    });
  }
  const tomato = await prisma.crop.upsert({
    where: { name: 'Tomato' },
    update: {},
    create: { name: 'Tomato', validatedForTrial: false, active: true },
  });
  const market = await prisma.market.upsert({
    where: {
      name_community_region: {
        name: 'DEMO ONLY - Buea Market',
        community: 'DEMO ONLY - Buea',
        region: 'DEMO ONLY - South-West',
      },
    },
    update: {},
    create: {
      name: 'DEMO ONLY - Buea Market',
      community: 'DEMO ONLY - Buea',
      region: 'DEMO ONLY - South-West',
      isDemo: true,
    },
  });
  const storageLabel = 'DEMO ONLY - unconfigured storage reference';
  const storage = await prisma.storageUnit.findFirst({
    where: { label: storageLabel, isDemo: true },
  });
  if (!storage) {
    await prisma.storageUnit.create({
      data: { label: storageLabel, method: 'OTHER', community: 'DEMO ONLY', isDemo: true },
    });
  }

  const demoPassword = process.env.DEMO_SEED_PASSWORD;
  if (demoPassword) {
    if (demoPassword.length < 12) {
      throw new Error('DEMO_SEED_PASSWORD must be at least 12 characters when provided.');
    }
    const passwordHash = await argon2.hash(demoPassword, { type: argon2.argon2id });
    for (const demo of [
      {
        email: 'demo.farmer@example.invalid',
        displayName: 'DEMO ONLY - Farmer',
        role: 'FARMER' as const,
      },
      {
        email: 'demo.buyer@example.invalid',
        displayName: 'DEMO ONLY - Buyer',
        role: 'BUYER' as const,
      },
    ]) {
      await prisma.user.upsert({
        where: { email: demo.email },
        update: { displayName: demo.displayName, passwordHash, role: demo.role, active: true },
        create: {
          email: demo.email,
          displayName: demo.displayName,
          passwordHash,
          role: demo.role,
          community: 'DEMO ONLY',
          smsConsent: false,
        },
      });
    }
  }
  process.stdout.write(
    `Seeded reference crop ${tomato.name} and demo-only market ${market.name}.\n`,
  );
  if (!demoPassword)
    process.stdout.write(
      'No demo accounts created; set DEMO_SEED_PASSWORD explicitly to enable them.\n',
    );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `Seed failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
