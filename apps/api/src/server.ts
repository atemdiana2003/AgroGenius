import { createApp } from './app';
import { parseEnv } from './config/env';
import { prisma } from './common/prisma';
import { processListingExpiry } from './jobs/listing-expiry';

async function main() {
  const env = parseEnv();
  await prisma.$connect();
  const app = createApp(prisma, env);
  const expiryTimer = setInterval(
    () => {
      void processListingExpiry(prisma).catch((error: unknown) => {
        process.stderr.write(
          `Listing-expiry job failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
        );
      });
    },
    15 * 60 * 1000,
  );
  expiryTimer.unref();
  await processListingExpiry(prisma);
  const server = app.listen(env.PORT, () => {
    process.stdout.write(`HarvestGuard API listening on port ${env.PORT}\n`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(expiryTimer);
    process.stdout.write(`Received ${signal}; shutting down.\n`);
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
