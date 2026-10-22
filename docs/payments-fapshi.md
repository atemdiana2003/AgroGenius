# Optional Fapshi collection

## Purpose and boundaries

The source architecture and Member 2 brief do not prescribe a platform fee, escrow, payout, or mandatory purchase flow. This prototype therefore supports only an **optional buyer collection for an accepted offer that the seller has already confirmed as a sale**. The amount is the offer's explicit `offeredPrice`, interpreted as the total offer price, and must be an integer XAF amount of at least 100. Fractional XAF, other currencies, unpriced offers, and all other charge purposes are rejected. This total-price interpretation is a project assumption that must be confirmed by the business owner before production.

Payment initiation does not reserve stock, confirm a sale, decrement inventory, pay out to a farmer, or create escrow. Seller sale confirmation remains a separate action and is not reversed if a payment later fails. One pending, successful, or uncertain collection is allowed per confirmed offer; a completed payment cannot be reused for another offer. Automated refunds and disbursements are not implemented.

## Request flow

1. An authenticated `BUYER` requests `POST /api/payments/offers/{offerId}` with a UUID `Idempotency-Key` and no request fields. The server verifies the buyer owns the accepted, seller-confirmed offer and derives the integer XAF amount from the database.
2. A payment intent, opaque public reference, idempotency fingerprint and audit record are persisted before the provider call.
3. The API sends a single `POST /initiate-pay` request server-to-server using the Fapshi sandbox or live host. It sends `amount`, internal `userId`, the opaque `externalId`, and a generic message. It does not send a caller-selected amount, phone, email, callback secret, or return URL.
4. The buyer receives a hosted checkout URL and the internal payment status. The provider transaction ID, API user/key, authorization headers and raw provider body are not returned.
5. Fapshi webhooks are authenticated using the dashboard-configured `x-wh-secret`. Since the documented webhook mechanism is a shared header secret rather than a signed payload, the API performs `GET /payment-status/{transId}` and verifies transaction ID, amount, `externalId`, `userId`, and status before accepting a transition.
6. The authenticated payer may also query `GET /api/payments/{paymentId}`. Polling is throttled per local payment to stay below Fapshi's documented six requests/minute per transaction limit. Repeated webhooks/status races are protected by database uniqueness and conditional state transitions.

The provider status endpoint is authoritative when a webhook payload disagrees; the mismatch is recorded and the authoritative result is applied only if the amount and internal linkage also match. Browser redirects are never considered proof of payment. Only `CREATED`/`PENDING` can advance to `SUCCESSFUL`, `FAILED` or `EXPIRED`; terminal states cannot be changed by later deliveries.

## Configuration

Payments are disabled by default:

```dotenv
PAYMENTS_ENABLED=false
PAYMENT_PROVIDER=mock
FAPSHI_MODE=sandbox
FAPSHI_API_USER=
FAPSHI_API_KEY=
FAPSHI_WEBHOOK_SECRET=
```

Set secrets only in an ignored local `.env` or a deployment secret manager; never paste them into chat, tests, source, or issue reports. For sandbox, create a Fapshi **collection service**, configure its public webhook URL as `https://<your-public-api-host>/api/payments/fapshi/webhook`, set a webhook secret in the Fapshi dashboard, then set `PAYMENTS_ENABLED=true`, `PAYMENT_PROVIDER=fapshi`, and `FAPSHI_MODE=sandbox` with that service's sandbox API user/key and the same webhook secret. Sandbox and live use distinct credentials and fixed API hosts:

- Sandbox: `https://sandbox.fapshi.com`
- Live: `https://live.fapshi.com`

The server does not accept an arbitrary base URL. Enabled Fapshi mode requires all three credentials/secrets at startup. Production with payments enabled requires `FAPSHI_MODE=live`; the mock provider is forbidden in production. Confirm the service/account and chosen collection method are activated for live use with Fapshi before switching modes. Never enable live mode as a test.

Fapshi's current docs state `/initiate-pay` requires integer XAF of at least 100, payment links expire after 24 hours, and `/payment-status/{transId}` is limited to six requests per minute per transaction. Webhooks are sent for `SUCCESSFUL`, `FAILED`, and `EXPIRED`; the dashboard webhook secret is returned as `x-wh-secret`. The docs say Fapshi sends one webhook per status event regardless of response, so keep the API publicly reachable and retain status polling/manual reconciliation as recovery paths.

Official sources consulted:

- [Fapshi API documentation](https://docs.fapshi.com/en)
- [API credentials and environment](https://docs.fapshi.com/en/api-reference/preliminary-knowledge/environment)
- [Initiate a payment link](https://docs.fapshi.com/en/api-reference/endpoint/initiate-pay)
- [Payment status](https://docs.fapshi.com/en/api-reference/endpoint/payment-status)
- [Webhook integration](https://docs.fapshi.com/en/api-reference/endpoint/webhook)
- [Create a collection service](https://docs.fapshi.com/en/api-reference/create-a-service)

## Idempotency, reconciliation, and operations

Use one stable UUID idempotency key per user payment action. An exact replay returns the original payment; reuse for another offer returns `409 IDEMPOTENCY_KEY_REUSED`. The database also enforces one open/uncertain/successful payment per offer. A stale `CREATED` request is not re-sent automatically.

If initiation times out or returns a malformed success response, the remote transaction may exist even though no `transId`/checkout URL was received. The API stores `INITIATION_UNKNOWN`, returns `202`, and rejects another initiation. This state needs manual matching in the Fapshi dashboard using the amount, date and `externalId`/reference; after identifying the genuine provider transaction, an operator reconciliation feature must be used before production launch. Do not change payment rows by ad-hoc SQL. Provider status errors are surfaced as safe API errors and never as successful payments.

Webhook receipts store only the transaction reference, payload/verified status, deduplication key and processing outcome; raw webhook bodies, provider secrets, phone numbers, PINs and OTPs are not stored. Local audit events record creation and verified transitions. The mock adapter creates only a pending simulation; its API response identifies `provider: MOCK`, `mode: simulated` and a null checkout URL. It cannot represent a real charge or settle funds.

Refunds are not automated. If a user reports a payment problem, staff should verify the transaction in Fapshi's service dashboard, preserve the internal reference and provider transaction ID in restricted support tooling, and follow the service's documented/manual Fapshi process. Do not promise a refund or make a payout from this API.

## Sandbox checklist and limits

1. Use sandbox-only credentials and a public HTTPS test callback URL; keep the webhook secret in a secret manager.
2. Enable payment collection only in an isolated staging environment with a disposable database.
3. Create a seller-confirmed accepted offer priced in integer XAF and initiate from its owning buyer account.
4. Confirm another buyer cannot read or initiate that payment; repeated idempotency keys do not call Fapshi twice; amount tampering is rejected.
5. Exercise Fapshi's current sandbox success/failure test numbers from its environment guide, receive a webhook, and verify a server-side status lookup before the local status changes.
6. Test duplicate, forged, mismatched, delayed and concurrent webhooks; confirm inventory and sale state are unchanged by payment processing.
7. Do not run automated tests against live credentials or make a real payment as part of CI.

This repository has no Fapshi account credentials, activated service, public callback deployment or sandbox transaction evidence. The Fapshi adapter is covered by request/response mock tests, but only actual Fapshi sandbox transactions can establish provider connectivity. No real payment, provider delivery, refund or production readiness is claimed.
