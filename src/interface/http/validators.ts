import { zValidator } from '@hono/zod-validator';
import { z, type ZodSchema } from 'zod';
import { ACCOUNT_TYPES, SYSTEM_ROLES } from '../../domain/account.js';
import { ValidationError } from '../../domain/errors.js';

const LOCAL_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato YYYY-MM-DD.');
const UUID = z.string().uuid('El identificador no es válido.');
const CENTS = z.number().int('Los importes van en centavos enteros.').min(0, 'El importe no puede ser negativo.').max(Number.MAX_SAFE_INTEGER);

export const setupSchema = z
  .object({
    chartTemplate: z.enum(['ec-supercias', 'empty']).default('ec-supercias'),
    fiscalYear: z.number().int().min(1990).max(2200).optional(),
    timezone: z.string().min(1).max(64).optional(),
    autoPostingFrom: LOCAL_DATE.optional(),
    baseCurrency: z.string().regex(/^[A-Z]{3}$/, 'La moneda debe ser un código de tres letras (USD).').optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  })
  .strict();

export const createAccountSchema = z
  .object({
    code: z.string().min(1, 'El código es obligatorio.').max(30),
    name: z.string().min(1, 'El nombre es obligatorio.').max(150),
    type: z.enum(ACCOUNT_TYPES as [string, ...string[]]).optional(),
    parentId: UUID.nullable().optional(),
    isPostable: z.boolean().optional(),
    systemRole: z.enum(SYSTEM_ROLES as unknown as [string, ...string[]]).nullable().optional(),
  })
  .strict();

export const updateAccountSchema = z
  .object({
    name: z.string().min(1, 'El nombre es obligatorio.').max(150),
    status: z.enum(['active', 'inactive']),
    /** Mueve el rol de sistema a esta cuenta (la deja de llevar la que lo tenía); `null` lo quita. */
    systemRole: z.enum(SYSTEM_ROLES as unknown as [string, ...string[]]).nullable(),
  })
  .partial()
  .strict();

export const updatePostingSettingsSchema = z
  .object({
    autoPosting: z.boolean(),
    autoPostingFrom: LOCAL_DATE.nullable(),
    timezone: z.string().min(1).max(64),
    paymentMethodRoles: z.record(z.string().regex(/^\d{2}$/, 'El código de forma de pago son dos cifras.'), z.enum(['cash', 'bank', 'receivables'])).nullable(),
  })
  .partial()
  .strict();

export const retryPendingSchema = z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).strict();
export const discardPendingSchema = z.object({ reason: z.string().min(3, 'Indica el motivo.').max(200) }).strict();

export const createCostCenterSchema = z
  .object({
    code: z.string().min(1, 'El código es obligatorio.').max(20),
    name: z.string().min(1, 'El nombre es obligatorio.').max(100),
  })
  .strict();

export const updateCostCenterSchema = z
  .object({
    name: z.string().min(1).max(100),
    status: z.enum(['active', 'inactive']),
  })
  .partial()
  .strict();

export const createFiscalYearSchema = z.object({ year: z.number().int().min(1990).max(2200) }).strict();

const lineSchema = z
  .object({
    accountId: UUID,
    debitCents: CENTS.optional(),
    creditCents: CENTS.optional(),
    description: z.string().max(255).nullable().optional(),
    costCenterId: UUID.nullable().optional(),
    projectId: UUID.nullable().optional(),
    establishmentId: UUID.nullable().optional(),
    partyType: z.enum(['customer', 'supplier', 'employee']).nullable().optional(),
    partyId: UUID.nullable().optional(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
    amountFcCents: CENTS.nullable().optional(),
    exchangeRate: z.number().positive().nullable().optional(),
  })
  .strict();

const entryBody = {
  entryDate: LOCAL_DATE,
  description: z.string().min(1, 'La descripción es obligatoria.').max(255),
  reference: z.string().max(60).nullable().optional(),
  lines: z.array(lineSchema).min(2, 'Un asiento necesita al menos dos líneas.').max(500),
};

export const createEntrySchema = z.object({ ...entryBody, post: z.boolean().default(false) }).strict();
export const updateEntrySchema = z.object(entryBody).strict();

export const reverseEntrySchema = z
  .object({
    reason: z.string().min(3, 'Indica el motivo de la reversa.').max(200),
    entryDate: LOCAL_DATE.optional(),
  })
  .strict();

export function validateJson<T extends ZodSchema>(schema: T) {
  return zValidator('json', schema, (result) => {
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
      throw new ValidationError(details);
    }
  });
}

/** Parámetros de consulta numéricos con tope: la página y su tamaño nunca salen del servidor sin acotar. */
export function intParam(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new ValidationError([{ field: 'query', message: 'Debe ser un número entero.' }]);
  return Math.min(Math.max(n, min), max);
}
