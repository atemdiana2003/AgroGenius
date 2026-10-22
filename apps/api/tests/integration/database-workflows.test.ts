import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createPrismaClient } from '../../src/common/prisma-client';
import { createApp } from '../../src/app';
import { parseEnv } from '../../src/config/env';
import { createAccessToken } from '../../src/common/auth';

const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = testUrl ? new URL(testUrl).pathname.slice(1) : '';
const isolatedTestDatabase = Boolean(testUrl && databaseName.endsWith('_test'));
const prisma = createPrismaClient(
  isolatedTestDatabase
    ? testUrl
    : 'postgresql://postgres:postgres@127.0.0.1:5432/harvestguard_test',
);
const env = parseEnv({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: testUrl ?? 'postgresql://test:test@127.0.0.1:5432/harvestguard_test',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'integration-test-secret-that-is-long-enough',
  ACCESS_TOKEN_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_DAYS: '30',
  LOG_LEVEL: 'silent',
  COOKIE_SECURE: 'false',
  SMS_PROVIDER: 'simulated',
  DEVICE_TOKEN_PEPPER: 'integration-test-device-pepper-long-enough',
  RESET_TOKEN_TTL_MINUTES: '30',
  TEMPERATURE_MIN_C: '-10',
  TEMPERATURE_MAX_C: '60',
  EXPERIMENTAL_TEMP_MIN_C: '8',
  EXPERIMENTAL_TEMP_MAX_C: '15',
  EXPERIMENTAL_RH_MIN_PERCENT: '70',
  EXPERIMENTAL_RH_MAX_PERCENT: '95',
});
const app = createApp(prisma, env);
const developmentApp = createApp(prisma, { ...env, NODE_ENV: 'development' });
const createdUserIds: string[] = [];
const createdTrialIds: string[] = [];

beforeAll(async () => {
  if (isolatedTestDatabase) await prisma.$connect();
});

afterAll(async () => {
  if (isolatedTestDatabase && createdUserIds.length) {
    await prisma.buyerOffer.deleteMany({
      where: { listing: { batch: { ownerId: { in: createdUserIds } } } },
    });
    await prisma.produceListing.deleteMany({
      where: { batch: { ownerId: { in: createdUserIds } } },
    });
    await prisma.inventoryMovement.deleteMany({
      where: { batch: { ownerId: { in: createdUserIds } } },
    });
    await prisma.harvestBatch.deleteMany({ where: { ownerId: { in: createdUserIds } } });
    if (createdTrialIds.length) {
      await prisma.preservationTrial.deleteMany({ where: { id: { in: createdTrialIds } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

describe.skipIf(!isolatedTestDatabase)('PostgreSQL-backed ownership and inventory workflow', () => {
  it('registers only a farmer/buyer, enforces ownership, and serializes concurrent inventory changes', async () => {
    const suffix = randomUUID();
    const farmerA = await request(app)
      .post('/api/auth/register')
      .send({
        displayName: 'Test farmer A',
        phone: '+237670000001',
        email: `farmer-a-${suffix}@example.invalid`,
        password: 'integration-test-password',
        role: 'FARMER',
        community: 'Buea',
      })
      .expect(201);
    const farmerB = await request(app)
      .post('/api/auth/register')
      .send({
        displayName: 'Test farmer B',
        email: `farmer-b-${suffix}@example.invalid`,
        password: 'integration-test-password',
        role: 'FARMER',
        community: 'Buea',
      })
      .expect(201);
    createdUserIds.push(farmerA.body.data.id, farmerB.body.data.id);

    await request(app)
      .post('/api/auth/register')
      .send({
        displayName: 'Illegal admin',
        email: `admin-${suffix}@example.invalid`,
        password: 'integration-test-password',
        role: 'ADMIN',
        community: 'Buea',
      })
      .expect(400);

    const loginA = await request(app)
      .post('/api/auth/login')
      .send({
        identifier: `farmer-a-${suffix}@example.invalid`,
        password: 'integration-test-password',
      })
      .expect(200);
    expect(loginA.body.data).not.toHaveProperty('refreshToken');
    expect(loginA.headers['set-cookie']?.[0]).toContain('hg_refresh=');
    const loginB = await request(app)
      .post('/api/auth/login')
      .set('X-Refresh-Transport', 'body')
      .send({
        identifier: `farmer-b-${suffix}@example.invalid`,
        password: 'integration-test-password',
      })
      .expect(200);
    expect(loginB.body.data.refreshToken).toEqual(expect.any(String));
    const tokenA = loginA.body.data.accessToken as string;
    const tokenB = loginB.body.data.accessToken as string;
    const buyer = await prisma.user.create({
      data: {
        displayName: 'Integration buyer',
        phone: '+237670000003',
        email: `buyer-${suffix}@example.invalid`,
        passwordHash: 'not-used-by-this-test',
        role: 'BUYER',
        community: 'Buea',
      },
    });
    createdUserIds.push(buyer.id);
    const buyerToken = createAccessToken(buyer, env);
    const profileBefore = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(profileBefore.body.data.id).toBe(farmerA.body.data.id);
    expect(profileBefore.body.data).not.toHaveProperty('passwordHash');
    const profileUpdated = await request(app)
      .patch('/api/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        expectedVersion: profileBefore.body.data.version,
        displayName: 'Updated farmer A',
        smsConsent: true,
        smsOptOut: false,
        quietHoursStart: '20:00',
        quietHoursEnd: '06:00',
      })
      .expect(200);
    expect(profileUpdated.body.data.displayName).toBe('Updated farmer A');
    expect(profileUpdated.body.data.smsConsent).toBe(true);
    expect(profileUpdated.body.data).not.toHaveProperty('passwordHash');
    expect(profileUpdated.body.data).not.toHaveProperty('refreshToken');
    await request(app)
      .patch('/api/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ expectedVersion: profileBefore.body.data.version, community: 'Stale update' })
      .expect(409);
    await request(app)
      .patch('/api/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ quietHoursStart: '24:00' })
      .expect(400);
    const farmerBProfile = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(farmerBProfile.body.data.id).toBe(farmerB.body.data.id);

    const farmWithoutLocation = await request(app)
      .post('/api/farms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Optional location farm', community: 'Buea' })
      .expect(201);
    expect(farmWithoutLocation.body.data.latitude).toBeNull();
    expect(farmWithoutLocation.body.data.longitude).toBeNull();
    const farmWithLocation = await request(app)
      .post('/api/farms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Located farm', community: 'Buea', latitude: 5.95, longitude: 10.17 })
      .expect(201);
    await request(app)
      .post('/api/farms')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Invalid location farm', community: 'Buea', latitude: 91, longitude: 10 })
      .expect(400);
    await request(app)
      .get(`/api/farms/${farmWithLocation.body.data.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
    await request(app)
      .patch(`/api/farms/${farmWithLocation.body.data.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Cross-owner update' })
      .expect(404);
    await request(app)
      .patch(`/api/farms/${farmWithLocation.body.data.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ expectedVersion: farmWithLocation.body.data.version, community: 'Mutengene' })
      .expect(200);
    await request(app)
      .delete(`/api/farms/${farmWithLocation.body.data.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const activeFarms = await request(app)
      .get('/api/farms')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(activeFarms.body.data.map((farm: { id: string }) => farm.id)).toEqual([
      farmWithoutLocation.body.data.id,
    ]);

    const crop = await prisma.crop.upsert({
      where: { name: 'Tomato' },
      update: {},
      create: { name: 'Tomato', validatedForTrial: false },
    });
    const units = await request(app).get('/api/units').expect(200);
    expect(units.body.data.map((unit: { code: string }) => unit.code)).toEqual([
      'CRATE',
      'KG',
      'PIECE',
    ]);
    const admin = await prisma.user.create({
      data: {
        displayName: 'Integration admin',
        email: `admin-${suffix}@example.invalid`,
        passwordHash: 'not-used-by-this-test',
        role: 'ADMIN',
        community: 'Buea',
      },
    });
    createdUserIds.push(admin.id);
    const adminToken = createAccessToken(admin, env);
    await request(app)
      .patch('/api/admin/units/PIECE')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: false })
      .expect(200);
    const activeUnits = await request(app).get('/api/units').expect(200);
    expect(activeUnits.body.data.map((unit: { code: string }) => unit.code)).not.toContain('PIECE');
    await request(app)
      .post('/api/batches')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        cropId: crop.id,
        harvestAt: new Date(Date.now() - 3600000).toISOString(),
        quantity: 1,
        unit: 'PIECE',
        community: 'Buea',
        storageMethod: 'SHADED_CONTROL',
      })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('UNIT_UNAVAILABLE'));
    await request(app)
      .patch('/api/admin/units/PIECE')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true })
      .expect(200);

    const trial = await request(app)
      .post('/api/admin/trials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        label: 'Integration trial',
        startedAt: new Date(Date.now() - 86400000).toISOString(),
        endedAt: new Date().toISOString(),
        protocolNotes: 'Integration protocol',
        limitationNotes: 'Integration limitation',
      })
      .expect(201);
    createdTrialIds.push(trial.body.data.id);
    const group = await request(app)
      .post('/api/admin/trial-groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        trialId: trial.body.data.id,
        label: 'Integration cooler group',
        type: 'COOLER_TEST',
        initialMass: 10,
        unit: 'KG',
      })
      .expect(201);
    const exportBatch = await request(app)
      .post('/api/batches')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        cropId: crop.id,
        harvestAt: new Date(Date.now() - 3600000).toISOString(),
        quantity: 10,
        unit: 'KG',
        community: '=1+1',
        storageMethod: 'COOLER',
        trialGroupId: group.body.data.id,
      })
      .expect(201);
    const readingOperationId = randomUUID();
    const manualReading = {
      batchId: exportBatch.body.data.id,
      recordedAt: new Date().toISOString(),
      temperatureC: 21,
      relativeHumidityPercent: 80,
      source: 'MANUAL',
    };
    await request(app)
      .post('/api/readings')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', readingOperationId)
      .send(manualReading)
      .expect(201);
    const replayedReading = await request(app)
      .post('/api/readings')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', readingOperationId)
      .send(manualReading)
      .expect(200);
    expect(replayedReading.headers['idempotency-replayed']).toBe('true');
    await request(app)
      .post('/api/readings')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', readingOperationId)
      .send({ ...manualReading, temperatureC: 22 })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED'));
    expect(await prisma.sensorReading.count({ where: { batchId: exportBatch.body.data.id } })).toBe(
      1,
    );
    await request(app)
      .post('/api/quality-observations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        batchId: exportBatch.body.data.id,
        observedAt: new Date().toISOString(),
        discardedQuantity: 0,
        unit: 'KG',
        firmness: 'FIRM',
        visibleMold: false,
        leakage: false,
        shriveling: false,
      })
      .expect(201);
    const batchesCsv = await request(app)
      .get('/api/admin/exports/batches.csv?pageSize=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(batchesCsv.text).toContain('"\'=1+1"');
    expect(Number(batchesCsv.headers['x-export-total'])).toBeGreaterThan(0);
    await request(app)
      .get('/api/admin/exports/readings.csv')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(403);
    const readingsCsv = await request(app)
      .get('/api/admin/exports/readings.csv')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(readingsCsv.text).toContain('MANUAL');
    expect(readingsCsv.text).toContain('temperature_c');
    const observationsCsv = await request(app)
      .get('/api/admin/exports/quality-observations.csv')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(observationsCsv.text).toContain('discarded_quantity');
    expect(observationsCsv.text).toContain('FIRM');
    const trialCsv = await request(app)
      .get('/api/admin/exports/trial-comparisons.csv')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(trialCsv.text).toContain('Integration protocol');
    expect(trialCsv.text).toContain('COOLER_TEST');

    const failedOperationId = randomUUID();
    const failedBatchInput = {
      cropId: randomUUID(),
      harvestAt: new Date(Date.now() - 3600000).toISOString(),
      quantity: 1,
      unit: 'KG',
      community: 'Buea',
      storageMethod: 'SHADED_CONTROL',
    };
    await request(app)
      .post('/api/batches')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', failedOperationId)
      .send(failedBatchInput)
      .expect(400);
    const failedOperation = await request(app)
      .get(`/api/sync/operations/${failedOperationId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(failedOperation.body.data).toMatchObject({
      status: 'FAILED',
      safeErrorCode: 'CROP_UNAVAILABLE',
    });
    await request(app)
      .post('/api/batches')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', failedOperationId)
      .send(failedBatchInput)
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('SYNC_PREVIOUSLY_FAILED'));

    const cookieA = (loginA.headers['set-cookie']?.[0] ?? '').split(';')[0];
    const cookieRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieA)
      .set('Origin', 'http://localhost:5173')
      .expect(200);
    expect(cookieRefresh.body.data).not.toHaveProperty('refreshToken');
    expect(cookieRefresh.headers['set-cookie']?.[0]).toContain('hg_refresh=');
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieA)
      .set('Origin', 'http://localhost:5173')
      .expect(401);

    const bodyRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('X-Refresh-Transport', 'body')
      .send({ refreshToken: loginB.body.data.refreshToken })
      .expect(200);
    expect(bodyRefresh.body.data.refreshToken).toEqual(expect.any(String));
    await request(app)
      .post('/api/auth/refresh')
      .set('X-Refresh-Transport', 'body')
      .send({ refreshToken: loginB.body.data.refreshToken })
      .expect(401);
    await request(app)
      .post('/api/auth/logout')
      .set('X-Refresh-Transport', 'body')
      .send({ refreshToken: bodyRefresh.body.data.refreshToken })
      .expect(200);

    const resetRequest = await request(developmentApp)
      .post('/api/auth/password-reset/request')
      .send({ identifier: `farmer-a-${suffix}@example.invalid` })
      .expect(200);
    const resetToken = resetRequest.body.data.developmentOnlyResetToken as string;
    expect(resetToken).toEqual(expect.any(String));
    await request(developmentApp)
      .post('/api/auth/password-reset/confirm')
      .send({ token: resetToken, newPassword: 'integration-test-password-updated' })
      .expect(200);
    await request(developmentApp)
      .post('/api/auth/password-reset/confirm')
      .send({ token: resetToken, newPassword: 'integration-test-password-replayed' })
      .expect(400);
    const farmerASessions = await prisma.refreshToken.findMany({
      where: { userId: farmerA.body.data.id },
    });
    expect(farmerASessions.length).toBeGreaterThan(0);
    expect(farmerASessions.every((session) => session.revokedAt !== null)).toBe(true);
    await request(developmentApp)
      .post('/api/auth/login')
      .send({
        identifier: `farmer-a-${suffix}@example.invalid`,
        password: 'integration-test-password',
      })
      .expect(401);
    await request(developmentApp)
      .post('/api/auth/login')
      .send({
        identifier: `farmer-a-${suffix}@example.invalid`,
        password: 'integration-test-password-updated',
      })
      .expect(200);

    await request(app)
      .post('/api/batches')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        harvestAt: new Date(Date.now() - 3600000).toISOString(),
        quantity: 10,
        unit: 'KG',
        community: 'Buea',
        storageMethod: 'SHADED_CONTROL',
      })
      .expect(400);

    const created = await request(app)
      .post('/api/batches')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        cropId: crop.id,
        harvestAt: new Date(Date.now() - 3600000).toISOString(),
        quantity: 10,
        unit: 'KG',
        community: 'Buea',
        storageMethod: 'SHADED_CONTROL',
      })
      .expect(201);

    await request(app)
      .get(`/api/batches/${created.body.data.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);

    const movement = {
      expectedVersion: 1,
      delta: -6,
      reason: 'ADJUSTMENT',
      note: 'test transaction',
    };
    const changes = await Promise.all([
      request(app)
        .post(`/api/batches/${created.body.data.id}/movements`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send(movement),
      request(app)
        .post(`/api/batches/${created.body.data.id}/movements`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send(movement),
    ]);
    expect(changes.map((response) => response.status).sort()).toEqual([201, 409]);
    const finalBatch = await prisma.harvestBatch.findUniqueOrThrow({
      where: { id: created.body.data.id },
    });
    expect(Number(finalBatch.remainingQuantity)).toBe(4);
    expect(await prisma.inventoryMovement.count({ where: { batchId: finalBatch.id } })).toBe(2);
    const listing = await request(app)
      .post('/api/listings')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        batchId: finalBatch.id,
        quantity: 3,
        unit: 'KG',
        availableUntil: new Date(Date.now() + 3600000).toISOString(),
        collectionArea: 'Buea',
        contactPreference: 'PHONE_AFTER_REQUEST',
        contactConsent: true,
      })
      .expect(201);
    const offer = await request(app)
      .post(`/api/listings/${listing.body.data.id}/offers`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ quantity: 1, unit: 'KG' })
      .expect(201);
    const acceptedOffer = await request(app)
      .patch(`/api/offers/${offer.body.data.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ expectedVersion: offer.body.data.version, status: 'ACCEPTED' })
      .expect(200);

    const contactRequest = await request(app)
      .post(`/api/listings/${listing.body.data.id}/contact-requests`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ message: 'Please contact me about collection.' })
      .expect(201);
    expect(
      await prisma.notification.count({
        where: {
          recipientId: farmerA.body.data.id,
          event: 'CONTACT_REQUEST',
          deduplicationKey: `contact-request:${contactRequest.body.data.id}`,
        },
      }),
    ).toBe(1);
    const privateContact = await request(app)
      .get(`/api/contact-requests/${contactRequest.body.data.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect(privateContact.body.data).not.toHaveProperty('contactDetails');
    await request(app)
      .get(`/api/contact-requests/${contactRequest.body.data.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
    await request(app)
      .patch(`/api/contact-requests/${contactRequest.body.data.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ status: 'APPROVED' })
      .expect(200);
    const approvedContact = await request(app)
      .get(`/api/contact-requests/${contactRequest.body.data.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect(approvedContact.body.data.contactDetails.phone).toBe('+237670000001');

    const saleRequests = await Promise.all([
      request(app)
        .post(`/api/offers/${offer.body.data.id}/confirm-sale`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ expectedVersion: acceptedOffer.body.data.version }),
      request(app)
        .post(`/api/offers/${offer.body.data.id}/confirm-sale`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ expectedVersion: acceptedOffer.body.data.version }),
    ]);
    expect(saleRequests.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await prisma.inventoryMovement.count({ where: { offerId: offer.body.data.id } })).toBe(
      1,
    );
    const postSaleBatch = await prisma.harvestBatch.findUniqueOrThrow({
      where: { id: finalBatch.id },
    });
    expect(Number(postSaleBatch.remainingQuantity)).toBe(3);

    await request(app)
      .post('/api/quality-observations')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        batchId: finalBatch.id,
        observedAt: new Date().toISOString(),
        discardedQuantity: 2,
        unit: 'KG',
        firmness: 'SOFT',
        visibleMold: true,
        leakage: false,
        shriveling: false,
      })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('LISTING_INVENTORY_RESERVED'));
    expect(await prisma.qualityObservation.count({ where: { batchId: finalBatch.id } })).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { batchId: finalBatch.id } })).toBe(3);
    const unchangedListing = await prisma.produceListing.findUniqueOrThrow({
      where: { id: listing.body.data.id },
    });
    expect(Number(unchangedListing.remainingQuantity)).toBe(2);
  });
});
