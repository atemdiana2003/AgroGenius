# Deployment, backup, and release

## Local

Use Node 22, `npm ci`, `.env` based on `.env.example`, and PostgreSQL 16 via `docker compose up -d postgres` (or an equivalent local server). Run `npm run db:generate`, `npm run db:deploy`, `npm run db:seed`, `npm run dev`. Use an isolated database for tests. Do not run destructive restore tests against production.

Provision a restricted administrator only after migration, with secrets supplied by a protected operator environment: set `CONFIRM_ADMIN_PROVISION=true`, `ADMIN_EMAIL`, `ADMIN_DISPLAY_NAME`, `ADMIN_COMMUNITY`, and a unique `ADMIN_PASSWORD` of at least 16 characters, then run `npm run admin:provision`. The command creates one admin only and refuses to change an existing account. Unset those environment values immediately afterward. There is no default administrator account.

## Staging/production

Build `apps/api/Dockerfile` multi-stage image; runtime is non-root. The build generates the Prisma 7 client with the PostgreSQL driver adapter, compiles it, then removes generated source and prunes development/optional packages. Run `npm audit` and `npm run audit:runtime`; both currently report no vulnerabilities. Prisma 7 CLI configuration is maintained in `apps/api/prisma.config.ts`; migration commands require `DATABASE_URL`. Supply secrets using deployment secret manager. Set `NODE_ENV=production`, `COOKIE_SECURE=true`, strong independent signing and device peppers, `DATABASE_URL` using TLS for managed PostgreSQL, exact `ALLOWED_ORIGINS`, correct public port/proxy config, and approved logging level. Terminate HTTPS at a trusted proxy; preserve forwarded IP configuration only when explicitly trusted. Apply `npm run db:deploy` as a release step before serving the new version. Use separate databases/secrets for test, staging, and production. Seed reference data only through an approved operator process; never seed demo users into production.

`TRUST_PROXY_HOPS` defaults to `0`; set it only to the exact trusted proxy hop count after blocking direct access to the API origin. Cookie-authenticated unsafe methods require an exact allowed `Origin` in addition to `SameSite`; proxy and browser topology must be verified in staging. The GitHub Actions workflow `.github/workflows/ci.yml` uses an ephemeral PostgreSQL service and builds (without publishing) the Docker image; it does not deploy, run Fapshi transactions, or require production secrets.

Optional payment collection is disabled by default. Review `docs/payments-fapshi.md` and the explicit decision in `docs/decisions-and-assumptions.md` before enabling. Use sandbox secrets first, an approved public HTTPS callback, and the dashboard-configured webhook secret. Live mode requires approved live Fapshi credentials and an activated collection service. Payment reconciliation, refunds, hosting, TLS termination, monitoring, alerting and incident response still need deployment owners.

Configure a real SMS adapter only after confirming Cameroon provider coverage, sender ID rules, pricing, consent, opt-out, retry behavior and data-processing terms. No real provider exists in this project.

## Backup / restore

Set `DATABASE_URL` to the intended database and `BACKUP_DIR` to a protected local path before running `scripts/backup-db.sh`. The script creates a custom-format `pg_dump` with permissions `umask 077`. Store encrypted backups off-host with a retention schedule chosen by the operator. Never add the dump to Git or attach it to tickets.

For restore, set `DATABASE_URL` to a newly created empty test database whose name ends exactly with `_restore_test`, then run `scripts/restore-db.sh <backup-file>`. The script validates custom archive format and refuses a target containing user relations, functions, types, extensions or nonstandard schemas; do not bypass this guard in automated workflows. Confirm schema and representative row counts with `psql`; run `/ready`, then smoke test. A disposable PostgreSQL 17 backup/restore drill was run locally, verified seeded reference rows, passed `/health` and `/ready`, and confirmed non-empty targets and suffix-only lookalikes are rejected. The backup and cluster were removed after the check.

## Smoke and release checklist

`npm run smoke` expects a running API and checks `/health` and `/ready`.

- [ ] Test suite, `npm run lint`, `npm run format:check`, `npm run typecheck`, and `npm run build` pass.
- [ ] `npm run audit:runtime` reports no production runtime vulnerabilities; track full development-toolchain advisories separately.
- [ ] Review and apply migrations to staging; snapshot first; rollback/forward plan documented.
- [ ] Farmer/buyer registration, login, batch, manual reading, sourced price, alert, listing, separate buyer offer, explicit sale and inventory transaction verified.
- [ ] Cross-user/admin/contact privacy and idempotent retry/conflict cases verified against test DB.
- [ ] HTTPS, Secure cookie, CORS, proxy rate-limit identity, database TLS, secret injection/rotation verified.
- [ ] Backup and restore drill completed; retention/access set.
- [ ] Production SMS remains disabled until provider/consent/legal checklist passes.
- [ ] Inspect image, source, logs, exports for credentials/PII. Confirm no demo market/user data is presented as evidence.
- [ ] Run load, monitoring, alerting and incident-response checks appropriate to hosting.

`pg_dump`, `pg_restore`, `psql`, Docker, TLS, managed hosting and real credentials are external tools/environments and must be installed/configured separately.
