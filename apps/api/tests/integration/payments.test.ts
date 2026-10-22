import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createAccessToken } from '../../src/common/auth';
import { createPrismaClient } from '../../src/common/prisma-client';
import { createApp } from '../../src/app';
import { parseEnv } from '../../src/config/env';
import type { PaymentProvider, PaymentProviderStatus } from '../../src/payments/provider';

const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = testUrl ? new URL(testUrl).pathname.slice(1) : '';
const isolatedTestDatabase = Boolean(testUrl && databaseName.endsWith('_test'));
const prisma = createPrismaClient(
  testUrl ?? 'postgresql://postgres@127.0.0.1:5432/harvestguard_test',
);
const env = parseEnv({
  NODE_ENV: 'test',
  DATABASE_URL: testUrl ?? 'postgresql://postgres@127.0.0.1:5432/harvestguard_test',
  JWT_ACCESS_SECRET: 'payment-test-jwt-secret-distinct-and-long-enough',
  DEVICE_TOKEN_PEPPER: 'payment-test-device-pepper-distinct-and-long',
  COOKIE_SECURE: 'false',
  PAYMENTS_ENABLED: 'true',
  PAYMENT_PROVIDER: 'fapshi',
  FAPSHI_MODE: 'sandbox',
  FAPSHI_API_USER: 'sandbox-user',
  FAPSHI_API_KEY: 'sandbox-key-never-real',
  FAPSHI_WEBHOOK_SECRET: 'payment-webhook-test-secret-with-at-least-32-chars',
  LOG_LEVEL: 'silent',
});

const createdUserIds: string[] = [];
const createdCropIds: string[] = [];
const createdOfferIds: string[] = [];
const createdListingIds: string[] = [];
const createdBatchIds: string[] = [];
let provider: PaymentProvider;
let statuses: Map<string, PaymentProviderStatus>;
let providerCreateCalls: Array<{ amount: number; externalId: string; userId: string }> = [];
let app: ReturnType<typeof createApp>;
let buyerId: string;
let buyerToken: string;
let otherBuyerToken: string;
let listingId: string;

beforeAll(async () => {
  if (!isolatedTestDatabase) return;
  await prisma.$connect();
  const suffix = randomUUID();
  const farmer = await prisma.user.create({
    data: {
      displayName: 'Payment test farmer',
      email: `farmer-${suffix}@example.invalid`,
      passwordHash: 'test-only-not-a-login-hash',
      role: 'FARMER',
      community: 'Buea',
    },
  });
  const buyer = await prisma.user.create({
    data: {
      displayName: 'Payment test buyer',
      email: `buyer-${suffix}@example.invalid`,
      passwordHash: 'test-only-not-a-login-hash',
      role: 'BUYER',
      community: 'Buea',
    },
  });
  const otherBuyer = await prisma.user.create({
    data: {
      displayName: 'Other payment buyer',
      email: `other-${suffix}@example.invalid`,
      passwordHash: 'test-only-not-a-login-hash',
      role: 'BUYER',
      community: 'Buea',
    },
  });
  buyerId = buyer.id;
  createdUserIds.push(farmer.id, buyer.id, otherBuyer.id);
  buyerToken = createAccessToken(buyer, env);
  otherBuyerToken = createAccessToken(otherBuyer, env);

  const crop = await prisma.crop.create({ data: { name: `Payment test crop ${suffix}` } });
  createdCropIds.push(crop.id);
  const batch = await prisma.harvestBatch.create({
    data: {
      ownerId: farmer.id,
      cropId: crop.id,
      harvestAt: new Date(),
      initialQuantity: 5,
      remainingQuantity: 5,
      unit: 'KG',
      storageMethod: 'OTHER',
      community: 'Buea',
    },
  });
  createdBatchIds.push(batch.id);
  const listing = await prisma.produceListing.create({
    data: {
      ownerId: farmer.id,
      batchId: batch.id,
      quantity: 5,
      remainingQuantity: 5,
      unit: 'KG',
      availableUntil: new Date(Date.now() + 86_400_000),
      collectionArea: 'Buea',
    },
  });
  createdListingIds.push(listing.id);
  listingId = listing.id;

  statuses = new Map();
  providerCreateCalls = [];
  provider = {
    async createPayment(input) {
      const transId = `provider-${input.externalId}`;
      providerCreateCalls.push(input);
      statuses.set(transId, {
        transId,
        status: 'PENDING',
        amount: input.amount,
        externalId: input.externalId,
        userId: input.userId,
      });
      return {
        transId,
        link: `https://sandbox.fapshi.com/checkout/${encodeURIComponent(input.externalId)}`,
      };
    },
    async getPaymentStatus(transId) {
      const status = statuses.get(transId);
      if (!status) throw new Error('Unexpected missing test transaction.');
      return { ...status };
    },
  };
  app = createApp(prisma, env, provider);
});

async function createConfirmedOffer(priceXaf = 1500): Promise<string> {
  const offer = await prisma.buyerOffer.create({
    data: {
      listingId,
      buyerId,
      quantity: 2,
      unit: 'KG',
      offeredPrice: priceXaf,
      currency: 'XAF',
      status: 'ACCEPTED',
      confirmedAt: new Date(),
    },
  });
  createdOfferIds.push(offer.id);
  return offer.id;
}

afterAll(async () => {
  if (isolatedTestDatabase && createdUserIds.length) {
    await prisma.paymentProviderEvent.deleteMany({
      where: { payment: { payerId: { in: createdUserIds } } },
    });
    await prisma.paymentIntent.deleteMany({ where: { payerId: { in: createdUserIds } } });
    await prisma.buyerOffer.deleteMany({ where: { id: { in: createdOfferIds } } });
    await prisma.produceListing.deleteMany({ where: { id: { in: createdListingIds } } });
    await prisma.harvestBatch.deleteMany({ where: { id: { in: createdBatchIds } } });
    await prisma.crop.deleteMany({ where: { id: { in: createdCropIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

describe.skipIf(!isolatedTestDatabase)('Fapshi payment intent workflow', () => {
  it('derives XAF from the accepted offer and replays one initiation safely', async () => {
    const offerId = await createConfirmedOffer();
    const key = randomUUID();
    await request(app)
      .post(`/api/payments/offers/${offerId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount: 1 })
      .expect(400);

    const initiated = await request(app)
      .post(`/api/payments/offers/${offerId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('Idempotency-Key', key)
      .expect(201);
    const payment = initiated.body.data;
    expect(payment.amount).toBe(1500);
    expect(payment.currency).toBe('XAF');
    expect(payment.status).toBe('PENDING');
    expect(payment.checkoutUrl).toContain('sandbox.fapshi.com');
    expect(payment).not.toHaveProperty('providerTransactionId');
    expect(JSON.stringify(payment)).not.toMatch(/apiuser|apikey|sandbox-key-never-real/i);
    expect(providerCreateCalls).toHaveLength(1);
    expect(providerCreateCalls[0]).toMatchObject({
      amount: 1500,
      userId: buyerId,
    });
    expect(providerCreateCalls[0].externalId).toBe(payment.reference);

    const replay = await request(app)
      .post(`/api/payments/offers/${offerId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('Idempotency-Key', key)
      .expect(200);
    expect(replay.body.data.id).toBe(payment.id);
    expect(providerCreateCalls).toHaveLength(1);

    const concurrentOfferId = await createConfirmedOffer();
    const concurrentKey = randomUUID();
    const concurrentResults = await Promise.all([
      request(app)
        .post(`/api/payments/offers/${concurrentOfferId}`)
        .set('Authorization', `Bearer ${buyerToken}`)
        .set('Idempotency-Key', concurrentKey),
      request(app)
        .post(`/api/payments/offers/${concurrentOfferId}`)
        .set('Authorization', `Bearer ${buyerToken}`)
        .set('Idempotency-Key', concurrentKey),
    ]);
    expect(concurrentResults.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(concurrentResults[0].body.data.id).toBe(concurrentResults[1].body.data.id);
    expect(providerCreateCalls).toHaveLength(2);

    const transId = `provider-${payment.reference}`;
    statuses.set(transId, { ...statuses.get(transId)!, status: 'SUCCESSFUL' });
    const reconciled = await request(app)
      .get(`/api/payments/${payment.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect(reconciled.body.data.status).toBe('SUCCESSFUL');

    await request(app)
      .get(`/api/payments/${payment.id}`)
      .set('Authorization', `Bearer ${otherBuyerToken}`)
      .expect(404);
    await request(app).get(`/api/payments/${payment.id}`).expect(401);
    const dbPayment = await prisma.paymentIntent.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(dbPayment.amountXaf).toBe(1500);
    expect(dbPayment.status).toBe('SUCCESSFUL');
  });

  it('settles only an authoritative matching status and deduplicates webhook deliveries', async () => {
    const offerId = await createConfirmedOffer();
    const key = randomUUID();
    const initiated = await request(app)
      .post(`/api/payments/offers/${offerId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('Idempotency-Key', key)
      .expect(201);
    const payment = initiated.body.data;
    const transId = `provider-${payment.reference}`;
    const current = statuses.get(transId)!;

    await request(app)
      .post('/api/payments/fapshi/webhook')
      .set('x-wh-secret', 'forged-webhook-secret')
      .send({
        transId,
        status: 'SUCCESSFUL',
        amount: 1500,
        externalId: payment.reference,
        userId: buyerId,
      })
      .expect(401);

    statuses.set(transId, { ...current, status: 'SUCCESSFUL', amount: 1499 });
    await request(app)
      .post('/api/payments/fapshi/webhook')
      .set('x-wh-secret', env.FAPSHI_WEBHOOK_SECRET!)
      .send({
        transId,
        status: 'SUCCESSFUL',
        amount: 1500,
        externalId: payment.reference,
        userId: buyerId,
      })
      .expect(200);
    let dbPayment = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: payment.id } });
    expect(dbPayment.status).toBe('PENDING');

    statuses.set(transId, { ...current, status: 'SUCCESSFUL' });
    const callback = {
      transId,
      status: 'SUCCESSFUL',
      amount: 1500,
      externalId: payment.reference,
      userId: buyerId,
    };
    const reconciled = await request(app)
      .get(`/api/payments/${payment.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .expect(200);
    expect(reconciled.body.data.status).toBe('SUCCESSFUL');
    await request(app)
      .post('/api/payments/fapshi/webhook')
      .set('x-wh-secret', env.FAPSHI_WEBHOOK_SECRET!)
      .send(callback)
      .expect(200);
    await request(app)
      .post('/api/payments/fapshi/webhook')
      .set('x-wh-secret', env.FAPSHI_WEBHOOK_SECRET!)
      .send(callback)
      .expect(200);
    dbPayment = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: payment.id } });
    expect(dbPayment.status).toBe('SUCCESSFUL');
    expect(await prisma.paymentProviderEvent.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(
      await prisma.paymentProviderEvent.findFirstOrThrow({ where: { paymentId: payment.id } }),
    ).toMatchObject({ outcome: 'STATUS_MISMATCH' });
    expect(await prisma.inventoryMovement.count({ where: { offerId } })).toBe(0);
    const offer = await prisma.buyerOffer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.confirmedAt).not.toBeNull();
  });

  it('does not accept another user, unknown key reuse, or a non-XAF offer', async () => {
    const offerId = await createConfirmedOffer();
    await request(app)
      .post(`/api/payments/offers/${offerId}`)
      .set('Authorization', `Bearer ${otherBuyerToken}`)
      .set('Idempotency-Key', randomUUID())
      .expect(404);

    const key = randomUUID();
    await request(app)
      .post(`/api/payments/offers/${offerId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('Idempotency-Key', key)
      .expect(201);
    const anotherOfferId = await createConfirmedOffer(2000);
    await request(app)
      .post(`/api/payments/offers/${anotherOfferId}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('Idempotency-Key', key)
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED'));

    const offer = await prisma.buyerOffer.update({
      where: { id: offerId },
      data: { currency: 'USD' },
    });
    await request(app)
      .post(`/api/payments/offers/${offer.id}`)
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('Idempotency-Key', randomUUID())
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('PAYMENT_AMOUNT_UNAVAILABLE'));
    await prisma.buyerOffer.update({ where: { id: offerId }, data: { currency: 'XAF' } });
  });
});
