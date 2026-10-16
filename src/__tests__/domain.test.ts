import { describe, expect, it } from 'vitest';
import { Account, CostCenter, normalSide } from '../domain/account.js';
import { EC_SUPERCIAS_TEMPLATE } from '../domain/chart-template.js';
import { buildLines, formatEntryNumber, JournalEntry } from '../domain/journal.js';
import { generatePeriods, isLocalDate } from '../domain/period.js';
import { buildTrialBalance, compareCodes } from '../domain/reports.js';
import { ORG_A, USER } from './helpers.js';

const A = '44444444-4444-4444-8444-444444444441';
const B = '44444444-4444-4444-8444-444444444442';

describe('plan de cuentas', () => {
  it('un hijo debe empezar por el código del padre y ser de su mismo tipo', () => {
    const root = Account.create({ organizationId: ORG_A, code: '1', name: 'ACTIVO', type: 'asset', parent: null, isPostable: false });
    expect(Account.create({ organizationId: ORG_A, code: '1.1', name: 'Corriente', type: 'asset', parent: root }).level).toBe(2);
    expect(() => Account.create({ organizationId: ORG_A, code: '2.1', name: 'X', type: 'asset', parent: root })).toThrow();
    expect(() => Account.create({ organizationId: ORG_A, code: '1.1', name: 'X', type: 'liability', parent: root })).toThrow();
    expect(() => Account.create({ organizationId: ORG_A, code: '1.1', name: 'X', type: 'asset', parent: null })).toThrow();
  });

  it('rechaza códigos mal formados y roles en cuentas de agrupación', () => {
    for (const code of ['', 'a', '1..2', '1.', '1.a']) {
      expect(() => Account.create({ organizationId: ORG_A, code, name: 'X', type: 'asset', parent: null })).toThrow();
    }
    expect(() => Account.create({ organizationId: ORG_A, code: '9', name: 'X', type: 'asset', parent: null, isPostable: false, systemRole: 'cash' })).toThrow();
  });

  it('los activos, costos y gastos aumentan por el debe; el resto por el haber', () => {
    expect(['asset', 'cost', 'expense'].map((t) => normalSide(t as never))).toEqual(['debit', 'debit', 'debit']);
    expect(['liability', 'equity', 'income'].map((t) => normalSide(t as never))).toEqual(['credit', 'credit', 'credit']);
  });

  it('la plantilla es coherente: padres definidos antes que hijos, sin códigos repetidos y un rol por cuenta', () => {
    const seen = new Set<string>();
    const roles = new Set<string>();
    for (const t of EC_SUPERCIAS_TEMPLATE) {
      expect(seen.has(t.code), `código repetido ${t.code}`).toBe(false);
      if (t.code.includes('.')) expect(seen.has(t.code.slice(0, t.code.lastIndexOf('.'))), `falta el padre de ${t.code}`).toBe(true);
      seen.add(t.code);
      if (t.role) {
        expect(roles.has(t.role), `rol repetido ${t.role}`).toBe(false);
        roles.add(t.role);
        expect(EC_SUPERCIAS_TEMPLATE.some((o) => o.code.startsWith(`${t.code}.`)), `${t.code} tiene rol pero es de agrupación`).toBe(false);
      }
    }
  });

  it('centro de costo: código en mayúsculas y validado', () => {
    expect(CostCenter.create({ organizationId: ORG_A, code: 'ventas-1', name: 'Ventas' }).code).toBe('VENTAS-1');
    expect(() => CostCenter.create({ organizationId: ORG_A, code: 'a b', name: 'X' })).toThrow();
  });
});

describe('periodos', () => {
  it('genera doce meses, con febrero bisiesto', () => {
    const p = generatePeriods(2028);
    expect(p).toHaveLength(12);
    expect(p[1]).toMatchObject({ startDate: '2028-02-01', endDate: '2028-02-29' });
    expect(p[11]).toMatchObject({ startDate: '2028-12-01', endDate: '2028-12-31' });
  });

  it('un ejercicio de julio a junio cruza el año', () => {
    const p = generatePeriods(2026, 7);
    expect(p[0]!.startDate).toBe('2026-07-01');
    expect(p[11]!.endDate).toBe('2027-06-30');
  });

  it('valida fechas reales', () => {
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-1-1')).toBe(false);
  });
});

describe('asientos: partida doble', () => {
  it('un asiento que no cuadra no se crea', () => {
    expect(() => buildLines([{ accountId: A, debitCents: 100 }, { accountId: B, creditCents: 99 }])).toThrow(/no cuadra/);
  });

  it('cada línea lleva el importe en un solo lado', () => {
    expect(() => buildLines([{ accountId: A, debitCents: 100, creditCents: 100 }, { accountId: B, creditCents: 0 }])).toThrow();
    expect(() => buildLines([{ accountId: A }, { accountId: B, creditCents: 100 }])).toThrow();
  });

  it('necesita dos líneas, enteros no negativos y un importe distinto de cero', () => {
    expect(() => buildLines([{ accountId: A, debitCents: 100 }])).toThrow();
    expect(() => buildLines([{ accountId: A, debitCents: 10.5 }, { accountId: B, creditCents: 10.5 }])).toThrow();
    expect(() => buildLines([{ accountId: A, debitCents: -5 }, { accountId: B, creditCents: -5 }])).toThrow();
  });

  it('una línea en otra moneda necesita importe original y tipo de cambio coherentes', () => {
    const ok = buildLines([
      { accountId: A, debitCents: 920, currencyCode: 'EUR', amountFcCents: 1000, exchangeRate: 0.92 },
      { accountId: B, creditCents: 920 },
    ]);
    expect(ok[0]!.currencyCode).toBe('EUR');
    expect(() =>
      buildLines([{ accountId: A, debitCents: 500, currencyCode: 'EUR', amountFcCents: 1000, exchangeRate: 0.92 }, { accountId: B, creditCents: 500 }]),
    ).toThrow();
    expect(() => buildLines([{ accountId: A, debitCents: 920, currencyCode: 'EUR' }, { accountId: B, creditCents: 920 }])).toThrow();
  });

  it('el tercero lleva tipo e identificador juntos', () => {
    expect(() => buildLines([{ accountId: A, debitCents: 1, partyType: 'customer' }, { accountId: B, creditCents: 1 }])).toThrow();
  });

  it('el número visible tiene el ejercicio y seis cifras', () => {
    expect(formatEntryNumber(2026, 42)).toBe('AS-2026-000042');
  });

  it('un borrador se puede cambiar; uno contabilizado no', () => {
    const entry = JournalEntry.create({
      organizationId: ORG_A, entryDate: '2026-03-01', description: 'Aporte', currencyCode: 'USD', createdBy: USER,
      lines: [{ accountId: A, debitCents: 100 }, { accountId: B, creditCents: 100 }],
    });
    entry.replaceDraft({ entryDate: '2026-03-02', description: 'Aporte 2', lines: [{ accountId: A, debitCents: 50 }, { accountId: B, creditCents: 50 }] });
    expect(entry.totalDebitCents).toBe(50);
    entry.post({ number: 1, fiscalYear: 2026, periodId: 'p', userId: USER, now: new Date() });
    expect(() => entry.replaceDraft({ entryDate: '2026-03-02', description: 'x', lines: [{ accountId: A, debitCents: 1 }, { accountId: B, creditCents: 1 }] })).toThrow(/borrador/);
    expect(() => entry.post({ number: 2, fiscalYear: 2026, periodId: 'p', userId: USER, now: new Date() })).toThrow();
  });

  it('la reversa invierte debe y haber y no se puede reversar dos veces ni reversar una reversa', () => {
    const original = JournalEntry.create({
      organizationId: ORG_A, entryDate: '2026-03-01', description: 'Venta', currencyCode: 'USD', createdBy: USER,
      lines: [{ accountId: A, debitCents: 115 }, { accountId: B, creditCents: 115 }],
    });
    expect(() => JournalEntry.reversalOf(original, { entryDate: '2026-03-01', reason: 'error', createdBy: USER })).toThrow(/contabilizado/);
    original.post({ number: 1, fiscalYear: 2026, periodId: 'p', userId: USER, now: new Date() });
    const reversal = JournalEntry.reversalOf(original, { entryDate: '2026-03-02', reason: 'error de digitación', createdBy: USER });
    expect(reversal.lines[0]).toMatchObject({ accountId: A, debitCents: 0, creditCents: 115 });
    expect(reversal.lines[1]).toMatchObject({ accountId: B, debitCents: 115, creditCents: 0 });
    reversal.post({ number: 2, fiscalYear: 2026, periodId: 'p', userId: USER, now: new Date() });
    original.markReversed(reversal.id);
    expect(() => JournalEntry.reversalOf(original, { entryDate: '2026-03-02', reason: 'otra vez', createdBy: USER })).toThrow(/ya fue reversado/);
    expect(() => JournalEntry.reversalOf(reversal, { entryDate: '2026-03-02', reason: 'x', createdBy: USER })).toThrow(/reversa/);
  });
});

describe('balance de comprobación', () => {
  const root = Account.create({ organizationId: ORG_A, code: '1', name: 'ACTIVO', type: 'asset', parent: null, isPostable: false });
  const cash = Account.create({ organizationId: ORG_A, code: '1.1', name: 'Caja', type: 'asset', parent: root });
  const incomeRoot = Account.create({ organizationId: ORG_A, code: '4', name: 'INGRESOS', type: 'income', parent: null, isPostable: false });
  const sales = Account.create({ organizationId: ORG_A, code: '4.1', name: 'Ventas', type: 'income', parent: incomeRoot });

  it('suma las cuentas de detalle en las de agrupación', () => {
    const tb = buildTrialBalance({
      accounts: [root, cash, incomeRoot, sales],
      sums: [
        { accountId: cash.id, netBeforeFrom: 0, netBeforeYearStart: 0, debit: 500, credit: 100 },
        { accountId: sales.id, netBeforeFrom: 0, netBeforeYearStart: 0, debit: 0, credit: 400 },
      ],
      from: '2026-01-01', to: '2026-01-31', includeZero: false,
    });
    const rootRow = tb.rows.find((r) => r.code === '1')!;
    expect(rootRow).toMatchObject({ debitCents: 500, creditCents: 100, closingCents: 400 });
    expect(tb.totals).toMatchObject({ debitCents: 500, creditCents: 500, openingCents: 0, closingCents: 0 });
  });

  it('las cuentas de resultados empiezan en cero cada ejercicio y lo anterior va en una fila aparte', () => {
    const tb = buildTrialBalance({
      accounts: [root, cash, incomeRoot, sales],
      sums: [
        // El año pasado se vendió 1000 al contado y todavía no hay asiento de cierre.
        { accountId: cash.id, netBeforeFrom: 1000, netBeforeYearStart: 1000, debit: 0, credit: 0 },
        { accountId: sales.id, netBeforeFrom: -1000, netBeforeYearStart: -1000, debit: 0, credit: 0 },
      ],
      from: '2027-01-01', to: '2027-01-31', includeZero: false,
    });
    const salesRow = tb.rows.find((r) => r.code === '4.1');
    expect(salesRow).toBeUndefined();
    const carry = tb.rows.find((r) => r.synthetic)!;
    expect(carry.openingCents).toBe(-1000);
    expect(tb.totals.openingCents).toBe(0);
    expect(tb.totals.closingCents).toBe(0);
  });

  it('ordena los códigos de forma natural', () => {
    expect(['1.10', '1.2', '1', '1.1'].sort(compareCodes)).toEqual(['1', '1.1', '1.2', '1.10']);
  });
});
