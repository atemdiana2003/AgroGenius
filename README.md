# AgroGenius HarvestGuard

Offline-aware backend and shared API contracts for the tomato post-harvest and market-linkage pilot in Buea, Cameroon. This repository contains the backend, PostgreSQL schema, starter ESP32 firmware, and a future-frontend handoff; it does not implement the React application.

This software records observations and supports a small cooler-test/shaded-control pilot. It is not a food-safety certification, verified price feed, diagnosis tool, guaranteed-market service, or proof of reduced losses or increased profit. Demo values must be labelled and must not be represented as field evidence.

## Current implementation

- Express + TypeScript API with strict input schemas, request IDs, structured redacted logs, CORS allow-list, Helmet, rate limits, centralized JSON errors, and readiness/health endpoints.
- Prisma 7/PostgreSQL schema and forward-only committed SQL migrations, with the PostgreSQL driver adapter and generated type-safe client; covers users/sessions/farms, supported unit references, batches/movement history, storage units/sensors/readings, trials/groups/quality observations, market prices/alerts, listings/offers/sales, notifications, idempotency/sync, reports, and audits.
- Public farmer/buyer registration, Argon2id passwords, short-lived access JWTs, rotating hashed refresh tokens, logout, profile/preferences. Refresh tokens stay in HttpOnly cookies for browsers; other clients must explicitly opt in to JSON transport. Production password reset remains disabled until a delivery provider is configured.
- Paginated batch and reading/price/listing/offer/report endpoints; experimental threshold alerts; listing expiry worker; explicit sale confirmation; protected phone contact workflow.
- Shared request schemas under `packages/contracts`, OpenAPI and project/field/security/frontend/deployment docs, and firmware starter under `device/esp32`.
- In-app notification history and explicitly labelled SMS simulation/disabled behavior. No real SMS provider is configured; disabled SMS is not queued or counted as an attempted delivery.
- Optional, disabled-by-default Fapshi collections for seller-confirmed accepted offers, with integer-XAF validation, payment idempotency, webhook-secret verification, server-side status reconciliation, and a clearly labelled pending-only mock. No fee, escrow, payout, or refund behavior is implied.

See [requirements traceability](docs/requirements-traceability.md) for the feature-by-feature coverage and limitations.

## Requirements

- Node.js 22 LTS (Node 20.19+ is accepted) and npm.
- PostgreSQL 16+. Docker Compose is supplied but Docker must be installed separately.
- A secure random `JWT_ACCESS_SECRET` and separate `DEVICE_TOKEN_PEPPER` (32+ characters each).
- Optional PlatformIO/ESP32 hardware for the device starter.

## Quick start (PowerShell)

```powershell
Copy-Item .env.example .env
# Replace both secrets with independent random values before using outside local development.
docker compose up -d postgres
npm ci
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

API listens on `http://localhost:3000`. `GET /health` is process health; `GET /ready` also checks PostgreSQL. Configure `ALLOWED_ORIGINS` as a comma-separated exact-origin list. `.env.example` values are local examples, not deployment secrets. Docker is not needed if a PostgreSQL 16 server is already running at `DATABASE_URL`.

Create a local-only demo farmer and buyer by setting `DEMO_SEED_PASSWORD` to a unique password of at least 12 characters before `npm run db:seed`. The seed process creates demo accounts only when you explicitly provide that variable. `DEMO_SEED_PASSWORD` is not required in production; do not use these accounts in a live deployment. There is deliberately no seeded administrator credential. Provision an administrator through the guarded one-time operator command after applying migrations: set `CONFIRM_ADMIN_PROVISION=true`, `ADMIN_EMAIL`, `ADMIN_DISPLAY_NAME`, `ADMIN_COMMUNITY`, and an independently generated `ADMIN_PASSWORD` (16+ characters) in the operator's protected environment, then run `npm run admin:provision`. It refuses to upgrade an existing account. Never put these values in a script or source control.

## Scripts

| Command                                         | Purpose                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `npm run dev`                                   | API development server                                               |
| `npm run db:generate`                           | Generate Prisma client                                               |
| `npm run db:migrate`                            | Create/apply development migration                                   |
| `npm run db:deploy`                             | Apply committed migrations                                           |
| `npm run db:seed`                               | Seed tomato and unmistakable demo market/reference data              |
| `npm run admin:provision`                       | Explicitly create one admin account; never upgrades an existing user |
| `npm run test`                                  | Vitest/Supertest tests                                               |
| `npm run lint`                                  | ESLint                                                               |
| `npm run format:check`                          | Prettier check                                                       |
| `npm run audit:runtime`                         | Audit dependencies included in the production runtime image          |
| `npm run typecheck`                             | Build contracts and type-check API                                   |
| `npm run build`                                 | Build shared contracts and API                                       |
| `npm run smoke`                                 | Check `/health` and `/ready` against a running API                   |
| `npm run simulate:reading -- <batchId> <token>` | Submit one explicitly simulated reading (see below)                  |

Tests that access PostgreSQL need a separate disposable test database and migrations. The local contract/security/HTTP tests do not require a running database; database workflow tests must be run against an isolated configured server, never production.

## Main API paths

- `POST /api/auth/register`, `/login`, `/refresh`, `/logout`, `/password-reset/request`, `/password-reset/confirm`; `GET|PATCH /api/me` (legacy alias: `/api/auth/me`)
- `GET|POST /api/farms`, `GET|PATCH|DELETE /api/farms/:id` (farmer-owned; DELETE archives)
- `GET /api/units`; admin unit metadata/active-state management under `/api/admin/units`
- `GET|POST /api/batches`, `GET|PATCH /api/batches/:id`, `POST /api/batches/:id/movements`, `/archive`
- `POST /api/readings`, `GET /api/batches/:id/readings`, `POST /api/device/readings`, `POST /api/quality-observations`
- `GET /api/trials/:id/comparison`
- `GET|POST /api/prices`; CRUD ` /api/price-alert-rules`
- `GET|POST /api/listings`, `GET|PATCH /api/listings/:id`, listing offers/contact requests
- `GET|PATCH /api/offers/:id`, `POST /api/offers/:id/confirm-sale`
- Optional payments when enabled: `POST /api/payments/offers/:id`, `GET /api/payments/:id`, and the Fapshi callback `/api/payments/fapshi/webhook`
- `GET|PATCH /api/notifications`; `GET /api/markets`, `/api/crops`
- Admin reference/trial/device/moderation/metrics/audit and paginated batch/price/reading/quality/trial CSV exports under `/api/admin`
- `GET /api/sync/operations`; `POST /api/reports`

See [OpenAPI](docs/openapi.yaml), [API contract](docs/api-contract.md), and [frontend integration](docs/frontend-integration.md) for exact paths, examples, roles, and known limitations.

## Manual and simulated monitoring

Authenticated farmers can post a `MANUAL` or `SIMULATED` reading to `/api/readings`. A simulated reading is explicitly tagged in metadata and is not hardware evidence. `SENSOR` readings are accepted only on `/api/device/readings` with a provisioned `Device` credential. Temperature input limits and experimental alert thresholds are configurable in `.env`; the latter are project test thresholds, not universal food-safety limits.

```powershell
npm run simulate:reading -- 00000000-0000-0000-0000-000000000000 YOUR_ACCESS_TOKEN
```

Replace the batch identifier and token with real development values. The helper generates random, labelled simulation data. Read [ESP32 setup](device/esp32/README.md) before provisioning real sensor/device credentials.

## Deployment, security, and evidence

Read [security/privacy](docs/security-privacy.md), [offline sync](docs/offline-sync.md), [deployment and backups](docs/deployment-backup.md), [field protocol](docs/field-test-protocol.md), and [decisions/limitations](docs/decisions-and-assumptions.md). Do not expose secrets, contact details, raw tokens, or development reset links in production. Field, hardware, browser-PWA, SMS-provider, backup-restore and production-HTTPS behavior must be verified in those real environments before being described as tested.
