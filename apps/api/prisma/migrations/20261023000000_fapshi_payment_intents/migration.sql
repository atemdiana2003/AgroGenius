CREATE TYPE "public"."PaymentStatus" AS ENUM (
    'CREATED',
    'PENDING',
    'SUCCESSFUL',
    'FAILED',
    'EXPIRED',
    'INITIATION_UNKNOWN'
);

CREATE TYPE "public"."PaymentMode" AS ENUM ('SANDBOX', 'LIVE', 'SIMULATED');

CREATE TABLE "public"."PaymentIntent" (
    "id" UUID NOT NULL,
    "publicReference" VARCHAR(36) NOT NULL,
    "payerId" UUID NOT NULL,
    "offerId" UUID NOT NULL,
    "amountXaf" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'XAF',
    "provider" VARCHAR(24) NOT NULL DEFAULT 'FAPSHI',
    "providerMode" "public"."PaymentMode" NOT NULL,
    "providerTransactionId" VARCHAR(120),
    "checkoutUrl" VARCHAR(2048),
    "idempotencyKey" VARCHAR(100) NOT NULL,
    "requestFingerprint" VARCHAR(64) NOT NULL,
    "status" "public"."PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "safeFailureCode" VARCHAR(80),
    "lastProviderCheckAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "completedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentIntent_amountXaf_check" CHECK ("amountXaf" >= 100),
    CONSTRAINT "PaymentIntent_currency_check" CHECK ("currency" = 'XAF'),
    CONSTRAINT "PaymentIntent_provider_check" CHECK ("provider" IN ('FAPSHI', 'MOCK')),
    CONSTRAINT "PaymentIntent_requestFingerprint_check" CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "public"."PaymentProviderEvent" (
    "id" UUID NOT NULL,
    "paymentId" UUID,
    "provider" VARCHAR(24) NOT NULL DEFAULT 'FAPSHI',
    "providerTransId" VARCHAR(120) NOT NULL,
    "payloadStatus" "public"."PaymentStatus" NOT NULL,
    "verifiedStatus" "public"."PaymentStatus",
    "deduplicationKey" VARCHAR(260) NOT NULL,
    "outcome" VARCHAR(40) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PaymentProviderEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentProviderEvent_provider_check" CHECK ("provider" = 'FAPSHI')
);

CREATE UNIQUE INDEX "PaymentIntent_publicReference_key" ON "public"."PaymentIntent"("publicReference");
CREATE UNIQUE INDEX "PaymentIntent_providerTransactionId_key" ON "public"."PaymentIntent"("providerTransactionId");
CREATE UNIQUE INDEX "PaymentIntent_payerId_idempotencyKey_key" ON "public"."PaymentIntent"("payerId", "idempotencyKey");
CREATE UNIQUE INDEX "PaymentIntent_one_open_or_paid_per_offer_key"
    ON "public"."PaymentIntent"("offerId")
    WHERE "status" IN ('CREATED', 'PENDING', 'SUCCESSFUL', 'INITIATION_UNKNOWN');
CREATE INDEX "PaymentIntent_payerId_createdAt_idx" ON "public"."PaymentIntent"("payerId", "createdAt");
CREATE INDEX "PaymentIntent_offerId_status_idx" ON "public"."PaymentIntent"("offerId", "status");
CREATE UNIQUE INDEX "PaymentProviderEvent_deduplicationKey_key" ON "public"."PaymentProviderEvent"("deduplicationKey");
CREATE INDEX "PaymentProviderEvent_providerTransId_receivedAt_idx" ON "public"."PaymentProviderEvent"("providerTransId", "receivedAt");

ALTER TABLE "public"."PaymentIntent"
    ADD CONSTRAINT "PaymentIntent_payerId_fkey"
    FOREIGN KEY ("payerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."PaymentIntent"
    ADD CONSTRAINT "PaymentIntent_offerId_fkey"
    FOREIGN KEY ("offerId") REFERENCES "public"."BuyerOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."PaymentProviderEvent"
    ADD CONSTRAINT "PaymentProviderEvent_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "public"."PaymentIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
