# Data model

The canonical PostgreSQL schema is `apps/api/prisma/schema.prisma`; `apps/api/prisma/migrations/20261021000000_init/migration.sql` is the initial deployable migration. UUIDs are internal primary keys. Times are UTC `timestamptz`; currency/measurement are never inferred from a number.

| Domain       | Records                                                                                                 | Important relationships/invariants                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Identity     | User, Farm, RefreshToken, PasswordResetToken                                                            | Farmer/buyer/admin roles; unique normalized phone/email; only hashes for long-lived tokens                                       |
| Harvest      | Crop, HarvestBatch, InventoryMovement                                                                   | Batch owner + crop, positive initial and bounded remaining mass, explicit unit/status                                            |
| Preservation | StorageUnit, Sensor, DeviceCredential, PreservationTrial, TrialGroup, SensorReading, QualityObservation | Trial has separate cooler/control groups; reading source is `MANUAL`, `SENSOR`, or `SIMULATED`; stored °C/RH; batch/time indexes |
| Market       | Market, PriceObservation, PriceAlertRule                                                                | Append-only history with currency and unit; notifications dedupe by alert-rule/observation                                       |
| Marketplace  | ProduceListing, BuyerOffer, ContactRequest                                                              | Owner, batch, expiry, consent; acceptance is distinct from confirmed sale                                                        |
| Operations   | Notification, SyncOperation, UserReport, AuditLog                                                       | In-app state is separate from SMS delivery; persistent idempotency and moderation history                                        |

Database checks in the SQL migration enforce positive quantities/prices and humidity 0–100%. Application checks enforce plausible configurable temperature bounds, ownership, status transitions, and compatible units. There is no implicit conversion between KG, CRATE, and PIECE. A future schema change must add a new committed Prisma migration; production must not use `db push`.
