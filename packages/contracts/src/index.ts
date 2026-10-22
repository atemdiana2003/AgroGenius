import { z } from 'zod';

const decimalPlaces = (value: number, places: number) => Number.isInteger(value * 10 ** places);

export const RoleSchema = z.enum(['FARMER', 'BUYER', 'ADMIN']);
export const UnitSchema = z.enum(['KG', 'CRATE', 'PIECE']);
export const BatchStatusSchema = z.enum([
  'STORED',
  'LISTED',
  'PARTIALLY_SOLD',
  'SOLD',
  'SPOILED',
  'ARCHIVED',
]);
export const ReadingSourceSchema = z.enum(['MANUAL', 'SENSOR', 'SIMULATED']);
export const OfferStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN']);
export const PaymentStatusSchema = z.enum([
  'CREATED',
  'PENDING',
  'SUCCESSFUL',
  'FAILED',
  'EXPIRED',
  'INITIATION_UNKNOWN',
]);
export const PaymentModeSchema = z.enum(['sandbox', 'live', 'simulated']);
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const IdSchema = z.string().uuid();
export const IsoDateSchema = z.string().datetime({ offset: true });
export const PaymentViewSchema = z.object({
  id: IdSchema,
  reference: z.string().uuid(),
  offerId: IdSchema,
  amount: z.number().int().positive(),
  currency: z.literal('XAF'),
  provider: z.enum(['FAPSHI', 'MOCK']),
  mode: PaymentModeSchema,
  checkoutUrl: z.string().url().nullable(),
  status: PaymentStatusSchema,
  failureCode: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  completedAt: IsoDateSchema.nullable(),
});

export const RegisterSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9\s().-]{7,32}$/)
      .optional(),
    email: z.string().trim().email().max(254).optional(),
    password: z.string().min(12).max(128),
    role: z.enum(['FARMER', 'BUYER']),
    community: z.string().trim().min(1).max(120),
    preferredLanguage: z.string().trim().min(2).max(12).default('en'),
    smsConsent: z.boolean().default(false),
  })
  .refine((value) => value.phone || value.email, {
    message: 'Provide a phone number or email address.',
  });

export const LoginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});

export const CreateBatchSchema = z.object({
  cropId: IdSchema,
  harvestAt: IsoDateSchema,
  quantity: z
    .number()
    .finite()
    .positive()
    .max(100000)
    .refine((value) => decimalPlaces(value, 3), 'Use no more than three decimal places.'),
  unit: UnitSchema,
  community: z.string().trim().min(1).max(120),
  storageMethod: z.enum(['COOLER', 'SHADED_CONTROL', 'OTHER']),
  storageUnitId: IdSchema.optional(),
  trialGroupId: IdSchema.optional(),
  notes: z.string().max(2000).optional(),
  baselineCondition: z.string().max(1000).optional(),
  clientOperationId: z.string().uuid().optional(),
});

export const ReadingSchema = z
  .object({
    batchId: IdSchema,
    sensorId: IdSchema.optional(),
    storageUnitId: IdSchema.optional(),
    recordedAt: IsoDateSchema,
    temperatureC: z
      .number()
      .finite()
      .min(-10)
      .max(60)
      .refine((value) => decimalPlaces(value, 2), 'Use no more than two decimal places.'),
    relativeHumidityPercent: z
      .number()
      .finite()
      .min(0)
      .max(100)
      .refine((value) => decimalPlaces(value, 2), 'Use no more than two decimal places.'),
    source: ReadingSourceSchema.default('MANUAL'),
    clientOperationId: z.string().uuid().optional(),
  })
  .refine((value) => value.source !== 'SENSOR' || Boolean(value.sensorId), {
    message: 'Sensor readings require a registered sensor.',
    path: ['sensorId'],
  });

export const PriceObservationSchema = z.object({
  cropId: IdSchema,
  marketId: IdSchema,
  amount: z
    .number()
    .finite()
    .positive()
    .max(100000000)
    .refine((value) => decimalPlaces(value, 2), 'Use no more than two decimal places.'),
  currency: CurrencySchema,
  unit: UnitSchema,
  observedAt: IsoDateSchema,
  source: z.string().trim().min(3).max(250),
  clientOperationId: z.string().uuid().optional(),
});

export const PriceAlertRuleSchema = z.object({
  cropId: IdSchema,
  marketId: IdSchema,
  targetAmount: z
    .number()
    .finite()
    .positive()
    .refine((value) => decimalPlaces(value, 2), 'Use no more than two decimal places.'),
  currency: CurrencySchema,
  unit: UnitSchema,
  condition: z.enum(['AT_OR_ABOVE', 'AT_OR_BELOW']),
  active: z.boolean().default(true),
});

export const ListingSchema = z.object({
  batchId: IdSchema,
  quantity: z
    .number()
    .finite()
    .positive()
    .refine((value) => decimalPlaces(value, 3), 'Use no more than three decimal places.'),
  unit: UnitSchema,
  askingPrice: z
    .number()
    .finite()
    .positive()
    .refine((value) => decimalPlaces(value, 2), 'Use no more than two decimal places.')
    .optional(),
  currency: CurrencySchema.optional(),
  availableFrom: IsoDateSchema.optional(),
  availableUntil: IsoDateSchema,
  collectionArea: z.string().trim().min(1).max(180),
  contactPreference: z.enum(['IN_APP', 'PHONE_AFTER_REQUEST']).default('IN_APP'),
  contactConsent: z.boolean().default(false),
  clientOperationId: z.string().uuid().optional(),
});

export const OfferSchema = z.object({
  quantity: z
    .number()
    .finite()
    .positive()
    .refine((value) => decimalPlaces(value, 3), 'Use no more than three decimal places.'),
  unit: UnitSchema,
  offeredPrice: z
    .number()
    .finite()
    .positive()
    .refine((value) => decimalPlaces(value, 2), 'Use no more than two decimal places.')
    .optional(),
  currency: CurrencySchema.optional(),
  message: z.string().max(1000).optional(),
  clientOperationId: z.string().uuid().optional(),
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.unknown()).default([]),
    requestId: z.string(),
  }),
});

export type Role = z.infer<typeof RoleSchema>;
export type Unit = z.infer<typeof UnitSchema>;
export type BatchStatus = z.infer<typeof BatchStatusSchema>;
export type ReadingSource = z.infer<typeof ReadingSourceSchema>;
export type OfferStatus = z.infer<typeof OfferStatusSchema>;
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type PaymentView = z.infer<typeof PaymentViewSchema>;
