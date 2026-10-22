import { beforeEach, describe, expect, it } from 'vitest';
import { draftFromBankAdjustmentPosted, type RuleContext } from '../domain/posting.js';
import { InMemoryStore, ORG_A, buildPosting, setupOrg } from './helpers.js';

/**
 * Asiento del ajuste bancario (tesorería, Fase 3 bloque E): `treasury.bank_adjustment.posted` y su anulación `treasury.bank_adjustment.voided`.
 * Egreso (comisión): Dr Otros gastos / Cr Bancos. Ingreso (interés): Dr Bancos / Cr Otros ingresos.
 */
let n = 0;
const uuid = () => `cccccccc-cccc-4ccc-8ccc-${String((n += 1)).padStart(12, '0')}`;

const adjustmentEvent = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG_A,
  adjustmentId: uuid(),
  bankAccountId: uuid(),
  bankAccountName: 'Pichincha',
  kind: 'bank_fee',
  direction: 'out',
  amountCents: 250,
  currencyCode: 'USD',
  adjustmentDate: '2026-10-21',
  description: 'Comisión de mantenimiento',
  reference: null,
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
const BANK = '1.1.01.02';
const OTHER_EXPENSE = '5.2.99';
const OTHER_INCOME = '4.2.03';

describe('regla pura: draftFromBankAdjustmentPosted', () => {
  it('egreso: Dr otros gastos / Cr bancos', () => {
    const r = draftFromBankAdjustmentPosted(adjustmentEvent() as never, ctx);
    if (r.kind !== 'draft') throw new Error('debía ser un asiento');
    expect(r.lines).toEqual([
      { role: 'other_expense', debitCents: 250, creditCents: 0, establishmentId: null },
      { role: 'bank', debitCents: 0, creditCents: 250, establishmentId: null },
    ]);
    expect(r).toMatchObject({ entryDate: '2026-10-21', sourceType: 'bank_adjustment', currencyCode: 'USD' });
    expect(r.description).toBe('Ajuste bancario (Pichincha) — Comisión de mantenimiento');
  });

  it('ingreso: Dr bancos / Cr otros ingresos', () => {
    const r = draftFromBankAdjustmentPosted(adjustmentEvent({ kind: 'interest', direction: 'in', amountCents: 120 }) as never, ctx);
    if (r.kind !== 'draft') throw new Error('debía ser un asiento');
    expect(r.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([['bank', 120, 0], ['other_income', 0, 120]]);
  });

  it('sin importe se ignora; moneda distinta o un sentido que no es entrada ni salida quedan bloqueados', () => {
    expect(draftFromBankAdjustmentPosted(adjustmentEvent({ amountCents: 0 }) as never, ctx)).toMatchObject({ kind: 'skip' });
    expect(draftFromBankAdjustmentPosted(adjustmentEvent({ currencyCode: 'EUR' }) as never, ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'CURRENCY_MISMATCH' });
    expect(draftFromBankAdjustmentPosted(adjustmentEvent({ direction: 'sideways' }) as never, ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'UNBALANCED_SOURCE' });
  });

  it('la fecha sin hora NO se corre un día (en Guayaquil saldría el anterior)', () => {
    for (const date of ['2026-10-21', '2026-11-01', '2027-01-01']) {
      const r = draftFromBankAdjustmentPosted(adjustmentEvent({ adjustmentDate: date }) as never, ctx);
      expect(r.kind === 'draft' && r.entryDate).toBe(date);
    }
  });
});

describe('treasury.bank_adjustment.posted → asiento contabilizado', () => {
  it('Dr Otros gastos / Cr Bancos, idempotente por ajuste', async () => {
    const ev = adjustmentEvent();
    expect((await posting.handle('treasury.bank_adjustment.posted', ev)).outcome).toBe('posted');
    expect((await posting.handle('treasury.bank_adjustment.posted', ev)).outcome).toBe('duplicate');
    const [e] = entries();
    expect(entries()).toHaveLength(1);
    expect(e).toMatchObject({ kind: 'automatic', status: 'posted', sourceType: 'bank_adjustment', sourceId: ev.adjustmentId, entryDate: '2026-10-21', totalDebitCents: 250, totalCreditCents: 250 });
    expect(shape(e!)).toEqual(expect.arrayContaining([[acc(OTHER_EXPENSE), 250, 0], [acc(BANK), 0, 250]]));
  });

  it('el interés entra a Bancos y se reconoce como otros ingresos', async () => {
    await posting.handle('treasury.bank_adjustment.posted', adjustmentEvent({ kind: 'interest', direction: 'in', amountCents: 120 }));
    expect(shape(entries()[0]!)).toEqual(expect.arrayContaining([[acc(BANK), 120, 0], [acc(OTHER_INCOME), 0, 120]]));
  });

  it('anterior a la fecha de arranque se ignora; sin cuenta del rol, queda pendiente con su motivo', async () => {
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPostingFrom: '2026-10-22' });
    expect((await posting.handle('treasury.bank_adjustment.posted', adjustmentEvent())).outcome).toBe('ignored');
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPostingFrom: null });
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc(OTHER_EXPENSE), systemRole: null });
    expect(await posting.handle('treasury.bank_adjustment.posted', adjustmentEvent())).toMatchObject({ outcome: 'pending', reasonCode: 'MISSING_ROLE' });
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(1);
  });
});

describe('treasury.bank_adjustment.voided → reversa del asiento', () => {
  const voided = (ev: { adjustmentId: string }, over: Record<string, unknown> = {}) => ({ organizationId: ORG_A, adjustmentId: ev.adjustmentId, reason: 'Se cargó por error', adjustmentDate: '2026-10-21', ...over });

  it('reversa el asiento (el inverso línea por línea), lo marca y cita el motivo', async () => {
    const ev = adjustmentEvent();
    await posting.handle('treasury.bank_adjustment.posted', ev);
    expect((await posting.handle('treasury.bank_adjustment.voided', voided(ev))).outcome).toBe('posted');
    const original = entries().find((e) => e.kind === 'automatic')!;
    const reversal = entries().find((e) => e.kind === 'reversal')!;
    expect(original.reversedByEntryId).toBe(reversal.id);
    expect(reversal.lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual(original.lines.map((l) => [l.accountId, l.creditCents, l.debitCents]));
    expect(reversal.description).toContain('Se cargó por error');
    const net = (code: string) => entries().flatMap((e) => e.lines).filter((l) => l.accountId === acc(code)).reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    expect(net(BANK)).toBe(0);
    expect(net(OTHER_EXPENSE)).toBe(0);
  });

  it('anularlo dos veces no reversa dos veces', async () => {
    const ev = adjustmentEvent();
    await posting.handle('treasury.bank_adjustment.posted', ev);
    await posting.handle('treasury.bank_adjustment.voided', voided(ev));
    expect((await posting.handle('treasury.bank_adjustment.voided', voided(ev))).outcome).toBe('duplicate');
    expect(entries().filter((e) => e.kind === 'reversal')).toHaveLength(1);
  });

  it('si el ajuste aún estaba pendiente, la anulación descarta el pendiente', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc(OTHER_EXPENSE), systemRole: null });
    const ev = adjustmentEvent();
    await posting.handle('treasury.bank_adjustment.posted', ev);
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(1);
    expect((await posting.handle('treasury.bank_adjustment.voided', voided(ev))).outcome).toBe('ignored');
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(0);
    expect(entries()).toHaveLength(0);
  });

  it('una anulación que llega ANTES queda pendiente (ORIGINAL_NOT_POSTED) y se reversa sola al contabilizarse el ajuste', async () => {
    const ev = adjustmentEvent();
    expect(await posting.handle('treasury.bank_adjustment.voided', voided(ev))).toMatchObject({ outcome: 'pending', reasonCode: 'ORIGINAL_NOT_POSTED' });
    await posting.handle('treasury.bank_adjustment.posted', ev);
    expect(entries().find((e) => e.kind === 'reversal')).toBeTruthy();
    expect(entries().find((e) => e.kind === 'automatic')!.reversedByEntryId).toBeTruthy();
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(0);
  });

  it('una anulación sin ajuste se ignora', async () => {
    expect((await posting.handle('treasury.bank_adjustment.voided', { organizationId: ORG_A })).outcome).toBe('ignored');
  });
});
