# Architecture

```text
Future React/PWA (out of scope) -> REST /api -> Express routes -> Prisma -> PostgreSQL
                                             |             |
                                             |             +-- immutable price history, movement/audit/idempotency records
                                             +-- Argon2id/JWT/cookie auth, Zod contracts, authorization
                                             +-- SMS interface (currently simulated/disabled)
                                             +-- optional PaymentProvider -> Fapshi collection API (sandbox/live)
ESP32 -> authenticated /api/device/readings --+
```

The API is a modular monolith in one deployable Node service. Express routes currently combine HTTP validation and service/data-access logic within feature route modules; this is deliberately small for the pilot and is not a separate controller/repository layer. Shared Zod DTO contracts are in `packages/contracts`; Prisma is the sole ORM. UTC ISO-8601 timestamps are input/output. PostgreSQL uses timezone-aware timestamps and decimals; UI formatting converts to the user's chosen local time. Monetary amounts include an ISO-like 3-character currency and an explicit unit; XAF is supported without being imposed on all entries.

Fapshi collection is isolated behind `PaymentProvider`. It is disabled by default, and production configuration requires the Fapshi live host and explicit credentials. A buyer can optionally pay the integer XAF total for an accepted offer after the seller has confirmed the sale. Payment records and provider receipts are durable; the webhook shared secret is verified and the provider status endpoint is queried before a terminal state is applied. The payment flow does not mutate inventory, confirm sales, transfer money, or implement refunds. See [payments-fapshi](./payments-fapshi.md).

The deployment has one API process and an in-process 15-minute expiry job, guarded by conditional state updates and unique notification keys. For horizontally scaled deployments, move that work to a dedicated scheduler/outbox worker. `GET /health` does not query dependencies; `/ready` checks PostgreSQL.

Untrusted input is Zod-validated; role and record-owner checks are server-side. Database transactions/versions guard inventory and updates. SQL constraints and unique keys are in the committed migration. Public listing DTOs omit phone/email. Reset secrets, refresh tokens, passwords, and device tokens are never logged.
