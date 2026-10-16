import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore, ORG_A, ORG_B, USER, buildUseCases, setupOrg } from './helpers.js';

let store: InMemoryStore;
beforeEach(() => {
  store = new InMemoryStore();
});

async function sale(env: Awaited<ReturnType<typeof setupOrg>>, date: string, cents: number, post = true) {
  return env.uc.createEntry.execute({
    organizationId: ORG_A, userId: USER, entryDate: date, description: `Venta ${date}`, post,
    lines: [{ accountId: env.byCode('1.1.01.01').id, debitCents: cents }, { accountId: env.byCode('4.1.01').id, creditCents: cents }],
  });
}

describe('alta de la contabilidad', () => {
  it('copia el plan de cuentas, abre doce periodos y marca las cuentas de detalle', async () => {
    const { byCode } = await setupOrg(store);
    const cash = byCode('1.1.01.01');
    expect(cash).toMatchObject({ isPostable: true, systemRole: 'cash', level: 4, type: 'asset' });
    expect(byCode('1.1')).toMatchObject({ isPostable: false });
    const years = await buildUseCases(store).listFiscalYears.execute(ORG_A);
    expect(years).toHaveLength(1);
    expect(years[0]!.periods).toHaveLength(12);
    expect(store.outboxEvents.map((e) => e.type)).toEqual(['accounting.setup.completed', 'accounting.fiscal_year.created']);
  });

  it('solo se hace una vez por organización', async () => {
    const { uc } = await setupOrg(store);
    await expect(uc.setup.execute({ organizationId: ORG_A, userId: USER, chartTemplate: 'ec-supercias' })).rejects.toMatchObject({ code: 'ACCOUNTING_ALREADY_SET_UP' });
  });

  it('el plan vacío empieza sin cuentas', async () => {
    const uc = buildUseCases(store);
    const res = await uc.setup.execute({ organizationId: ORG_B, userId: USER, chartTemplate: 'empty', fiscalYear: 2026 });
    expect(res.accountCount).toBe(0);
  });

  it('sin configurar no se puede crear un asiento', async () => {
    const uc = buildUseCases(store);
    await expect(
      uc.createEntry.execute({ organizationId: ORG_B, userId: USER, entryDate: '2026-01-01', description: 'x', post: false, lines: [] }),
    ).rejects.toBeTruthy();
  });
});

describe('plan de cuentas', () => {
  it('colgar una subcuenta de una cuenta de detalle sin movimientos la vuelve de agrupación', async () => {
    const { uc, byCode } = await setupOrg(store);
    const bank = byCode('1.1.01.02');
    const child = await uc.createAccount.execute({ organizationId: ORG_A, code: '1.1.01.02.01', name: 'Banco Pichincha', parentId: bank.id });
    expect(child).toMatchObject({ type: 'asset', level: 5, isPostable: true });
    const reloaded = await store.repos.accounts.findById(ORG_A, bank.id);
    expect(reloaded!.isPostable).toBe(false);
    expect(reloaded!.systemRole).toBeNull();
  });

  it('no se cuelga una subcuenta de una cuenta con movimientos', async () => {
    const env = await setupOrg(store);
    await sale(env, '2026-03-01', 1000);
    await expect(
      env.uc.createAccount.execute({ organizationId: ORG_A, code: '1.1.01.01.01', name: 'Caja 2', parentId: env.byCode('1.1.01.01').id }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_PARENT_INVALID' });
  });

  it('el código es único y los roles no se repiten', async () => {
    const { uc, byCode } = await setupOrg(store);
    await expect(uc.createAccount.execute({ organizationId: ORG_A, code: '1.1.01.01', name: 'Otra', parentId: byCode('1.1.01').id })).rejects.toMatchObject({ code: 'ACCOUNT_CODE_EXISTS' });
    await expect(
      uc.createAccount.execute({ organizationId: ORG_A, code: '1.1.01.09', name: 'Otra caja', parentId: byCode('1.1.01').id, systemRole: 'cash' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('no se desactiva una cuenta con subcuentas activas', async () => {
    const { uc, byCode } = await setupOrg(store);
    await expect(uc.updateAccount.execute({ organizationId: ORG_A, accountId: byCode('1.1').id, status: 'inactive' })).rejects.toMatchObject({ code: 'ACCOUNT_IN_USE' });
  });

  it('las cuentas son de cada organización', async () => {
    const { byCode } = await setupOrg(store);
    const uc = buildUseCases(store);
    await expect(uc.getAccount.execute(ORG_B, byCode('1.1.01.01').id)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });
});

describe('contabilizar', () => {
  it('numera los asientos seguidos por ejercicio y emite el evento con las líneas', async () => {
    const env = await setupOrg(store);
    const a = await sale(env, '2026-03-01', 1000);
    const b = await sale(env, '2026-03-02', 2000);
    expect(a.displayNumber()).toBe('AS-2026-000001');
    expect(b.displayNumber()).toBe('AS-2026-000002');
    const posted = store.outboxEvents.filter((e) => e.type === 'accounting.journal_entry.posted');
    expect(posted).toHaveLength(2);
    expect((posted[0]!.payload.lines as unknown[]).length).toBe(2);
  });

  it('un borrador no tiene número ni cuenta en los informes hasta contabilizarse', async () => {
    const env = await setupOrg(store);
    const draft = await sale(env, '2026-03-01', 1000, false);
    expect(draft.displayNumber()).toBeNull();
    let tb = await env.uc.trialBalance.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31' });
    expect(tb.rows).toHaveLength(0);
    await env.uc.postEntry.execute({ organizationId: ORG_A, entryId: draft.id, userId: USER });
    tb = await env.uc.trialBalance.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31' });
    expect(tb.totals).toMatchObject({ debitCents: 1000, creditCents: 1000 });
  });

  it('un borrador se edita y se borra; uno contabilizado no', async () => {
    const env = await setupOrg(store);
    const draft = await sale(env, '2026-03-01', 1000, false);
    const edited = await env.uc.updateEntry.execute({
      organizationId: ORG_A, entryId: draft.id, entryDate: '2026-03-05', description: 'Cambiado',
      lines: [{ accountId: env.byCode('1.1.01.01').id, debitCents: 700 }, { accountId: env.byCode('4.1.01').id, creditCents: 700 }],
    });
    expect(edited.totalDebitCents).toBe(700);
    await env.uc.deleteEntry.execute({ organizationId: ORG_A, entryId: draft.id });
    await expect(env.uc.getEntry.execute(ORG_A, draft.id)).rejects.toMatchObject({ code: 'JOURNAL_ENTRY_NOT_FOUND' });

    const posted = await sale(env, '2026-03-01', 500);
    await expect(env.uc.deleteEntry.execute({ organizationId: ORG_A, entryId: posted.id })).rejects.toMatchObject({ code: 'JOURNAL_ENTRY_NOT_DRAFT' });
    await expect(
      env.uc.updateEntry.execute({ organizationId: ORG_A, entryId: posted.id, entryDate: '2026-03-01', description: 'x', lines: [{ accountId: env.byCode('1.1.01.01').id, debitCents: 1 }, { accountId: env.byCode('4.1.01').id, creditCents: 1 }] }),
    ).rejects.toMatchObject({ code: 'JOURNAL_ENTRY_NOT_DRAFT' });
  });

  it('no se contabiliza en cuentas de agrupación, inactivas ni de otra organización', async () => {
    const env = await setupOrg(store);
    const lines = (debit: string, credit: string) => [{ accountId: debit, debitCents: 100 }, { accountId: credit, creditCents: 100 }];
    await expect(
      env.uc.createEntry.execute({ organizationId: ORG_A, userId: USER, entryDate: '2026-03-01', description: 'x', post: false, lines: lines(env.byCode('1.1').id, env.byCode('4.1.01').id) }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_POSTABLE' });

    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: env.byCode('4.1.02').id, status: 'inactive' });
    await expect(
      env.uc.createEntry.execute({ organizationId: ORG_A, userId: USER, entryDate: '2026-03-01', description: 'x', post: false, lines: lines(env.byCode('1.1.01.01').id, env.byCode('4.1.02').id) }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_POSTABLE' });

    const other = await buildUseCases(store).setup.execute({ organizationId: ORG_B, userId: USER, chartTemplate: 'ec-supercias', fiscalYear: 2026 });
    expect(other.accountCount).toBeGreaterThan(0);
    const foreign = (await store.repos.accounts.findByCode(ORG_B, '4.1.01'))!;
    await expect(
      env.uc.createEntry.execute({ organizationId: ORG_A, userId: USER, entryDate: '2026-03-01', description: 'x', post: false, lines: lines(env.byCode('1.1.01.01').id, foreign.id) }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('un asiento que falla al contabilizar no deja nada a medias', async () => {
    const env = await setupOrg(store);
    // 2030 no tiene ejercicio: el borrador se guarda en la misma transacción que el intento de contabilizarlo y todo se deshace.
    await expect(sale(env, '2030-03-01', 1000)).rejects.toMatchObject({ code: 'PERIOD_NOT_FOUND' });
    expect(store.entryMap.size).toBe(0);
    expect(store.outboxEvents.filter((e) => e.type.startsWith('accounting.journal_entry'))).toHaveLength(0);
  });

  it('un centro de costo inexistente o inactivo se rechaza', async () => {
    const env = await setupOrg(store);
    const cc = await env.uc.createCostCenter.execute({ organizationId: ORG_A, code: 'ventas', name: 'Ventas' });
    const withCc = (id: string) => [
      { accountId: env.byCode('1.1.01.01').id, debitCents: 100, costCenterId: id },
      { accountId: env.byCode('4.1.01').id, creditCents: 100 },
    ];
    await expect(
      env.uc.createEntry.execute({ organizationId: ORG_A, userId: USER, entryDate: '2026-03-01', description: 'x', post: false, lines: withCc('99999999-9999-4999-8999-999999999999') }),
    ).rejects.toMatchObject({ code: 'COST_CENTER_NOT_FOUND' });
    await env.uc.updateCostCenter.execute({ organizationId: ORG_A, id: cc.id, status: 'inactive' });
    await expect(
      env.uc.createEntry.execute({ organizationId: ORG_A, userId: USER, entryDate: '2026-03-01', description: 'x', post: false, lines: withCc(cc.id) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('periodos', () => {
  it('un periodo cerrado rechaza asientos con fecha dentro de él', async () => {
    const env = await setupOrg(store);
    const [year] = await env.uc.listFiscalYears.execute(ORG_A);
    const jan = year!.periods[0]!;
    await env.uc.closePeriod.execute({ organizationId: ORG_A, periodId: jan.id, userId: USER });
    await expect(sale(env, '2026-01-15', 1000)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    await sale(env, '2026-02-15', 1000);
  });

  it('se cierra en orden y no con borradores dentro', async () => {
    const env = await setupOrg(store);
    const [year] = await env.uc.listFiscalYears.execute(ORG_A);
    const [jan, feb] = year!.periods;
    await expect(env.uc.closePeriod.execute({ organizationId: ORG_A, periodId: feb!.id, userId: USER })).rejects.toMatchObject({ code: 'PREVIOUS_PERIOD_OPEN' });
    await sale(env, '2026-01-20', 1000, false);
    await expect(env.uc.closePeriod.execute({ organizationId: ORG_A, periodId: jan!.id, userId: USER })).rejects.toMatchObject({ code: 'PERIOD_HAS_DRAFTS' });
  });

  it('se reabre de atrás hacia adelante', async () => {
    const env = await setupOrg(store);
    const [year] = await env.uc.listFiscalYears.execute(ORG_A);
    const [jan, feb] = year!.periods;
    await env.uc.closePeriod.execute({ organizationId: ORG_A, periodId: jan!.id, userId: USER });
    await env.uc.closePeriod.execute({ organizationId: ORG_A, periodId: feb!.id, userId: USER });
    await expect(env.uc.reopenPeriod.execute({ organizationId: ORG_A, periodId: jan!.id })).rejects.toMatchObject({ code: 'NEXT_PERIOD_CLOSED' });
    await env.uc.reopenPeriod.execute({ organizationId: ORG_A, periodId: feb!.id });
    await env.uc.reopenPeriod.execute({ organizationId: ORG_A, periodId: jan!.id });
    await expect(env.uc.reopenPeriod.execute({ organizationId: ORG_A, periodId: jan!.id })).rejects.toMatchObject({ code: 'PERIOD_ALREADY_IN_STATE' });
  });

  it('crea otro ejercicio y no repite el mismo', async () => {
    const env = await setupOrg(store);
    const next = await env.uc.createFiscalYear.execute({ organizationId: ORG_A, year: 2027 });
    expect(next.periods[0]!.startDate).toBe('2027-01-01');
    await expect(env.uc.createFiscalYear.execute({ organizationId: ORG_A, year: 2027 })).rejects.toMatchObject({ code: 'FISCAL_YEAR_EXISTS' });
  });
});

describe('reversa', () => {
  it('anula con un asiento de signo contrario y deja el original marcado', async () => {
    const env = await setupOrg(store);
    const original = await sale(env, '2026-03-01', 1000);
    const { original: orig, reversal } = await env.uc.reverseEntry.execute({ organizationId: ORG_A, entryId: original.id, userId: USER, reason: 'Venta duplicada' });
    expect(orig.reversedByEntryId).toBe(reversal.id);
    expect(reversal).toMatchObject({ kind: 'reversal', status: 'posted', reversesEntryId: original.id });
    const tb = await env.uc.trialBalance.execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31' });
    // Debe y haber de cada cuenta suman el doble, pero el saldo neto es cero.
    expect(tb.rows.find((r) => r.code === '1.1.01.01')).toMatchObject({ debitCents: 1000, creditCents: 1000, closingCents: 0 });
    // El original sigue intacto y contabilizado.
    const reloaded = await env.uc.getEntry.execute(ORG_A, original.id);
    expect(reloaded).toMatchObject({ status: 'posted', totalDebitCents: 1000 });
    expect(reloaded.lines).toHaveLength(2);
  });

  it('no se reversa dos veces, ni una reversa, ni un borrador', async () => {
    const env = await setupOrg(store);
    const original = await sale(env, '2026-03-01', 1000);
    const { reversal } = await env.uc.reverseEntry.execute({ organizationId: ORG_A, entryId: original.id, userId: USER, reason: 'error' });
    await expect(env.uc.reverseEntry.execute({ organizationId: ORG_A, entryId: original.id, userId: USER, reason: 'otra vez' })).rejects.toMatchObject({ code: 'JOURNAL_ENTRY_ALREADY_REVERSED' });
    await expect(env.uc.reverseEntry.execute({ organizationId: ORG_A, entryId: reversal.id, userId: USER, reason: 'x' })).rejects.toMatchObject({ code: 'JOURNAL_ENTRY_NOT_REVERSIBLE' });
    const draft = await sale(env, '2026-03-02', 10, false);
    await expect(env.uc.reverseEntry.execute({ organizationId: ORG_A, entryId: draft.id, userId: USER, reason: 'x' })).rejects.toMatchObject({ code: 'JOURNAL_ENTRY_NOT_POSTED' });
  });

  it('si el periodo del original está cerrado hace falta una fecha en un periodo abierto', async () => {
    const env = await setupOrg(store);
    const original = await sale(env, '2026-01-15', 1000);
    const [year] = await env.uc.listFiscalYears.execute(ORG_A);
    await env.uc.closePeriod.execute({ organizationId: ORG_A, periodId: year!.periods[0]!.id, userId: USER });
    await expect(env.uc.reverseEntry.execute({ organizationId: ORG_A, entryId: original.id, userId: USER, reason: 'error' })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    const { reversal } = await env.uc.reverseEntry.execute({ organizationId: ORG_A, entryId: original.id, userId: USER, reason: 'error', entryDate: '2026-02-01' });
    expect(reversal.entryDate).toBe('2026-02-01');
    // La reversa fallida no dejó nada a medias: el original sigue sin marca hasta la reversa buena.
    expect((await env.uc.getEntry.execute(ORG_A, original.id)).reversedByEntryId).toBe(reversal.id);
  });
});

describe('informes', () => {
  it('el balance cuadra: debe = haber y saldo final = 0', async () => {
    const env = await setupOrg(store);
    await sale(env, '2026-01-10', 10000);
    await sale(env, '2026-02-10', 5000);
    await env.uc.createEntry.execute({
      organizationId: ORG_A, userId: USER, entryDate: '2026-02-20', description: 'Pago de arriendo', post: true,
      lines: [{ accountId: env.byCode('5.2.02').id, debitCents: 3000 }, { accountId: env.byCode('1.1.01.01').id, creditCents: 3000 }],
    });
    const tb = await env.uc.trialBalance.execute({ organizationId: ORG_A, from: '2026-02-01', to: '2026-02-28' });
    expect(tb.totals).toMatchObject({ debitCents: 8000, creditCents: 8000, openingCents: 0, closingCents: 0 });
    // Saldo inicial de caja = lo de enero.
    expect(tb.rows.find((r) => r.code === '1.1.01.01')).toMatchObject({ openingCents: 10000, debitCents: 5000, creditCents: 3000, closingCents: 12000 });
    // Las cuentas de agrupación suman a sus hijas.
    expect(tb.rows.find((r) => r.code === '1')).toMatchObject({ closingCents: 12000 });
  });

  it('el mayor lleva el saldo acumulado y pagina sin romperlo', async () => {
    const env = await setupOrg(store);
    for (let day = 1; day <= 5; day += 1) await sale(env, `2026-03-0${day}`, 100 * day);
    const cash = env.byCode('1.1.01.01').id;
    const page1 = await env.uc.ledger.execute({ organizationId: ORG_A, accountId: cash, from: '2026-03-01', to: '2026-03-31', page: 1, pageSize: 3 });
    const page2 = await env.uc.ledger.execute({ organizationId: ORG_A, accountId: cash, from: '2026-03-01', to: '2026-03-31', page: 2, pageSize: 3 });
    expect(page1.total).toBe(5);
    expect(page1.lines.map((l) => l.runningCents)).toEqual([100, 300, 600]);
    expect(page2.lines.map((l) => l.runningCents)).toEqual([1000, 1500]);
    expect(page1.lines[0]!.entryNumber).toBe('AS-2026-000001');
  });

  it('valida el rango de fechas', async () => {
    const env = await setupOrg(store);
    await expect(env.uc.trialBalance.execute({ organizationId: ORG_A, from: '2026-05-01', to: '2026-01-01' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(env.uc.trialBalance.execute({ organizationId: ORG_A, from: 'ayer', to: '2026-01-01' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('filtra por centro de costo', async () => {
    const env = await setupOrg(store);
    const cc = await env.uc.createCostCenter.execute({ organizationId: ORG_A, code: 'norte', name: 'Sucursal norte' });
    await env.uc.createEntry.execute({
      organizationId: ORG_A, userId: USER, entryDate: '2026-03-01', description: 'Venta norte', post: true,
      lines: [{ accountId: env.byCode('1.1.01.01').id, debitCents: 400, costCenterId: cc.id }, { accountId: env.byCode('4.1.01').id, creditCents: 400, costCenterId: cc.id }],
    });
    await sale(env, '2026-03-02', 900);
    const all = await env.uc.trialBalance.execute({ organizationId: ORG_A, from: '2026-03-01', to: '2026-03-31' });
    const norte = await env.uc.trialBalance.execute({ organizationId: ORG_A, from: '2026-03-01', to: '2026-03-31', costCenterId: cc.id });
    expect(all.totals.debitCents).toBe(1300);
    expect(norte.totals.debitCents).toBe(400);
  });

  it('un listado filtra por estado y por cuenta, y no mezcla organizaciones', async () => {
    const env = await setupOrg(store);
    await sale(env, '2026-03-01', 100);
    await sale(env, '2026-03-02', 200, false);
    const posted = await env.uc.listEntries.execute(ORG_A, { status: 'posted', page: 1, pageSize: 25 });
    expect(posted.total).toBe(1);
    const byAccount = await env.uc.listEntries.execute(ORG_A, { accountId: env.byCode('5.2.02').id, page: 1, pageSize: 25 });
    expect(byAccount.total).toBe(0);
    const other = await env.uc.listEntries.execute(ORG_B, { page: 1, pageSize: 25 });
    expect(other.total).toBe(0);
  });
});

describe('auditoría: cada escritura publica un evento', () => {
  it('cuentas, centros de costo, periodos y asientos', async () => {
    const env = await setupOrg(store);
    const before = store.outboxEvents.length;
    const acc = await env.uc.createAccount.execute({ organizationId: ORG_A, code: '1.1.01.04', name: 'Caja 3', parentId: env.byCode('1.1.01').id });
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc.id, name: 'Caja tres' });
    const cc = await env.uc.createCostCenter.execute({ organizationId: ORG_A, code: 'a', name: 'A' });
    await env.uc.updateCostCenter.execute({ organizationId: ORG_A, id: cc.id, name: 'AA' });
    const draft = await sale(env, '2026-03-01', 100, false);
    await env.uc.postEntry.execute({ organizationId: ORG_A, entryId: draft.id, userId: USER });
    const other = await sale(env, '2026-03-02', 100, false);
    await env.uc.deleteEntry.execute({ organizationId: ORG_A, entryId: other.id });
    const posted = await sale(env, '2026-03-03', 100);
    await env.uc.reverseEntry.execute({ organizationId: ORG_A, entryId: posted.id, userId: USER, reason: 'error' });
    const [year] = await env.uc.listFiscalYears.execute(ORG_A);
    await env.uc.closePeriod.execute({ organizationId: ORG_A, periodId: year!.periods[0]!.id, userId: USER });
    // Febrero ya tiene los asientos: reabrir enero no es posible hasta... enero es el único cerrado, sí se puede.
    await env.uc.reopenPeriod.execute({ organizationId: ORG_A, periodId: year!.periods[0]!.id });
    await env.uc.createFiscalYear.execute({ organizationId: ORG_A, year: 2027 });
    const types = store.outboxEvents.slice(before).map((e) => e.type);
    for (const expected of [
      'accounting.account.created', 'accounting.account.updated', 'accounting.cost_center.upserted', 'accounting.journal_entry.saved',
      'accounting.journal_entry.posted', 'accounting.journal_entry.deleted', 'accounting.journal_entry.reversed',
      'accounting.period.closed', 'accounting.period.reopened', 'accounting.fiscal_year.created',
    ]) {
      expect(types, `falta ${expected}`).toContain(expected);
    }
    for (const e of store.outboxEvents) expect(e.payload.organizationId, e.type).toBe(ORG_A);
  });
});
