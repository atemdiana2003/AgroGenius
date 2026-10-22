import { describe, expect, it } from 'vitest';
import {
  CreateBatchSchema,
  ListingSchema,
  PriceObservationSchema,
  ReadingSchema,
  RegisterSchema,
} from '@harvestguard/contracts';

const id = '4f451470-9344-4f1e-8a02-5891c700c6e1';
const timestamp = '2026-10-01T09:00:00.000Z';

describe('shared API contracts', () => {
  it('does not allow public registration to request ADMIN', () => {
    const parsed = RegisterSchema.safeParse({
      displayName: 'Test',
      email: 'test@example.invalid',
      password: 'long-enough-password',
      role: 'ADMIN',
      community: 'Buea',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a zero harvest quantity and invalid crop identifier', () => {
    expect(
      CreateBatchSchema.safeParse({
        cropId: 'not-a-uuid',
        harvestAt: timestamp,
        quantity: 0,
        unit: 'KG',
        community: 'Buea',
        storageMethod: 'COOLER',
      }).success,
    ).toBe(false);
  });

  it('rejects humidity outside physical percentage bounds', () => {
    expect(
      ReadingSchema.safeParse({
        batchId: id,
        recordedAt: timestamp,
        temperatureC: 20,
        relativeHumidityPercent: 101,
        source: 'MANUAL',
      }).success,
    ).toBe(false);
  });

  it('rejects quantities and prices that would be silently rounded by PostgreSQL', () => {
    expect(
      CreateBatchSchema.safeParse({
        cropId: id,
        harvestAt: timestamp,
        quantity: 1.2345,
        unit: 'KG',
        community: 'Buea',
        storageMethod: 'COOLER',
      }).success,
    ).toBe(false);
    expect(
      PriceObservationSchema.safeParse({
        cropId: id,
        marketId: id,
        amount: 10.123,
        currency: 'XAF',
        unit: 'KG',
        observedAt: timestamp,
        source: 'Participant interview',
      }).success,
    ).toBe(false);
  });

  it('requires a source for historical prices and expiry for listings', () => {
    expect(
      PriceObservationSchema.safeParse({
        cropId: id,
        marketId: id,
        amount: 200,
        currency: 'XAF',
        unit: 'KG',
        observedAt: timestamp,
      }).success,
    ).toBe(false);
    expect(
      ListingSchema.safeParse({
        batchId: id,
        quantity: 2,
        unit: 'KG',
        collectionArea: 'Buea',
      }).success,
    ).toBe(false);
  });
});
