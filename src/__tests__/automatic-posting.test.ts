import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore, ORG_A, ORG_B, buildPluginToggle, buildPosting, setupOrg } from './helpers.js';

const EST = '55555555-5555-4555-8555-555555555555';
const CUST = '66666666-6666-4666-8666-666666666666';
let n = 0;
const uuid = () => `77777777-7777-4777-8777-${String((n += 1)).padStart(12, '0')}`;

const invoiceEvent = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG_A,
  invoiceId: uuid(),
  number: '001-001-000000001',
  issueDate: '2026-10-20T15:00:00.000Z',
  documentTypeCode: '01',
  establishmentId: EST,
  customerSnapshot: { id: CUST, businessName: 'Ana Pérez' },
  totalCents: 11500,
  currencyCode: 'USD',
  lines: [{ subtotalCents: 10000, taxes: [{ kind: 'vat', amountCents: 1500 }] }],
  ...over,
});
const moveEvent = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG_A,
  movementId: uuid(),
  type: 'sale_out',
  accountingNature: 'cogs',
  totalCostCents: 6000,
  currencyCode: 'USD',
  occurredAt: '2026-10-20T15:00:00.000Z',
  ...over,
});

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
const roleOf = (code: string) => env.byCode(code).id;

describe('factura emitida', () => {
  it('genera un asiento automático contabilizado, numerado y enlazado al documento', async () => {
    const ev = invoiceEvent();
    const res = await posting.handle('billing.invoice.issued', ev);
    expect(res.outcome).toBe('posted');
    const [e] = entries();
    expect(e).toMatchObject({ kind: 'automatic', status: 'posted', sourceType: 'invoice', sourceId: ev.invoiceId, entryDate: '2026-10-20', totalDebitCents: 11500 });
    expect(e!.displayNumber()).toBe('AS-2026-000001');
    expect(e!.lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual([
      [roleOf('1.1.02.01'), 11500, 0], // Clientes
      [roleOf('4.1.01'), 0, 10000], // Venta de bienes
      [roleOf('2.1.03.01'), 0, 1500], // IVA cobrado en ventas
    ]);
    expect(e!.lines[0]).toMatchObject({ partyType: 'customer', partyId: CUST, establishmentId: EST });
  });

  it('un evento repetido no duplica el asiento', async () => {
    const ev = invoiceEvent();
    await posting.handle('billing.invoice.issued', ev);
    const again = await posting.handle('billing.invoice.issued', ev);
    expect(again.outcome).toBe('duplicate');
    expect(entries()).toHaveLength(1);
  });

  it('cobrada en efectivo va a caja', async () => {
    await posting.handle('billing.invoice.issued', invoiceEvent({ paymentMethodCode: '01' }));
    expect(entries()[0]!.lines[0]!.accountId).toBe(roleOf('1.1.01.01'));
  });

  it('la nota de crédito reversa los importes contra devoluciones', async () => {
    await posting.handle('billing.invoice.issued', invoiceEvent({ documentTypeCode: '04' }));
    expect(entries()[0]!.lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual([
      [roleOf('4.1.03'), 10000, 0],
      [roleOf('2.1.03.01'), 1500, 0],
      [roleOf('1.1.02.01'), 0, 11500],
    ]);
  });

  it('la nota de débito genera su asiento: clientes / otros ingresos / IVA', async () => {
    const ev = invoiceEvent({ documentTypeCode: '05', totalCents: 1460, lines: [{ subtotalCents: 1000, taxes: [{ kind: 'vat', amountCents: 0 }] }, { subtotalCents: 400, taxes: [{ kind: 'vat', amountCents: 60 }] }] });
    await posting.handle('billing.invoice.issued', ev);
    expect(entries()[0]!.lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual([
      [roleOf('1.1.02.01'), 1460, 0],
      [roleOf('4.2.03'), 0, 1400],
      [roleOf('2.1.03.01'), 0, 60],
    ]);
  });

  it('una organización sin contabilidad se ignora', async () => {
    const res = await posting.handle('billing.invoice.issued', invoiceEvent({ organizationId: ORG_B }));
    expect(res.outcome).toBe('ignored');
    expect(entries()).toHaveLength(0);
    expect(pendings()).toHaveLength(0);
  });

  it('un documento anterior a la fecha de inicio no se contabiliza solo (ya iría en los saldos iniciales)', async () => {
    const res = await posting.handle('billing.invoice.issued', invoiceEvent({ issueDate: '2026-10-14T15:00:00Z' }));
    expect(res.outcome).toBe('ignored');
    expect(entries()).toHaveLength(0);
  });

  it('la fecha contable es la local: una venta a las 20:00 del 20 en Guayaquil cae el 20, no el 21', async () => {
    await posting.handle('billing.invoice.issued', invoiceEvent({ issueDate: '2026-10-21T01:00:00Z' }));
    expect(entries()[0]!.entryDate).toBe('2026-10-20');
  });

  it('los comprobantes sin regla no generan nada ni quedan pendientes', async () => {
    const res = await posting.handle('billing.invoice.issued', invoiceEvent({ documentTypeCode: '06' }));
    expect(res.outcome).toBe('skipped');
    expect(entries()).toHaveLength(0);
    expect(pendings()).toHaveLength(0);
  });
});

describe('lo que no se puede contabilizar queda pendiente, no se pierde', () => {
  it('cuenta sin rol: queda pendiente con su motivo y, al asignar el rol, el reintento lo contabiliza', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('2.1.03.01'), systemRole: null });
    const ev = invoiceEvent();
    const res = await posting.handle('billing.invoice.issued', ev);
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'MISSING_ROLE' });
    expect(res.outcome === 'pending' && res.message).toContain('vat_payable');
    expect(entries()).toHaveLength(0);
    expect(pendings()).toHaveLength(1);
    expect(pendings()[0]).toMatchObject({ status: 'pending', sourceId: ev.invoiceId, attempts: 1 });

    // Sigue pendiente mientras no se arregle.
    expect(await posting.retry(ORG_A)).toEqual({ posted: 0, stillPending: 1, discarded: 0 });
    expect(pendings()[0]!.attempts).toBe(2);

    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('2.1.03.01'), systemRole: 'vat_payable' });
    expect(await posting.retry(ORG_A)).toEqual({ posted: 1, stillPending: 0, discarded: 0 });
    expect(entries()).toHaveLength(1);
    expect(pendings()[0]).toMatchObject({ status: 'posted', entryId: entries()[0]!.id });
  });

  it('periodo cerrado: queda pendiente y se contabiliza al reabrirlo', async () => {
    const [year] = await env.uc.listFiscalYears.execute(ORG_A);
    for (const p of year!.periods.slice(0, 10)) await env.uc.closePeriod.execute({ organizationId: ORG_A, periodId: p.id, userId: 'u' });
    const res = await posting.handle('billing.invoice.issued', invoiceEvent());
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'PERIOD_CLOSED' });
    expect(entries()).toHaveLength(0);

    await env.uc.reopenPeriod.execute({ organizationId: ORG_A, periodId: year!.periods[9]!.id });
    expect((await posting.retry(ORG_A)).posted).toBe(1);
    expect(entries()[0]).toMatchObject({ status: 'posted', entryDate: '2026-10-20' });
  });

  it('sin ejercicio para esa fecha: pendiente hasta crear el ejercicio', async () => {
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPostingFrom: null });
    const res = await posting.handle('billing.invoice.issued', invoiceEvent({ issueDate: '2027-02-10T15:00:00Z' }));
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'PERIOD_NOT_FOUND' });
    await env.uc.createFiscalYear.execute({ organizationId: ORG_A, year: 2027 });
    expect((await posting.retry(ORG_A)).posted).toBe(1);
  });

  it('con la contabilización automática apagada los eventos esperan, y al encenderla se reintentan', async () => {
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPosting: false });
    const res = await posting.handle('billing.invoice.issued', invoiceEvent());
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'AUTO_POSTING_OFF' });
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPosting: true });
    expect((await posting.retry(ORG_A)).posted).toBe(1);
  });

  it('desactivar el módulo apaga la contabilización y reactivarlo la enciende', async () => {
    const toggle = buildPluginToggle(store);
    await toggle.execute({ organizationId: ORG_A, code: 'finance.general_ledger', active: false });
    expect((await env.uc.postingSettings.execute(ORG_A)).settings.autoPosting).toBe(false);
    await toggle.execute({ organizationId: ORG_A, code: 'finance.general_ledger', active: true });
    expect((await env.uc.postingSettings.execute(ORG_A)).settings.autoPosting).toBe(true);
    // Otros módulos no tocan nada.
    await toggle.execute({ organizationId: ORG_A, code: 'inventory.kardex', active: false });
    expect((await env.uc.postingSettings.execute(ORG_A)).settings.autoPosting).toBe(true);
  });

  it('un comprobante con impuesto sin cuenta queda pendiente (no se adivina)', async () => {
    const res = await posting.handle('billing.invoice.issued', invoiceEvent({ lines: [{ subtotalCents: 10000, taxes: [{ kind: 'special', amountCents: 1500 }] }] }));
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'UNMAPPED_TAX_KIND' });
  });

  it('la reentrega de un pendiente no crea otra fila ni otro aviso', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('4.1.01'), systemRole: null });
    const ev = invoiceEvent();
    await posting.handle('billing.invoice.issued', ev);
    await posting.handle('billing.invoice.issued', ev);
    expect(pendings()).toHaveLength(1);
    expect(store.outboxEvents.filter((e) => e.type === 'accounting.posting.pending')).toHaveLength(1);
  });

  it('se puede descartar con un motivo, y no dos veces', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('4.1.01'), systemRole: null });
    await posting.handle('billing.invoice.issued', invoiceEvent());
    const id = pendings()[0]!.id;
    const row = await env.uc.discardPending.execute({ organizationId: ORG_A, id, reason: 'ya está en los saldos iniciales' });
    expect(row.status).toBe('discarded');
    await expect(env.uc.discardPending.execute({ organizationId: ORG_A, id, reason: 'otra vez' })).rejects.toMatchObject({ code: 'PENDING_POSTING_NOT_PENDING' });
    expect(await posting.retry(ORG_A)).toEqual({ posted: 0, stillPending: 0, discarded: 0 });
  });

  it('un pendiente que ya no aplica (se movió la fecha de inicio) se descarta al reintentar', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('4.1.01'), systemRole: null });
    await posting.handle('billing.invoice.issued', invoiceEvent());
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPostingFrom: '2026-11-01' });
    expect(await posting.retry(ORG_A)).toEqual({ posted: 0, stillPending: 0, discarded: 1 });
  });
});

describe('factura anulada', () => {
  it('reversa el asiento automático y deja el original marcado', async () => {
    const ev = invoiceEvent();
    await posting.handle('billing.invoice.issued', ev);
    const res = await posting.handle('billing.invoice.voided', { organizationId: ORG_A, invoiceId: ev.invoiceId, number: ev.number, voidedAt: '2026-10-21T15:00:00Z', reason: 'error' });
    expect(res.outcome).toBe('posted');
    const original = entries().find((e) => e.kind === 'automatic')!;
    const reversal = entries().find((e) => e.kind === 'reversal')!;
    expect(original.reversedByEntryId).toBe(reversal.id);
    expect(reversal).toMatchObject({ status: 'posted', sourceType: 'invoice', sourceId: ev.invoiceId, entryDate: '2026-10-21' });
    const tb = await env.uc.trialBalance.execute({ organizationId: ORG_A, from: '2026-10-01', to: '2026-10-31' });
    expect(tb.totals.closingCents).toBe(0);
    expect(tb.rows.find((r) => r.code === '4.1.01')!.closingCents).toBe(0);
  });

  it('la anulación repetida no reversa dos veces', async () => {
    const ev = invoiceEvent();
    await posting.handle('billing.invoice.issued', ev);
    const voided = { organizationId: ORG_A, invoiceId: ev.invoiceId, number: ev.number, voidedAt: '2026-10-21T15:00:00Z' };
    await posting.handle('billing.invoice.voided', voided);
    expect((await posting.handle('billing.invoice.voided', voided)).outcome).toBe('duplicate');
    expect(entries().filter((e) => e.kind === 'reversal')).toHaveLength(1);
  });

  it('anulada antes de contabilizarse: el pendiente se descarta y no se reversa nada', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('4.1.01'), systemRole: null });
    const ev = invoiceEvent();
    await posting.handle('billing.invoice.issued', ev);
    const res = await posting.handle('billing.invoice.voided', { organizationId: ORG_A, invoiceId: ev.invoiceId, number: ev.number });
    expect(res.outcome).toBe('ignored');
    expect(pendings()[0]!.status).toBe('discarded');
    expect(entries()).toHaveLength(0);
  });

  it('una factura anterior a la contabilidad (fecha de emisión anterior al inicio) no hace nada', async () => {
    const res = await posting.handle('billing.invoice.voided', { organizationId: ORG_A, invoiceId: uuid(), issueDate: '2026-09-01T15:00:00Z' });
    expect(res.outcome).toBe('ignored');
    expect(pendings()).toHaveLength(0);
  });

  it('una anulación sin asiento y sin fecha de emisión espera (no se pierde) hasta que haya asiento', async () => {
    const res = await posting.handle('billing.invoice.voided', { organizationId: ORG_A, invoiceId: uuid() });
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'ORIGINAL_NOT_POSTED' });
    expect(pendings()[0]).toMatchObject({ status: 'pending', sourceType: 'invoice_void' });
  });

  it('la anulación que llega ANTES que la emisión se reversa sola cuando la emisión se contabiliza', async () => {
    const ev = invoiceEvent();
    const voided = await posting.handle('billing.invoice.voided', { organizationId: ORG_A, invoiceId: ev.invoiceId, number: ev.number, issueDate: ev.issueDate, voidedAt: '2026-10-20T16:00:00Z' });
    expect(voided).toMatchObject({ outcome: 'pending', reasonCode: 'ORIGINAL_NOT_POSTED' });
    await posting.handle('billing.invoice.issued', ev);
    const original = entries().find((e) => e.kind === 'automatic')!;
    const reversal = entries().find((e) => e.kind === 'reversal')!;
    expect(original.reversedByEntryId).toBe(reversal.id);
    expect(pendings().find((p) => p.sourceType === 'invoice_void')).toMatchObject({ status: 'posted', entryId: reversal.id });
    const tb = await env.uc.trialBalance.execute({ organizationId: ORG_A, from: '2026-10-01', to: '2026-10-31' });
    expect(tb.rows.find((r) => r.code === '4.1.01')!.closingCents).toBe(0);
  });

  it('con el periodo de la anulación cerrado, queda pendiente', async () => {
    const ev = invoiceEvent();
    await posting.handle('billing.invoice.issued', ev);
    const [year] = await env.uc.listFiscalYears.execute(ORG_A);
    for (const p of year!.periods.slice(0, 10)) await env.uc.closePeriod.execute({ organizationId: ORG_A, periodId: p.id, userId: 'u' });
    const res = await posting.handle('billing.invoice.voided', { organizationId: ORG_A, invoiceId: ev.invoiceId, number: ev.number, voidedAt: '2026-10-21T15:00:00Z' });
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'PERIOD_CLOSED', sourceType: 'invoice_void' });
    expect(entries().filter((e) => e.kind === 'reversal')).toHaveLength(0);
    await env.uc.reopenPeriod.execute({ organizationId: ORG_A, periodId: year!.periods[9]!.id });
    expect((await posting.retry(ORG_A)).posted).toBe(1);
  });
});

describe('inventario', () => {
  it('la venta lleva costo de ventas contra inventario por lo que costó', async () => {
    await posting.handle('inventory.stock.consumed', moveEvent());
    expect(entries()[0]!.lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual([
      [roleOf('5.1.01'), 6000, 0],
      [roleOf('1.1.03.01'), 0, 6000],
    ]);
  });

  it('venta + costo dejan el balance cuadrado y la utilidad bruta correcta', async () => {
    await posting.handle('billing.invoice.issued', invoiceEvent());
    await posting.handle('inventory.stock.consumed', moveEvent());
    const tb = await env.uc.trialBalance.execute({ organizationId: ORG_A, from: '2026-10-01', to: '2026-10-31' });
    expect(tb.totals).toMatchObject({ debitCents: 17500, creditCents: 17500, closingCents: 0 });
    const net = (code: string) => tb.rows.find((r) => r.code === code)!.closingCents;
    // Ventas 10.000 (acreedor) menos costo 6.000 (deudor).
    expect(net('4.1.01') + net('5.1.01')).toBe(-4000);
  });

  it('un movimiento repetido no duplica', async () => {
    const ev = moveEvent();
    await posting.handle('inventory.stock.consumed', ev);
    expect((await posting.handle('inventory.stock.consumed', ev)).outcome).toBe('duplicate');
    expect(entries()).toHaveLength(1);
  });

  it('la compra y los traslados no generan asiento', async () => {
    expect((await posting.handle('inventory.stock.entered', moveEvent({ type: 'purchase_in', accountingNature: 'inventory_in' }))).outcome).toBe('skipped');
    expect((await posting.handle('inventory.stock.transferred', moveEvent())).outcome).toBe('skipped');
    expect(entries()).toHaveLength(0);
  });

  it('mermas y sobrantes de un ajuste', async () => {
    await posting.handle('inventory.stock.adjusted', moveEvent({ type: 'adjustment_out', accountingNature: 'shrinkage' }));
    await posting.handle('inventory.stock.adjusted', moveEvent({ type: 'adjustment_in', accountingNature: 'inventory_gain', totalCostCents: 2500 }));
    const [shrink, gain] = entries();
    expect(shrink!.lines.map((l) => l.accountId)).toEqual([roleOf('5.1.02'), roleOf('1.1.03.01')]);
    expect(gain!.lines.map((l) => l.accountId)).toEqual([roleOf('1.1.03.01'), roleOf('4.2.02')]);
  });
});

describe('retención emitida', () => {
  const withholdingEvent = (over: Record<string, unknown> = {}) => ({
    organizationId: ORG_A,
    withholdingId: uuid(),
    number: '001-001-000000007',
    issueDate: '2026-10-20T15:00:00.000Z',
    establishmentId: EST,
    currencyCode: 'USD',
    supplier: { identification: '1790012345001', businessName: 'Proveedor Andino' },
    incomeTaxWithheldCents: 100,
    vatWithheldCents: 450,
    isdWithheldCents: 0,
    totalWithheldCents: 550,
    ...over,
  });

  it('genera Dr proveedores / Cr retenciones por pagar y es idempotente', async () => {
    const ev = withholdingEvent();
    const res = await posting.handle('fiscal.ec.withholding.issued', ev);
    expect(res.outcome).toBe('posted');
    const [e] = entries();
    expect(e).toMatchObject({ kind: 'automatic', status: 'posted', sourceType: 'withholding', sourceId: ev.withholdingId, totalDebitCents: 550 });
    expect(e!.lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual([
      [roleOf('2.1.01.01'), 550, 0], // Proveedores
      [roleOf('2.1.03.03'), 0, 100], // Retenciones en la fuente por pagar
      [roleOf('2.1.03.02'), 0, 450], // Retenciones de IVA por pagar
    ]);
    expect((await posting.handle('fiscal.ec.withholding.issued', ev)).outcome).toBe('duplicate');
    expect(entries()).toHaveLength(1);
  });

  it('con el ISD queda pendiente en vez de asentarse mal', async () => {
    const res = await posting.handle('fiscal.ec.withholding.issued', withholdingEvent({ isdWithheldCents: 50, totalWithheldCents: 600 }));
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'UNMAPPED_TAX_KIND' });
    expect(entries()).toHaveLength(0);
    expect(pendings()).toHaveLength(1);
  });

  it('sin cuenta con el rol de retenciones por pagar queda pendiente y se contabiliza al asignarlo', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('2.1.03.03'), systemRole: null });
    const res = await posting.handle('fiscal.ec.withholding.issued', withholdingEvent());
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'MISSING_ROLE' });
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('2.1.03.03'), systemRole: 'income_tax_withholding_payable' });
    await posting.retry(ORG_A);
    expect(entries()).toHaveLength(1);
  });
});

describe('ajustes y roles', () => {
  it('cambiar el rol a otra cuenta deja a la anterior sin rol (un rol, una cuenta)', async () => {
    const newCash = await env.uc.createAccount.execute({ organizationId: ORG_A, code: '1.1.01.09', name: 'Caja matriz', parentId: roleOf('1.1.01') });
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: newCash.id, systemRole: 'cash' });
    expect((await store.repos.accounts.findById(ORG_A, roleOf('1.1.01.01')))!.systemRole).toBeNull();
    expect((await store.repos.accounts.findById(ORG_A, newCash.id))!.systemRole).toBe('cash');
    await posting.handle('billing.invoice.issued', invoiceEvent({ paymentMethodCode: '01' }));
    expect(entries()[0]!.lines[0]!.accountId).toBe(newCash.id);
  });

  it('un rol no va en una cuenta de agrupación', async () => {
    await expect(env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('1.1'), systemRole: 'cash' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('la forma de pago se reasigna desde los ajustes y valida', async () => {
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, paymentMethodRoles: { '01': 'bank' } });
    await posting.handle('billing.invoice.issued', invoiceEvent({ paymentMethodCode: '01' }));
    expect(entries()[0]!.lines[0]!.accountId).toBe(roleOf('1.1.01.02'));
    await expect(env.uc.updatePostingSettings.execute({ organizationId: ORG_A, paymentMethodRoles: { abc: 'bank' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(env.uc.updatePostingSettings.execute({ organizationId: ORG_A, timezone: 'Marte/Olympus' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPostingFrom: 'ayer' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('el alta fija el inicio de la contabilización automática en el día del alta y publica los cambios', async () => {
    const view = await env.uc.postingSettings.execute(ORG_A);
    expect(view.settings).toMatchObject({ autoPosting: true, autoPostingFrom: '2026-10-15', timezone: 'America/Guayaquil' });
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPosting: false });
    expect(store.outboxEvents.map((e) => e.type)).toContain('accounting.posting_settings.updated');
  });
});

describe('auditoría de lo automático', () => {
  it('cada asiento automático publica accounting.journal_entry.posted y un pendiente publica su aviso', async () => {
    await posting.handle('billing.invoice.issued', invoiceEvent());
    expect(store.outboxEvents.filter((e) => e.type === 'accounting.journal_entry.posted')).toHaveLength(1);
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('4.1.01'), systemRole: null });
    await posting.handle('billing.invoice.issued', invoiceEvent());
    const pend = store.outboxEvents.find((e) => e.type === 'accounting.posting.pending')!;
    expect(pend.payload).toMatchObject({ reasonCode: 'MISSING_ROLE', organizationId: ORG_A });
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: roleOf('4.1.01'), systemRole: 'sales_revenue' });
    await posting.retry(ORG_A);
    expect(store.outboxEvents.some((e) => e.type === 'accounting.posting.resolved')).toBe(true);
    for (const e of store.outboxEvents) expect(e.payload.organizationId, e.type).toBe(ORG_A);
  });
});

describe('descripciones legibles', () => {
  it('el costo de venta nombra la factura por su número cuando ya tiene asiento', async () => {
    const ev = invoiceEvent();
    await posting.handle('billing.invoice.issued', ev);
    await posting.handle('inventory.stock.consumed', moveEvent({ referenceType: 'invoice', referenceId: ev.invoiceId }));
    const cogs = entries().find((e) => e.sourceType === 'stock_movement')!;
    expect(cogs.description).toBe('Costo de ventas — factura 001-001-000000001');
  });
});
