import { beforeEach, describe, expect, it } from 'vitest';
import { draftFromPaymentPosted, type RuleContext } from '../domain/posting.js';
import { InMemoryStore, ORG_A, buildPosting, setupOrg } from './helpers.js';

/**
 * Asiento del pago a un proveedor (tesorería, Fase 3 bloque D): `treasury.payment.posted` y su anulación `treasury.payment.voided`.
 * La factura de compra NO se asienta otra vez (su asiento lo hizo `purchasing.bill.posted`).
 */
const SUPPLIER = '88888888-8888-4888-8888-888888888888';
let n = 0;
const uuid = () => `bbbbbbbb-bbbb-4bbb-8bbb-${String((n += 1)).padStart(12, '0')}`;

const paymentEvent = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG_A,
  paymentId: uuid(),
  number: 'PG-2026-000001',
  paymentDate: '2026-10-21',
  supplierId: SUPPLIER,
  supplierName: 'PROVEEDOR UNO S.A.',
  currencyCode: 'USD',
  accountRole: 'bank',
  totalCents: 11500,
  advanceUsedCents: 0,
  appliedCents: 11500,
  advanceCents: 0,
  ...over,
});

const ctx: RuleContext = { baseCurrency: 'USD', timeZone: 'America/Guayaquil', paymentMethodRoles: null, now: new Date('2026-10-21T15:00:00.000Z') };

let store: InMemoryStore;
let env: Awaited<ReturnType<typeof setupOrg>>;
let posting: ReturnType<typeof buildPosting>;
beforeEach(async () => {
  store = new InMemoryStore();
  env = await setupOrg(store);
  posting = buildPosting(store);
  n = 0;
});
const entries = () => [...store.entryMap.values()];
const pendings = () => [...store.pendingMap.values()];
const acc = (code: string) => env.byCode(code).id;
const shape = (e: { lines: Array<{ accountId: string; debitCents: number; creditCents: number }> }) => e.lines.map((l) => [l.accountId, l.debitCents, l.creditCents]);
const CASH = '1.1.01.01';
const BANK = '1.1.01.02';
const PAYABLES = '2.1.01.01';
const SUPPLIER_ADVANCES = '1.1.04.02';

describe('regla pura: draftFromPaymentPosted', () => {
  it('pago a una factura: Dr proveedores (con el proveedor como tercero) / Cr banco', () => {
    const r = draftFromPaymentPosted(paymentEvent() as never, ctx);
    expect(r.kind).toBe('draft');
    if (r.kind !== 'draft') return;
    expect(r.lines).toEqual([
      { role: 'payables', debitCents: 11500, creditCents: 0, establishmentId: null, partyType: 'supplier', partyId: SUPPLIER },
      { role: 'bank', debitCents: 0, creditCents: 11500, establishmentId: null },
    ]);
    expect(r).toMatchObject({ entryDate: '2026-10-21', sourceType: 'payment', reference: 'PG-2026-000001', currencyCode: 'USD' });
    expect(r.description).toBe('Pago PG-2026-000001 — PROVEEDOR UNO S.A.');
  });

  it('el efectivo sale de caja', () => {
    const r = draftFromPaymentPosted(paymentEvent({ accountRole: 'cash' }) as never, ctx);
    expect(r.kind === 'draft' && r.lines.find((l) => l.creditCents > 0)!.role).toBe('cash');
  });

  it('con excedente: Dr anticipos a proveedores (con el proveedor como tercero) por lo que sobra', () => {
    const r = draftFromPaymentPosted(paymentEvent({ totalCents: 15000, appliedCents: 10000, advanceCents: 5000 }) as never, ctx);
    if (r.kind !== 'draft') throw new Error('debía ser un asiento');
    expect(r.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([['payables', 10000, 0], ['supplier_advances', 5000, 0], ['bank', 0, 15000]]);
    expect(r.lines.find((l) => l.role === 'supplier_advances')).toMatchObject({ partyType: 'supplier', partyId: SUPPLIER });
  });

  it('consumiendo un anticipo: Cr anticipos a proveedores, sin dinero que salga de caja ni bancos', () => {
    const r = draftFromPaymentPosted(paymentEvent({ totalCents: 0, advanceUsedCents: 4000, appliedCents: 4000 }) as never, ctx);
    if (r.kind !== 'draft') throw new Error('debía ser un asiento');
    expect(r.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([['payables', 4000, 0], ['supplier_advances', 0, 4000]]);
  });

  it('mezcla: dinero + anticipo consumido + excedente, y el asiento cuadra', () => {
    const r = draftFromPaymentPosted(paymentEvent({ totalCents: 4000, advanceUsedCents: 3000, appliedCents: 5000, advanceCents: 2000 }) as never, ctx);
    if (r.kind !== 'draft') throw new Error('debía ser un asiento');
    expect(r.lines.reduce((s, l) => s + l.debitCents, 0)).toBe(7000);
    expect(r.lines.reduce((s, l) => s + l.creditCents, 0)).toBe(7000);
  });

  it('un pago sin facturas (todo anticipo) es Dr anticipos a proveedores / Cr banco', () => {
    const r = draftFromPaymentPosted(paymentEvent({ totalCents: 8000, appliedCents: 0, advanceCents: 8000 }) as never, ctx);
    if (r.kind !== 'draft') throw new Error('debía ser un asiento');
    expect(r.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([['supplier_advances', 8000, 0], ['bank', 0, 8000]]);
  });

  it('un evento que no cuadra queda bloqueado (UNBALANCED_SOURCE); moneda distinta: CURRENCY_MISMATCH; sin importe se ignora', () => {
    expect(draftFromPaymentPosted(paymentEvent({ appliedCents: 11000 }) as never, ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'UNBALANCED_SOURCE' });
    expect(draftFromPaymentPosted(paymentEvent({ currencyCode: 'EUR' }) as never, ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'CURRENCY_MISMATCH' });
    expect(draftFromPaymentPosted(paymentEvent({ totalCents: 0, appliedCents: 0 }) as never, ctx)).toMatchObject({ kind: 'skip' });
    expect(draftFromPaymentPosted(paymentEvent({ accountRole: 'payables' }) as never, ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'UNMAPPED_COLLECTION_ROLE' });
  });

  it('la fecha del pago sin hora NO se corre un día (en Guayaquil saldría el anterior)', () => {
    for (const date of ['2026-10-21', '2026-11-01', '2027-01-01']) {
      const r = draftFromPaymentPosted(paymentEvent({ paymentDate: date }) as never, ctx);
      expect(r.kind === 'draft' && r.entryDate).toBe(date);
    }
  });
});

describe('treasury.payment.posted → asiento contabilizado', () => {
  it('Dr Proveedores / Cr Bancos, con el proveedor como tercero, el número y la descripción', async () => {
    const ev = paymentEvent();
    expect((await posting.handle('treasury.payment.posted', ev)).outcome).toBe('posted');
    const [e] = entries();
    expect(e).toMatchObject({ kind: 'automatic', status: 'posted', sourceType: 'payment', sourceId: ev.paymentId, entryDate: '2026-10-21', totalDebitCents: 11500, totalCreditCents: 11500 });
    expect(shape(e!)).toEqual(expect.arrayContaining([[acc(PAYABLES), 11500, 0], [acc(BANK), 0, 11500]]));
    expect(e!.lines.find((l) => l.accountId === acc(PAYABLES))).toMatchObject({ partyType: 'supplier', partyId: SUPPLIER });
    expect(e!.description).toContain('PG-2026-000001');
  });

  it('el efectivo sale de Caja; el excedente va a Anticipos a proveedores con el proveedor como tercero', async () => {
    await posting.handle('treasury.payment.posted', paymentEvent({ accountRole: 'cash', totalCents: 15000, appliedCents: 10000, advanceCents: 5000 }));
    const e = entries()[0]!;
    expect(shape(e)).toEqual(expect.arrayContaining([[acc(CASH), 0, 15000], [acc(PAYABLES), 10000, 0], [acc(SUPPLIER_ADVANCES), 5000, 0]]));
    expect(e.lines.find((l) => l.accountId === acc(SUPPLIER_ADVANCES))).toMatchObject({ partyType: 'supplier', partyId: SUPPLIER });
  });

  it('es idempotente: el mismo pago dos veces deja UN asiento', async () => {
    const ev = paymentEvent();
    await posting.handle('treasury.payment.posted', ev);
    expect((await posting.handle('treasury.payment.posted', ev)).outcome).toBe('duplicate');
    expect(entries()).toHaveLength(1);
  });

  it('un pago anterior a la fecha de arranque se ignora; el del día de arranque se asienta', async () => {
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPostingFrom: '2026-10-21' });
    expect((await posting.handle('treasury.payment.posted', paymentEvent({ paymentDate: '2026-10-20' }))).outcome).toBe('ignored');
    expect((await posting.handle('treasury.payment.posted', paymentEvent({ paymentDate: '2026-10-21' }))).outcome).toBe('posted');
  });

  it('si falta la cuenta de un rol, queda PENDIENTE (MISSING_ROLE) con motivo legible y no se pierde', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc(BANK), systemRole: null });
    const res = await posting.handle('treasury.payment.posted', paymentEvent());
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'MISSING_ROLE' });
    expect(entries()).toHaveLength(0);
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(1);
  });

  it('contabilización automática apagada, moneda distinta o evento descuadrado: pendiente con su motivo', async () => {
    expect(await posting.handle('treasury.payment.posted', paymentEvent({ currencyCode: 'EUR' }))).toMatchObject({ outcome: 'pending', reasonCode: 'CURRENCY_MISMATCH' });
    expect(await posting.handle('treasury.payment.posted', paymentEvent({ appliedCents: 1 }))).toMatchObject({ outcome: 'pending', reasonCode: 'UNBALANCED_SOURCE' });
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPosting: false });
    expect(await posting.handle('treasury.payment.posted', paymentEvent())).toMatchObject({ outcome: 'pending', reasonCode: 'AUTO_POSTING_OFF' });
  });

  it('una organización sin contabilidad se ignora', async () => {
    expect((await posting.handle('treasury.payment.posted', paymentEvent({ organizationId: '12345678-1234-4234-8234-123456789012' }))).outcome).toBe('ignored');
  });
});

describe('treasury.payment.voided → reversa del asiento', () => {
  const voided = (ev: { paymentId: string; number: string }, over: Record<string, unknown> = {}) => ({
    organizationId: ORG_A, paymentId: ev.paymentId, number: ev.number, reason: 'La transferencia fue rechazada', voidedAt: '2026-10-22T15:00:00.000Z', ...over,
  });

  it('reversa el asiento (el inverso línea por línea), marca el original y cita el motivo', async () => {
    const ev = paymentEvent();
    await posting.handle('treasury.payment.posted', ev);
    expect((await posting.handle('treasury.payment.voided', voided(ev))).outcome).toBe('posted');
    const original = entries().find((e) => e.kind === 'automatic')!;
    const reversal = entries().find((e) => e.kind === 'reversal')!;
    expect(original.reversedByEntryId).toBe(reversal.id);
    expect(reversal.lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual(original.lines.map((l) => [l.accountId, l.creditCents, l.debitCents]));
    expect(reversal.description).toContain('PG-2026-000001');
    expect(reversal.description).toContain('La transferencia fue rechazada');
    expect(reversal.entryDate).toBe('2026-10-22');
  });

  it('el saldo de proveedores y de bancos vuelve a cero después de pagar y anular', async () => {
    const ev = paymentEvent();
    await posting.handle('treasury.payment.posted', ev);
    await posting.handle('treasury.payment.voided', voided(ev));
    const sum = (code: string) => entries().flatMap((e) => e.lines).filter((l) => l.accountId === acc(code)).reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    expect(sum(BANK)).toBe(0);
    expect(sum(PAYABLES)).toBe(0);
  });

  it('anularlo dos veces no reversa dos veces', async () => {
    const ev = paymentEvent();
    await posting.handle('treasury.payment.posted', ev);
    await posting.handle('treasury.payment.voided', voided(ev));
    expect((await posting.handle('treasury.payment.voided', voided(ev))).outcome).toBe('duplicate');
    expect(entries().filter((e) => e.kind === 'reversal')).toHaveLength(1);
  });

  it('si el pago aún estaba pendiente (sin asiento), la anulación descarta el pendiente', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc(PAYABLES), systemRole: null });
    const ev = paymentEvent();
    await posting.handle('treasury.payment.posted', ev);
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(1);
    expect((await posting.handle('treasury.payment.voided', voided(ev))).outcome).toBe('ignored');
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(0);
    expect(entries()).toHaveLength(0);
  });

  it('una anulación que llega ANTES que el pago queda pendiente (ORIGINAL_NOT_POSTED) y se reversa sola al contabilizarse el pago', async () => {
    const ev = paymentEvent();
    expect(await posting.handle('treasury.payment.voided', voided(ev))).toMatchObject({ outcome: 'pending', reasonCode: 'ORIGINAL_NOT_POSTED' });
    await posting.handle('treasury.payment.posted', ev);
    expect(entries().find((e) => e.kind === 'reversal')).toBeTruthy();
    expect(entries().find((e) => e.kind === 'automatic')!.reversedByEntryId).toBeTruthy();
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(0);
  });

  it('una anulación sin pago se ignora', async () => {
    expect((await posting.handle('treasury.payment.voided', { organizationId: ORG_A })).outcome).toBe('ignored');
  });
});

describe('convivencia con la factura de compra', () => {
  it('factura de compra + pago: Proveedores queda en cero por proveedor, y Bancos entrega el dinero', async () => {
    const billId = uuid();
    await posting.handle('purchasing.bill.posted', {
      organizationId: ORG_A, billId, internalNumber: 'FC-2026-000001', supplierId: SUPPLIER, supplier: { identification: '1790011111001', legalName: 'PROVEEDOR UNO S.A.' }, docType: '01',
      supplierDocument: '001-001-000000123', issueDate: '2026-10-20', dueDate: '2026-11-20', currencyCode: 'USD', subtotalCents: 10000, taxCents: 1500, totalCents: 11500, matchStatus: 'not_applicable',
      lines: [{ kind: 'expense', subtotalCents: 10000, vatCents: 1500, iceCents: 0, irbpnrCents: 0, priceVarianceCents: 0 }],
    });
    await posting.handle('treasury.payment.posted', paymentEvent());
    const lines = entries().flatMap((e) => e.lines);
    const payable = lines.filter((l) => l.accountId === acc(PAYABLES) && l.partyId === SUPPLIER).reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    expect(payable).toBe(0);
    expect(lines.filter((l) => l.accountId === acc(BANK)).reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(-11500);
  });
});
