import { beforeEach, describe, expect, it } from 'vitest';
import { draftFromReceiptPosted, type RuleContext } from '../domain/posting.js';
import { InMemoryStore, ORG_A, buildPosting, setupOrg } from './helpers.js';

/**
 * Asiento del cobro a un cliente (tesorería, Fase 3 bloque B): `treasury.receipt.posted` y su anulación `treasury.receipt.voided`.
 * La factura NO se asienta otra vez (su asiento lo hizo `billing.invoice.issued`).
 */
const CUSTOMER = '77777777-7777-4777-8777-777777777777';
let n = 0;
const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String((n += 1)).padStart(12, '0')}`;

const receiptEvent = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG_A,
  receiptId: uuid(),
  number: 'RC-2026-000001',
  receiptDate: '2026-10-21',
  customerId: CUSTOMER,
  customerName: 'CLIENTE UNO S.A.',
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
const RECEIVABLES = '1.1.02.01';
const ADVANCES = '2.1.01.03';

describe('regla pura: draftFromReceiptPosted', () => {
  it('cobro a una deuda: Dr banco / Cr cuentas por cobrar con el cliente como tercero', () => {
    const r = draftFromReceiptPosted(receiptEvent() as never, ctx);
    expect(r.kind).toBe('draft');
    if (r.kind !== 'draft') return;
    expect(r.lines).toEqual([
      { role: 'bank', debitCents: 11500, creditCents: 0, establishmentId: null },
      { role: 'receivables', debitCents: 0, creditCents: 11500, establishmentId: null, partyType: 'customer', partyId: CUSTOMER },
    ]);
    expect(r).toMatchObject({ entryDate: '2026-10-21', sourceType: 'receipt', reference: 'RC-2026-000001', currencyCode: 'USD' });
    expect(r.description).toBe('Cobro RC-2026-000001 — CLIENTE UNO S.A.');
  });

  it('el efectivo va a caja', () => {
    const r = draftFromReceiptPosted(receiptEvent({ accountRole: 'cash' }) as never, ctx);
    expect(r.kind === 'draft' && r.lines[0]!.role).toBe('cash');
  });

  it('con excedente: Cr anticipos de clientes por lo que sobra', () => {
    const r = draftFromReceiptPosted(receiptEvent({ totalCents: 15000, appliedCents: 10000, advanceCents: 5000 }) as never, ctx);
    if (r.kind !== 'draft') throw new Error('debía ser un asiento');
    expect(r.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([['bank', 15000, 0], ['receivables', 0, 10000], ['customer_advances', 0, 5000]]);
    expect(r.lines.find((l) => l.role === 'customer_advances')).toMatchObject({ partyType: 'customer', partyId: CUSTOMER });
  });

  it('consumiendo un anticipo: Dr anticipos de clientes, sin dinero nuevo', () => {
    const r = draftFromReceiptPosted(receiptEvent({ totalCents: 0, advanceUsedCents: 4000, appliedCents: 4000 }) as never, ctx);
    if (r.kind !== 'draft') throw new Error('debía ser un asiento');
    expect(r.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([['customer_advances', 4000, 0], ['receivables', 0, 4000]]);
  });

  it('mezcla: dinero nuevo + anticipo consumido + excedente, y el asiento cuadra', () => {
    const r = draftFromReceiptPosted(receiptEvent({ totalCents: 4000, advanceUsedCents: 3000, appliedCents: 5000, advanceCents: 2000 }) as never, ctx);
    if (r.kind !== 'draft') throw new Error('debía ser un asiento');
    expect(r.lines.reduce((s, l) => s + l.debitCents, 0)).toBe(7000);
    expect(r.lines.reduce((s, l) => s + l.creditCents, 0)).toBe(7000);
  });

  it('un cobro sin deudas (todo anticipo) es Dr banco / Cr anticipos de clientes', () => {
    const r = draftFromReceiptPosted(receiptEvent({ totalCents: 8000, appliedCents: 0, advanceCents: 8000 }) as never, ctx);
    if (r.kind !== 'draft') throw new Error('debía ser un asiento');
    expect(r.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([['bank', 8000, 0], ['customer_advances', 0, 8000]]);
  });

  it('un evento que no cuadra queda bloqueado (UNBALANCED_SOURCE), no se asienta mal', () => {
    expect(draftFromReceiptPosted(receiptEvent({ appliedCents: 11000 }) as never, ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'UNBALANCED_SOURCE' });
  });

  it('moneda distinta de la base: CURRENCY_MISMATCH', () => {
    expect(draftFromReceiptPosted(receiptEvent({ currencyCode: 'EUR' }) as never, ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'CURRENCY_MISMATCH' });
  });

  it('sin importe se ignora; un rol que no es caja ni bancos queda bloqueado', () => {
    expect(draftFromReceiptPosted(receiptEvent({ totalCents: 0, appliedCents: 0 }) as never, ctx)).toMatchObject({ kind: 'skip' });
    expect(draftFromReceiptPosted(receiptEvent({ accountRole: 'receivables' }) as never, ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'UNMAPPED_COLLECTION_ROLE' });
  });

  it('la fecha del cobro sin hora NO se corre un día (en Guayaquil saldría el anterior)', () => {
    for (const date of ['2026-10-21', '2026-11-01', '2027-01-01']) {
      const r = draftFromReceiptPosted(receiptEvent({ receiptDate: date }) as never, ctx);
      expect(r.kind === 'draft' && r.entryDate).toBe(date);
    }
  });
});

describe('treasury.receipt.posted → asiento contabilizado', () => {
  it('Dr Bancos / Cr Clientes, con el cliente como tercero, el número y la descripción', async () => {
    const ev = receiptEvent();
    const res = await posting.handle('treasury.receipt.posted', ev);
    expect(res.outcome).toBe('posted');
    const [e] = entries();
    expect(e).toMatchObject({ kind: 'automatic', status: 'posted', sourceType: 'receipt', sourceId: ev.receiptId, entryDate: '2026-10-21', totalDebitCents: 11500, totalCreditCents: 11500 });
    expect(shape(e!)).toEqual(expect.arrayContaining([[acc(BANK), 11500, 0], [acc(RECEIVABLES), 0, 11500]]));
    expect(e!.lines).toHaveLength(2);
    expect(e!.lines.find((l) => l.accountId === acc(RECEIVABLES))).toMatchObject({ partyType: 'customer', partyId: CUSTOMER });
    expect(e!.description).toContain('RC-2026-000001');
  });

  it('el efectivo entra a Caja', async () => {
    await posting.handle('treasury.receipt.posted', receiptEvent({ accountRole: 'cash' }));
    expect(shape(entries()[0]!)).toEqual(expect.arrayContaining([[acc(CASH), 11500, 0]]));
  });

  it('el excedente queda en Anticipos de clientes, también con el cliente como tercero', async () => {
    await posting.handle('treasury.receipt.posted', receiptEvent({ totalCents: 15000, appliedCents: 10000, advanceCents: 5000 }));
    const e = entries()[0]!;
    expect(shape(e)).toEqual(expect.arrayContaining([[acc(BANK), 15000, 0], [acc(RECEIVABLES), 0, 10000], [acc(ADVANCES), 0, 5000]]));
    expect(e.lines.find((l) => l.accountId === acc(ADVANCES))).toMatchObject({ partyType: 'customer', partyId: CUSTOMER });
  });

  it('consumir un anticipo: Dr Anticipos de clientes / Cr Clientes, sin tocar caja ni bancos', async () => {
    await posting.handle('treasury.receipt.posted', receiptEvent({ totalCents: 0, advanceUsedCents: 4000, appliedCents: 4000 }));
    const e = entries()[0]!;
    expect(shape(e)).toEqual([[acc(ADVANCES), 4000, 0], [acc(RECEIVABLES), 0, 4000]]);
  });

  it('es idempotente: el mismo cobro dos veces deja UN asiento', async () => {
    const ev = receiptEvent();
    await posting.handle('treasury.receipt.posted', ev);
    expect((await posting.handle('treasury.receipt.posted', ev)).outcome).toBe('duplicate');
    expect(entries()).toHaveLength(1);
  });

  it('la fecha sin hora no se corre un día: el 1.º de mes no cae en el mes anterior', async () => {
    await posting.handle('treasury.receipt.posted', receiptEvent({ receiptDate: '2026-11-01' }));
    expect(entries()[0]!.entryDate).toBe('2026-11-01');
  });

  it('un cobro anterior a la fecha de arranque de la contabilización se ignora; el del día de arranque se asienta', async () => {
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPostingFrom: '2026-10-21' });
    expect((await posting.handle('treasury.receipt.posted', receiptEvent({ receiptDate: '2026-10-20' }))).outcome).toBe('ignored');
    expect((await posting.handle('treasury.receipt.posted', receiptEvent({ receiptDate: '2026-10-21' }))).outcome).toBe('posted');
  });

  it('si falta la cuenta de un rol, queda PENDIENTE (MISSING_ROLE) y no se inventa una cuenta', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc(ADVANCES), systemRole: null });
    const res = await posting.handle('treasury.receipt.posted', receiptEvent({ totalCents: 15000, appliedCents: 10000, advanceCents: 5000 }));
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'MISSING_ROLE' });
    expect(entries()).toHaveLength(0);
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(1);
  });

  it('contabilización automática apagada: queda pendiente y no se pierde', async () => {
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPosting: false });
    const res = await posting.handle('treasury.receipt.posted', receiptEvent());
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'AUTO_POSTING_OFF' });
  });

  it('moneda distinta o evento descuadrado: pendiente con su motivo', async () => {
    expect(await posting.handle('treasury.receipt.posted', receiptEvent({ currencyCode: 'EUR' }))).toMatchObject({ outcome: 'pending', reasonCode: 'CURRENCY_MISMATCH' });
    expect(await posting.handle('treasury.receipt.posted', receiptEvent({ appliedCents: 1 }))).toMatchObject({ outcome: 'pending', reasonCode: 'UNBALANCED_SOURCE' });
  });

  it('una organización sin contabilidad se ignora', async () => {
    const res = await posting.handle('treasury.receipt.posted', receiptEvent({ organizationId: '12345678-1234-4234-8234-123456789012' }));
    expect(res.outcome).toBe('ignored');
  });
});

describe('treasury.receipt.voided → reversa del asiento', () => {
  const voided = (ev: { receiptId: string; number: string }, over: Record<string, unknown> = {}) => ({
    organizationId: ORG_A, receiptId: ev.receiptId, number: ev.number, reason: 'La transferencia fue rechazada', voidedAt: '2026-10-22T15:00:00.000Z', ...over,
  });

  it('reversa el asiento (el inverso línea por línea), marca el original y cita el motivo', async () => {
    const ev = receiptEvent();
    await posting.handle('treasury.receipt.posted', ev);
    const res = await posting.handle('treasury.receipt.voided', voided(ev));
    expect(res.outcome).toBe('posted');
    const original = entries().find((e) => e.kind === 'automatic')!;
    const reversal = entries().find((e) => e.kind === 'reversal')!;
    expect(original.reversedByEntryId).toBe(reversal.id);
    expect(reversal.lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual(original.lines.map((l) => [l.accountId, l.creditCents, l.debitCents]));
    expect(reversal.description).toContain('RC-2026-000001');
    expect(reversal.description).toContain('La transferencia fue rechazada');
    expect(reversal.entryDate).toBe('2026-10-22');
  });

  it('el saldo de clientes y de bancos vuelve a cero después de cobrar y anular', async () => {
    const ev = receiptEvent();
    await posting.handle('treasury.receipt.posted', ev);
    await posting.handle('treasury.receipt.voided', voided(ev));
    const sum = (code: string) => entries().flatMap((e) => e.lines).filter((l) => l.accountId === acc(code)).reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    expect(sum(BANK)).toBe(0);
    expect(sum(RECEIVABLES)).toBe(0);
  });

  it('anularlo dos veces no reversa dos veces', async () => {
    const ev = receiptEvent();
    await posting.handle('treasury.receipt.posted', ev);
    await posting.handle('treasury.receipt.voided', voided(ev));
    expect((await posting.handle('treasury.receipt.voided', voided(ev))).outcome).toBe('duplicate');
    expect(entries().filter((e) => e.kind === 'reversal')).toHaveLength(1);
  });

  it('si el cobro aún estaba pendiente (sin asiento), la anulación descarta el pendiente', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc(RECEIVABLES), systemRole: null });
    const ev = receiptEvent();
    await posting.handle('treasury.receipt.posted', ev);
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(1);
    const res = await posting.handle('treasury.receipt.voided', voided(ev));
    expect(res.outcome).toBe('ignored');
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(0);
    expect(entries()).toHaveLength(0);
  });

  it('una anulación que llega ANTES que el cobro queda pendiente (ORIGINAL_NOT_POSTED) y se reversa sola al contabilizarse el cobro', async () => {
    const ev = receiptEvent();
    expect(await posting.handle('treasury.receipt.voided', voided(ev))).toMatchObject({ outcome: 'pending', reasonCode: 'ORIGINAL_NOT_POSTED' });
    await posting.handle('treasury.receipt.posted', ev);
    expect(entries().find((e) => e.kind === 'reversal')).toBeTruthy();
    expect(entries().find((e) => e.kind === 'automatic')!.reversedByEntryId).toBeTruthy();
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(0);
  });

  it('una anulación sin cobro se ignora', async () => {
    expect((await posting.handle('treasury.receipt.voided', { organizationId: ORG_A })).outcome).toBe('ignored');
  });
});

describe('convivencia con la factura y con la nota de crédito', () => {
  it('factura a crédito + cobro: Clientes queda en cero por cliente, y Bancos recibe el dinero', async () => {
    const invoiceId = uuid();
    await posting.handle('billing.invoice.issued', {
      organizationId: ORG_A, invoiceId, number: '001-001-000000010', issueDate: '2026-10-20T15:00:00.000Z', documentTypeCode: '01', currencyCode: 'USD', totalCents: 11500,
      customerSnapshot: { id: CUSTOMER, businessName: 'CLIENTE UNO S.A.' }, lines: [{ subtotalCents: 10000, taxes: [{ kind: 'vat', amountCents: 1500 }] }],
    });
    await posting.handle('treasury.receipt.posted', receiptEvent());
    const lines = entries().flatMap((e) => e.lines);
    const receivable = lines.filter((l) => l.accountId === acc(RECEIVABLES) && l.partyId === CUSTOMER).reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    expect(receivable).toBe(0);
    expect(lines.filter((l) => l.accountId === acc(BANK)).reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(11500);
  });
});
