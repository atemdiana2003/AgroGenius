-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('FARMER', 'BUYER', 'ADMIN');

-- CreateEnum
CREATE TYPE "public"."Unit" AS ENUM ('KG', 'CRATE', 'PIECE');

-- CreateEnum
CREATE TYPE "public"."BatchStatus" AS ENUM ('STORED', 'LISTED', 'PARTIALLY_SOLD', 'SOLD', 'SPOILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "public"."StorageMethod" AS ENUM ('COOLER', 'SHADED_CONTROL', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."TrialGroupType" AS ENUM ('COOLER_TEST', 'SHADED_CONTROL');

-- CreateEnum
CREATE TYPE "public"."ReadingSource" AS ENUM ('MANUAL', 'SENSOR', 'SIMULATED');

-- CreateEnum
CREATE TYPE "public"."OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "public"."ListingStatus" AS ENUM ('ACTIVE', 'RESERVED', 'PARTIALLY_SOLD', 'SOLD', 'EXPIRED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "public"."AlertCondition" AS ENUM ('AT_OR_ABOVE', 'AT_OR_BELOW');

-- CreateEnum
CREATE TYPE "public"."NotificationEvent" AS ENUM ('TARGET_PRICE_REACHED', 'STORAGE_WARNING', 'BUYER_OFFER', 'LISTING_EXPIRING', 'CONTACT_REQUEST');

-- CreateEnum
CREATE TYPE "public"."NotificationChannel" AS ENUM ('IN_APP', 'SMS');

-- CreateEnum
CREATE TYPE "public"."DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'SIMULATED', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "public"."SyncStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED', 'CONFLICT');

-- CreateEnum
CREATE TYPE "public"."ReportStatus" AS ENUM ('OPEN', 'REVIEWED', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "public"."MovementReason" AS ENUM ('LISTING_RESERVE', 'SALE', 'SPOILAGE', 'ADJUSTMENT', 'RELEASE');

-- CreateEnum
CREATE TYPE "public"."ContactRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" UUID NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(32),
    "email" VARCHAR(254),
    "passwordHash" TEXT NOT NULL,
    "role" "public"."Role" NOT NULL DEFAULT 'FARMER',
    "community" VARCHAR(120) NOT NULL,
    "preferredLanguage" VARCHAR(12) NOT NULL DEFAULT 'en',
    "cooperative" VARCHAR(160),
    "smsConsent" BOOLEAN NOT NULL DEFAULT false,
    "smsOptOut" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursStart" VARCHAR(5),
    "quietHoursEnd" VARCHAR(5),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PasswordResetToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Farm" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "community" VARCHAR(120) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Farm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Crop" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "validatedForTrial" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Crop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Market" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "community" VARCHAR(120) NOT NULL,
    "region" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StorageUnit" (
    "id" UUID NOT NULL,
    "ownerId" UUID,
    "label" VARCHAR(120) NOT NULL,
    "method" "public"."StorageMethod" NOT NULL,
    "community" VARCHAR(120) NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PreservationTrial" (
    "id" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "endedAt" TIMESTAMPTZ(6),
    "protocolNotes" TEXT,
    "limitationNotes" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreservationTrial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Sensor" (
    "id" UUID NOT NULL,
    "storageUnitId" UUID NOT NULL,
    "identity" VARCHAR(160) NOT NULL,
    "sensorType" VARCHAR(100) NOT NULL,
    "unit" VARCHAR(80) NOT NULL DEFAULT 'Celsius and percent RH',
    "calibrationNotes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sensor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DeviceCredential" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sensorId" UUID,
    "tokenHash" TEXT NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TrialGroup" (
    "id" UUID NOT NULL,
    "trialId" UUID NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "type" "public"."TrialGroupType" NOT NULL,
    "initialMass" DECIMAL(12,3) NOT NULL,
    "unit" "public"."Unit" NOT NULL DEFAULT 'KG',
    "notes" TEXT,

    CONSTRAINT "TrialGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."HarvestBatch" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "cropId" UUID NOT NULL,
    "storageUnitId" UUID,
    "trialGroupId" UUID,
    "variety" VARCHAR(100),
    "harvestAt" TIMESTAMPTZ(6) NOT NULL,
    "initialQuantity" DECIMAL(12,3) NOT NULL,
    "remainingQuantity" DECIMAL(12,3) NOT NULL,
    "unit" "public"."Unit" NOT NULL,
    "status" "public"."BatchStatus" NOT NULL DEFAULT 'STORED',
    "storageMethod" "public"."StorageMethod" NOT NULL,
    "community" VARCHAR(120) NOT NULL,
    "notes" TEXT,
    "baselineCondition" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "HarvestBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventoryMovement" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "delta" DECIMAL(12,3) NOT NULL,
    "reason" "public"."MovementReason" NOT NULL,
    "note" TEXT,
    "listingId" UUID,
    "offerId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "produceListingId" UUID,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SensorReading" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "sensorId" UUID,
    "storageUnitId" UUID,
    "actorId" UUID,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL,
    "ingestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "temperatureC" DECIMAL(6,2) NOT NULL,
    "relativeHumidityPercent" DECIMAL(5,2) NOT NULL,
    "source" "public"."ReadingSource" NOT NULL,
    "metadata" JSONB,
    "clientOperationId" VARCHAR(100),

    CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QualityObservation" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "observerId" UUID NOT NULL,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,
    "discardedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unit" "public"."Unit" NOT NULL,
    "firmness" VARCHAR(20) NOT NULL,
    "visibleMold" BOOLEAN NOT NULL DEFAULT false,
    "leakage" BOOLEAN NOT NULL DEFAULT false,
    "shriveling" BOOLEAN NOT NULL DEFAULT false,
    "qualityScore" INTEGER,
    "notes" TEXT,
    "clientOperationId" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualityObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PriceObservation" (
    "id" UUID NOT NULL,
    "cropId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "enteredById" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "unit" "public"."Unit" NOT NULL,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,
    "source" VARCHAR(250) NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "clientOperationId" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID,

    CONSTRAINT "PriceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PriceAlertRule" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cropId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "targetAmount" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "unit" "public"."Unit" NOT NULL,
    "condition" "public"."AlertCondition" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PriceAlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProduceListing" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "remainingQuantity" DECIMAL(12,3) NOT NULL,
    "unit" "public"."Unit" NOT NULL,
    "askingPrice" DECIMAL(14,2),
    "currency" VARCHAR(3),
    "availableFrom" TIMESTAMPTZ(6),
    "availableUntil" TIMESTAMPTZ(6) NOT NULL,
    "collectionArea" VARCHAR(180) NOT NULL,
    "contactPreference" VARCHAR(32) NOT NULL DEFAULT 'IN_APP',
    "contactConsent" BOOLEAN NOT NULL DEFAULT false,
    "status" "public"."ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "moderationNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ProduceListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BuyerOffer" (
    "id" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" "public"."Unit" NOT NULL,
    "offeredPrice" DECIMAL(14,2),
    "currency" VARCHAR(3),
    "message" TEXT,
    "status" "public"."OfferStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(6),

    CONSTRAINT "BuyerOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "event" "public"."NotificationEvent" NOT NULL,
    "payload" JSONB NOT NULL,
    "channel" "public"."NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "deliveryStatus" "public"."DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "deduplicationKey" VARCHAR(220) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "safeError" TEXT,
    "readAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "alertRuleId" UUID,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ContactRequest" (
    "id" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "message" VARCHAR(1000),
    "status" "public"."ContactRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "reviewedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserReport" (
    "id" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "listingId" UUID,
    "subject" VARCHAR(160) NOT NULL,
    "details" VARCHAR(2000) NOT NULL,
    "status" "public"."ReportStatus" NOT NULL DEFAULT 'OPEN',
    "outcome" TEXT,
    "moderatorId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "UserReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SyncOperation" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "clientOperationId" VARCHAR(100) NOT NULL,
    "entity" VARCHAR(80) NOT NULL,
    "operation" VARCHAR(40) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "status" "public"."SyncStatus" NOT NULL DEFAULT 'PROCESSING',
    "safeErrorCode" TEXT,
    "resultReference" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entityType" VARCHAR(80) NOT NULL,
    "entityId" VARCHAR(80),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "public"."User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE INDEX "User_role_active_idx" ON "public"."User"("role", "active");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "public"."RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_expiresAt_idx" ON "public"."RefreshToken"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "public"."PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_expiresAt_idx" ON "public"."PasswordResetToken"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Crop_name_key" ON "public"."Crop"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Market_name_community_region_key" ON "public"."Market"("name", "community", "region");

-- CreateIndex
CREATE INDEX "PreservationTrial_startedAt_endedAt_idx" ON "public"."PreservationTrial"("startedAt", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sensor_identity_key" ON "public"."Sensor"("identity");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCredential_sensorId_key" ON "public"."DeviceCredential"("sensorId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCredential_tokenHash_key" ON "public"."DeviceCredential"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "TrialGroup_trialId_type_key" ON "public"."TrialGroup"("trialId", "type");

-- CreateIndex
CREATE INDEX "HarvestBatch_ownerId_status_harvestAt_idx" ON "public"."HarvestBatch"("ownerId", "status", "harvestAt");

-- CreateIndex
CREATE INDEX "HarvestBatch_cropId_harvestAt_idx" ON "public"."HarvestBatch"("cropId", "harvestAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_batchId_createdAt_idx" ON "public"."InventoryMovement"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "SensorReading_batchId_recordedAt_idx" ON "public"."SensorReading"("batchId", "recordedAt");

-- CreateIndex
CREATE INDEX "SensorReading_sensorId_recordedAt_idx" ON "public"."SensorReading"("sensorId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SensorReading_actorId_clientOperationId_key" ON "public"."SensorReading"("actorId", "clientOperationId");

-- CreateIndex
CREATE INDEX "QualityObservation_batchId_observedAt_idx" ON "public"."QualityObservation"("batchId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "QualityObservation_observerId_clientOperationId_key" ON "public"."QualityObservation"("observerId", "clientOperationId");

-- CreateIndex
CREATE INDEX "PriceObservation_cropId_marketId_observedAt_idx" ON "public"."PriceObservation"("cropId", "marketId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PriceObservation_enteredById_clientOperationId_key" ON "public"."PriceObservation"("enteredById", "clientOperationId");

-- CreateIndex
CREATE INDEX "PriceAlertRule_cropId_marketId_active_idx" ON "public"."PriceAlertRule"("cropId", "marketId", "active");

-- CreateIndex
CREATE INDEX "ProduceListing_status_availableUntil_idx" ON "public"."ProduceListing"("status", "availableUntil");

-- CreateIndex
CREATE INDEX "ProduceListing_ownerId_status_idx" ON "public"."ProduceListing"("ownerId", "status");

-- CreateIndex
CREATE INDEX "BuyerOffer_listingId_status_createdAt_idx" ON "public"."BuyerOffer"("listingId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BuyerOffer_buyerId_status_idx" ON "public"."BuyerOffer"("buyerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_deduplicationKey_key" ON "public"."Notification"("deduplicationKey");

-- CreateIndex
CREATE INDEX "Notification_recipientId_readAt_createdAt_idx" ON "public"."Notification"("recipientId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_deliveryStatus_createdAt_idx" ON "public"."Notification"("deliveryStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContactRequest_listingId_requesterId_key" ON "public"."ContactRequest"("listingId", "requesterId");

-- CreateIndex
CREATE INDEX "UserReport_status_createdAt_idx" ON "public"."UserReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SyncOperation_actorId_createdAt_idx" ON "public"."SyncOperation"("actorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncOperation_actorId_clientOperationId_key" ON "public"."SyncOperation"("actorId", "clientOperationId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "public"."AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "public"."AuditLog"("actorId", "createdAt");

ALTER TABLE "public"."User"
  ADD CONSTRAINT "User_contact_method_required" CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL);

ALTER TABLE "public"."Farm"
  ADD CONSTRAINT "Farm_latitude_range" CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90)),
  ADD CONSTRAINT "Farm_longitude_range" CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));

ALTER TABLE "public"."HarvestBatch"
  ADD CONSTRAINT "HarvestBatch_initial_quantity_positive" CHECK ("initialQuantity" > 0),
  ADD CONSTRAINT "HarvestBatch_remaining_quantity_range" CHECK ("remainingQuantity" >= 0 AND "remainingQuantity" <= "initialQuantity");

ALTER TABLE "public"."InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_delta_nonzero" CHECK ("delta" <> 0);

ALTER TABLE "public"."SensorReading"
  ADD CONSTRAINT "SensorReading_humidity_range" CHECK ("relativeHumidityPercent" >= 0 AND "relativeHumidityPercent" <= 100);

ALTER TABLE "public"."QualityObservation"
  ADD CONSTRAINT "QualityObservation_discarded_nonnegative" CHECK ("discardedQuantity" >= 0),
  ADD CONSTRAINT "QualityObservation_score_range" CHECK ("qualityScore" IS NULL OR ("qualityScore" >= 1 AND "qualityScore" <= 5));

ALTER TABLE "public"."PriceObservation"
  ADD CONSTRAINT "PriceObservation_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "public"."PriceAlertRule"
  ADD CONSTRAINT "PriceAlertRule_target_positive" CHECK ("targetAmount" > 0);

ALTER TABLE "public"."ProduceListing"
  ADD CONSTRAINT "ProduceListing_quantity_range" CHECK ("quantity" > 0 AND "remainingQuantity" >= 0 AND "remainingQuantity" <= "quantity"),
  ADD CONSTRAINT "ProduceListing_price_currency_pair" CHECK (("askingPrice" IS NULL AND "currency" IS NULL) OR ("askingPrice" > 0 AND "currency" IS NOT NULL));

ALTER TABLE "public"."BuyerOffer"
  ADD CONSTRAINT "BuyerOffer_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "BuyerOffer_price_currency_pair" CHECK (("offeredPrice" IS NULL AND "currency" IS NULL) OR ("offeredPrice" > 0 AND "currency" IS NOT NULL));

-- AddForeignKey
ALTER TABLE "public"."RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Farm" ADD CONSTRAINT "Farm_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sensor" ADD CONSTRAINT "Sensor_storageUnitId_fkey" FOREIGN KEY ("storageUnitId") REFERENCES "public"."StorageUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DeviceCredential" ADD CONSTRAINT "DeviceCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DeviceCredential" ADD CONSTRAINT "DeviceCredential_sensorId_fkey" FOREIGN KEY ("sensorId") REFERENCES "public"."Sensor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TrialGroup" ADD CONSTRAINT "TrialGroup_trialId_fkey" FOREIGN KEY ("trialId") REFERENCES "public"."PreservationTrial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."HarvestBatch" ADD CONSTRAINT "HarvestBatch_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."HarvestBatch" ADD CONSTRAINT "HarvestBatch_cropId_fkey" FOREIGN KEY ("cropId") REFERENCES "public"."Crop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."HarvestBatch" ADD CONSTRAINT "HarvestBatch_storageUnitId_fkey" FOREIGN KEY ("storageUnitId") REFERENCES "public"."StorageUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."HarvestBatch" ADD CONSTRAINT "HarvestBatch_trialGroupId_fkey" FOREIGN KEY ("trialGroupId") REFERENCES "public"."TrialGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryMovement" ADD CONSTRAINT "InventoryMovement_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."HarvestBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryMovement" ADD CONSTRAINT "InventoryMovement_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryMovement" ADD CONSTRAINT "InventoryMovement_produceListingId_fkey" FOREIGN KEY ("produceListingId") REFERENCES "public"."ProduceListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SensorReading" ADD CONSTRAINT "SensorReading_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."HarvestBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SensorReading" ADD CONSTRAINT "SensorReading_sensorId_fkey" FOREIGN KEY ("sensorId") REFERENCES "public"."Sensor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SensorReading" ADD CONSTRAINT "SensorReading_storageUnitId_fkey" FOREIGN KEY ("storageUnitId") REFERENCES "public"."StorageUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SensorReading" ADD CONSTRAINT "SensorReading_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."QualityObservation" ADD CONSTRAINT "QualityObservation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."HarvestBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."QualityObservation" ADD CONSTRAINT "QualityObservation_observerId_fkey" FOREIGN KEY ("observerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PriceObservation" ADD CONSTRAINT "PriceObservation_cropId_fkey" FOREIGN KEY ("cropId") REFERENCES "public"."Crop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PriceObservation" ADD CONSTRAINT "PriceObservation_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "public"."Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PriceObservation" ADD CONSTRAINT "PriceObservation_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PriceObservation" ADD CONSTRAINT "PriceObservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PriceAlertRule" ADD CONSTRAINT "PriceAlertRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PriceAlertRule" ADD CONSTRAINT "PriceAlertRule_cropId_fkey" FOREIGN KEY ("cropId") REFERENCES "public"."Crop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PriceAlertRule" ADD CONSTRAINT "PriceAlertRule_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "public"."Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProduceListing" ADD CONSTRAINT "ProduceListing_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProduceListing" ADD CONSTRAINT "ProduceListing_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."HarvestBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuyerOffer" ADD CONSTRAINT "BuyerOffer_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "public"."ProduceListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BuyerOffer" ADD CONSTRAINT "BuyerOffer_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_alertRuleId_fkey" FOREIGN KEY ("alertRuleId") REFERENCES "public"."PriceAlertRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContactRequest" ADD CONSTRAINT "ContactRequest_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "public"."ProduceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContactRequest" ADD CONSTRAINT "ContactRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserReport" ADD CONSTRAINT "UserReport_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserReport" ADD CONSTRAINT "UserReport_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "public"."ProduceListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserReport" ADD CONSTRAINT "UserReport_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SyncOperation" ADD CONSTRAINT "SyncOperation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
