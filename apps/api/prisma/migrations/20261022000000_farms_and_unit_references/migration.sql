ALTER TABLE "public"."Farm"
    ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Farm_ownerId_active_name_idx" ON "public"."Farm"("ownerId", "active", "name");

CREATE TABLE "public"."UnitReference" (
    "code" "public"."Unit" NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "description" VARCHAR(240),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "UnitReference_pkey" PRIMARY KEY ("code")
);

INSERT INTO "public"."UnitReference" ("code", "label", "description", "updatedAt") VALUES
    ('KG', 'Kilogram', 'Metric mass unit; not interchangeable with crates or pieces.', CURRENT_TIMESTAMP),
    ('CRATE', 'Crate', 'Counted produce container; no mass conversion is defined.', CURRENT_TIMESTAMP),
    ('PIECE', 'Piece', 'Individual produce item; not interchangeable with mass units.', CURRENT_TIMESTAMP);
