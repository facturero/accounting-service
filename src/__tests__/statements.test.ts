import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore, ORG_A, USER, setupOrg, buildApp, headers } from './helpers.js';

let store: InMemoryStore;
let env: Awaited<ReturnType<typeof setupOrg>>;

beforeEach(async () => {
  store = new InMemoryStore();
  env = await setupOrg(store);
  await env.uc.createFiscalYear.execute({ organizationId: ORG_A, year: 2027 });
});

/** Un asiento contabilizado entre dos cuentas por código. */
async function post(date: string, debitCode: string, creditCode: string, cents: number, extra: { costCenterId?: string } = {}) {
  await env.uc.createEntry.execute({
    organizationId: ORG_A, userId: USER, entryDate: date, description: `${debitCode} / ${creditCode}`, post: true,
    lines: [
      { accountId: env.byCode(debitCode).id, debitCents: cents, costCenterId: extra.costCenterId },
      { accountId: env.byCode(creditCode).id, creditCents: cents, costCenterId: extra.costCenterId },
    ],
  });
}

/** Ejercicio 2026: aporte, compra de inventario, venta con IVA, costo de ventas, arriendo. Ejercicio 2027: otra venta. */
async function scenario() {
  await post('2026-01-05', '1.1.01.02', '3.1.01', 100_000); // aporte de capital a bancos
  await post('2026-02-01', '1.1.03.01', '1.1.01.02', 20_000); // compra de inventario pagada
  await env.uc.createEntry.execute({
    organizationId: ORG_A, userId: USER, entryDate: '2026-03-10', description: 'Venta de contado', post: true,
    lines: [
      { accountId: env.byCode('1.1.01.01').id, debitCents: 11_500 },
      { accountId: env.byCode('4.1.01').id, creditCents: 10_000 },
      { accountId: env.byCode('2.1.03.01').id, creditCents: 1_500 },
    ],
  });
  await post('2026-03-10', '5.1.01', '1.1.03.01', 6_000); // costo de lo vendido
  await post('2026-04-01', '5.2.02', '1.1.01.01', 2_000); // arriendo
  await post('2027-02-15', '1.1.01.01', '4.1.01', 5_000); // venta del año siguiente
}

const row = (rows: { code: string }[], code: string) => rows.find((r) => r.code === code) as { code: string; amountCents: number; compareAmountCents: number | null } | undefined;
const sect = <T extends { key: string }>(sections: T[], key: string) => sections.find((s) => s.key === key)!;

describe('balance general', () => {
  it('activo = pasivo + patrimonio (con el resultado del ejercicio dentro del patrimonio)', async () => {
    await scenario();
    const bs = await env.uc.balanceSheet.execute({ organizationId: ORG_A, asOf: '2026-12-31' });
    // Bancos 80.000 + Caja 9.500 + Inventario 14.000
    expect(bs.totals.assetsCents).toBe(103_500);
    // IVA por pagar 1.500; capital 100.000; resultado 10.000 - 6.000 - 2.000 = 2.000
    expect(sect(bs.sections, 'liabilities').totalCents).toBe(1_500);
    expect(sect(bs.sections, 'equity').totalCents).toBe(102_000);
    expect(bs.totals.liabilitiesAndEquityCents).toBe(103_500);
    expect(bs.totals.differenceCents).toBe(0);
    const equity = sect(bs.sections, 'equity').rows;
    expect(equity.find((r) => r.synthetic && r.name === 'Resultado del ejercicio')!.amountCents).toBe(2_000);
    expect(equity.find((r) => r.synthetic && r.name.startsWith('Resultados de ejercicios anteriores'))).toBeUndefined();
  });

  it('el año siguiente separa el resultado anterior sin cerrar del del ejercicio, y sigue cuadrando', async () => {
    await scenario();
    const bs = await env.uc.balanceSheet.execute({ organizationId: ORG_A, asOf: '2027-12-31' });
    expect(bs.totals).toMatchObject({ assetsCents: 108_500, liabilitiesAndEquityCents: 108_500, differenceCents: 0 });
    const equity = sect(bs.sections, 'equity').rows;
    expect(equity.find((r) => r.name.startsWith('Resultados de ejercicios anteriores'))!.amountCents).toBe(2_000);
    expect(equity.find((r) => r.name === 'Resultado del ejercicio')!.amountCents).toBe(5_000);
  });

  it('las cuentas de agrupación suman a sus hijas y se pueden ocultar niveles sin cambiar los totales', async () => {
    await scenario();
    const full = await env.uc.balanceSheet.execute({ organizationId: ORG_A, asOf: '2026-12-31' });
    const assets = sect(full.sections, 'assets').rows;
    expect(row(assets, '1')!.amountCents).toBe(103_500);
    expect(row(assets, '1.1.01')!.amountCents).toBe(89_500);
    expect(row(assets, '1.1.01.02')!.amountCents).toBe(80_000);
    const shallow = await env.uc.balanceSheet.execute({ organizationId: ORG_A, asOf: '2026-12-31', maxLevel: 2 });
    expect(Math.max(...sect(shallow.sections, 'assets').rows.map((r) => (r as unknown as { level: number }).level))).toBe(2);
    expect(shallow.totals).toEqual(full.totals);
  });

  it('una cuenta regularizadora (depreciación acumulada) resta del activo', async () => {
    await scenario();
    await post('2026-06-30', '5.2.06', '1.2.01.07', 300);
    const bs = await env.uc.balanceSheet.execute({ organizationId: ORG_A, asOf: '2026-12-31' });
    expect(row(sect(bs.sections, 'assets').rows, '1.2.01.07')!.amountCents).toBe(-300);
    expect(bs.totals.differenceCents).toBe(0);
  });

  it('compara contra otra fecha, y la comparación también cuadra', async () => {
    await scenario();
    const bs = await env.uc.balanceSheet.execute({ organizationId: ORG_A, asOf: '2027-12-31', compareAsOf: '2026-12-31' });
    expect(bs.compareAsOf).toBe('2026-12-31');
    expect(row(sect(bs.sections, 'assets').rows, '1.1.01.01')).toMatchObject({ amountCents: 14_500, compareAmountCents: 9_500 });
    expect(bs.totals).toMatchObject({ compareAssetsCents: 103_500, compareLiabilitiesAndEquityCents: 103_500, compareDifferenceCents: 0 });
  });

  it('a una fecha sin movimientos todo es cero, y a mitad de año el resultado es el del ejercicio hasta esa fecha', async () => {
    await scenario();
    const empty = await env.uc.balanceSheet.execute({ organizationId: ORG_A, asOf: '2026-01-04' });
    expect(empty.totals).toMatchObject({ assetsCents: 0, liabilitiesAndEquityCents: 0, differenceCents: 0 });
    const march = await env.uc.balanceSheet.execute({ organizationId: ORG_A, asOf: '2026-03-31' });
    // Todavía sin el arriendo de abril: resultado 10.000 - 6.000 = 4.000.
    expect(sect(march.sections, 'equity').rows.find((r) => r.name === 'Resultado del ejercicio')!.amountCents).toBe(4_000);
    expect(march.totals.differenceCents).toBe(0);
  });

  it('valida las fechas', async () => {
    await expect(env.uc.balanceSheet.execute({ organizationId: ORG_A, asOf: 'ayer' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(env.uc.balanceSheet.execute({ organizationId: ORG_A, asOf: '2026-12-31', compareAsOf: '31/12/2025' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('estado de resultados', () => {
  it('ingresos − costos = utilidad bruta; − gastos = resultado neto', async () => {
    await scenario();
    const is = await env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31' });
    expect(sect(is.sections, 'income').totalCents).toBe(10_000);
    expect(sect(is.sections, 'costs').totalCents).toBe(6_000);
    expect(is.grossProfitCents).toBe(4_000);
    expect(sect(is.sections, 'expenses').totalCents).toBe(2_000);
    expect(is.netResultCents).toBe(2_000);
  });

  it('el costo y el gasto no se mezclan aunque compartan la raíz 5', async () => {
    await scenario();
    const is = await env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31' });
    const costs = sect(is.sections, 'costs').rows;
    const expenses = sect(is.sections, 'expenses').rows;
    expect(row(costs, '5')!.amountCents).toBe(6_000); // solo el costo, no el arriendo
    expect(row(costs, '5.1.01')!.amountCents).toBe(6_000);
    expect(row(expenses, '5')).toBeUndefined();
    expect(row(expenses, '5.2')!.amountCents).toBe(2_000);
    expect(row(expenses, '5.2.02')!.amountCents).toBe(2_000);
  });

  it('un rango solo cuenta lo de ese rango', async () => {
    await scenario();
    const q1 = await env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-03-31' });
    expect(q1.netResultCents).toBe(4_000);
    const y27 = await env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2027-01-01', to: '2027-12-31' });
    expect(y27.netResultCents).toBe(5_000);
  });

  it('compara con otro periodo', async () => {
    await scenario();
    const is = await env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2027-01-01', to: '2027-12-31', compareFrom: '2026-01-01', compareTo: '2026-12-31' });
    expect(row(sect(is.sections, 'income').rows, '4.1.01')).toMatchObject({ amountCents: 5_000, compareAmountCents: 10_000 });
    expect(is).toMatchObject({ netResultCents: 5_000, compareNetResultCents: 2_000, compareGrossProfitCents: 4_000 });
  });

  it('una devolución en ventas resta de los ingresos', async () => {
    await scenario();
    await post('2026-05-01', '4.1.03', '1.1.01.01', 1_000);
    const is = await env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31' });
    expect(row(sect(is.sections, 'income').rows, '4.1.03')!.amountCents).toBe(-1_000);
    expect(sect(is.sections, 'income').totalCents).toBe(9_000);
  });

  it('filtra por centro de costo', async () => {
    const cc = await env.uc.createCostCenter.execute({ organizationId: ORG_A, code: 'norte', name: 'Norte' });
    await post('2026-03-01', '1.1.01.01', '4.1.01', 700, { costCenterId: cc.id });
    await post('2026-03-02', '1.1.01.01', '4.1.01', 300);
    const all = await env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31' });
    const norte = await env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31', costCenterId: cc.id });
    expect(all.netResultCents).toBe(1_000);
    expect(norte.netResultCents).toBe(700);
  });

  it('sin movimientos las secciones salen vacías, y con includeZero salen todas las cuentas', async () => {
    const is = await env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31' });
    expect(is.sections.every((s) => s.rows.length === 0 && s.totalCents === 0)).toBe(true);
    const full = await env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31', includeZero: true });
    expect(sect(full.sections, 'income').rows.length).toBeGreaterThan(5);
  });

  it('valida el rango y exige la comparación completa', async () => {
    await expect(env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2026-12-31', to: '2026-01-01' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(env.uc.incomeStatement.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31', compareFrom: '2025-01-01' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('estados financieros por HTTP', () => {
  it('exigen ledger:read y validan los parámetros', async () => {
    await scenario();
    const app = buildApp(store);
    const call = (path: string, perms?: string[]) => app.request(path, { headers: headers(ORG_A, perms) });
    expect((await call('/accounting/reports/balance-sheet?asOf=2026-12-31', ['account:read'])).status).toBe(403);
    expect((await call('/accounting/reports/income-statement?from=2026-01-01&to=2026-12-31', ['account:read'])).status).toBe(403);
    expect((await call('/accounting/reports/balance-sheet')).status).toBe(422);
    expect((await call('/accounting/reports/income-statement?from=2026-01-01')).status).toBe(422);
    const ok = await call('/accounting/reports/balance-sheet?asOf=2026-12-31&compareAsOf=2025-12-31');
    expect(ok.status).toBe(200);
    expect((await ok.json()).totals.differenceCents).toBe(0);
    const is = await call('/accounting/reports/income-statement?from=2026-01-01&to=2026-12-31');
    expect((await is.json()).netResultCents).toBe(2_000);
  });
});
