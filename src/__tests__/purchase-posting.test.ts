import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore, ORG_A, buildPosting, setupOrg } from './helpers.js';

/**
 * Asientos de compras (Fase 2.4): factura de compra contabilizada, su anulación, la liquidación de compra y cómo
 * conviven con la retención y con la entrada de inventario por compra (que NO se asienta).
 */
const EST = '55555555-5555-4555-8555-555555555555';
const SUPPLIER = '88888888-8888-4888-8888-888888888888';
let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String((n += 1)).padStart(12, '0')}`;

const stockLine = (over: Record<string, unknown> = {}) => ({ kind: 'stock', productId: uuid(), subtotalCents: 10000, vatCents: 1500, iceCents: 0, irbpnrCents: 0, priceVarianceCents: 0, ...over });
const expenseLine = (over: Record<string, unknown> = {}) => ({ kind: 'expense', productId: null, subtotalCents: 4000, vatCents: 600, iceCents: 0, irbpnrCents: 0, priceVarianceCents: 0, ...over });

const billEvent = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG_A,
  billId: uuid(),
  internalNumber: 'FC-2026-000001',
  supplierId: SUPPLIER,
  supplier: { identification: '1790012345001', legalName: 'Proveedor Andino' },
  docType: '01',
  supplierDocument: '001-001-000000123',
  issueDate: '2026-10-20T15:00:00.000Z',
  currencyCode: 'USD',
  subtotalCents: 10000,
  taxCents: 1500,
  totalCents: 11500,
  establishmentId: EST,
  orderId: uuid(),
  matchStatus: 'matched',
  lines: [stockLine()],
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
const acc = (code: string) => env.byCode(code).id;
const shape = (e: { lines: Array<{ accountId: string; debitCents: number; creditCents: number }> }) => e.lines.map((l) => [l.accountId, l.debitCents, l.creditCents]);
const totals = (e: { lines: Array<{ debitCents: number; creditCents: number }> }) => ({
  debit: e.lines.reduce((s, l) => s + l.debitCents, 0),
  credit: e.lines.reduce((s, l) => s + l.creditCents, 0),
});

describe('factura de compra contabilizada', () => {
  it('mercadería: Dr inventario + Dr IVA crédito / Cr proveedores, con el proveedor como tercero', async () => {
    const ev = billEvent();
    const res = await posting.handle('purchasing.bill.posted', ev);
    expect(res.outcome).toBe('posted');
    const [e] = entries();
    expect(e).toMatchObject({ kind: 'automatic', status: 'posted', sourceType: 'purchase_bill', sourceId: ev.billId, entryDate: '2026-10-20', totalDebitCents: 11500 });
    expect(shape(e!)).toEqual(expect.arrayContaining([
      [acc('2.1.01.01'), 0, 11500], // Proveedores
      [acc('1.1.03.01'), 10000, 0], // Inventario de mercaderías
      [acc('1.1.05.01'), 1500, 0], // Crédito tributario de IVA
    ]));
    expect(e!.lines).toHaveLength(3);
    const payables = e!.lines.find((l) => l.accountId === acc('2.1.01.01'))!;
    expect(payables).toMatchObject({ partyType: 'supplier', partyId: SUPPLIER });
    expect(e!.description).toContain('FC-2026-000001');
  });

  it('el IVA es crédito tributario, NO costo del inventario', async () => {
    await posting.handle('purchasing.bill.posted', billEvent());
    const inv = entries()[0]!.lines.find((l) => l.accountId === acc('1.1.03.01'))!;
    expect(inv.debitCents).toBe(10000);
  });

  it('gasto (sin producto) va a otros gastos y mercadería a inventario en la misma factura', async () => {
    const ev = billEvent({ subtotalCents: 14000, taxCents: 2100, totalCents: 16100, lines: [stockLine(), expenseLine()] });
    await posting.handle('purchasing.bill.posted', ev);
    expect(shape(entries()[0]!)).toEqual(expect.arrayContaining([
      [acc('2.1.01.01'), 0, 16100],
      [acc('1.1.03.01'), 10000, 0],
      [acc('5.2.99'), 4000, 0],
      [acc('1.1.05.01'), 2100, 0],
    ]));
  });

  it('ICE e IRBPNR de una línea de mercadería forman parte de su costo', async () => {
    const ev = billEvent({ subtotalCents: 10000, taxCents: 2000, totalCents: 12000, lines: [stockLine({ iceCents: 500 })] });
    await posting.handle('purchasing.bill.posted', ev);
    expect(shape(entries()[0]!)).toEqual(expect.arrayContaining([[acc('1.1.03.01'), 10500, 0], [acc('1.1.05.01'), 1500, 0]]));
  });

  describe('diferencia de precio aprobada con excepción', () => {
    it('costó MÁS que la orden: el inventario queda al costo de la orden y la diferencia va al rol de variación (Dr)', async () => {
      // Orden: 10 × 250 = 2500; la factura cobra 3000 → +500.
      const ev = billEvent({ subtotalCents: 3000, taxCents: 450, totalCents: 3450, lines: [stockLine({ subtotalCents: 3000, vatCents: 450, priceVarianceCents: 500 })] });
      await posting.handle('purchasing.bill.posted', ev);
      expect(shape(entries()[0]!)).toEqual(expect.arrayContaining([
        [acc('1.1.03.01'), 2500, 0],
        [acc('5.2.11'), 500, 0],
        [acc('1.1.05.01'), 450, 0],
        [acc('2.1.01.01'), 0, 3450],
      ]));
    });

    it('costó MENOS que la orden: la diferencia va al haber', async () => {
      // Orden 2500; factura 2000 → -500.
      const ev = billEvent({ subtotalCents: 2000, taxCents: 300, totalCents: 2300, lines: [stockLine({ subtotalCents: 2000, vatCents: 300, priceVarianceCents: -500 })] });
      await posting.handle('purchasing.bill.posted', ev);
      const e = entries()[0]!;
      expect(shape(e)).toEqual(expect.arrayContaining([[acc('1.1.03.01'), 2500, 0], [acc('5.2.11'), 0, 500], [acc('1.1.05.01'), 300, 0], [acc('2.1.01.01'), 0, 2300]]));
    });

    it('el asiento cuadra en ambos sentidos', async () => {
      for (const variance of [500, -500]) {
        const subtotal = 2500 + variance;
        const ev = billEvent({ subtotalCents: subtotal, taxCents: 300, totalCents: subtotal + 300, lines: [stockLine({ subtotalCents: subtotal, vatCents: 300, priceVarianceCents: variance })] });
        await posting.handle('purchasing.bill.posted', ev);
      }
      for (const e of entries()) {
        const t = totals(e);
        expect(t.debit).toBe(t.credit);
      }
    });
  });

  it('es idempotente: el mismo evento dos veces deja un solo asiento', async () => {
    const ev = billEvent();
    await posting.handle('purchasing.bill.posted', ev);
    expect((await posting.handle('purchasing.bill.posted', ev)).outcome).toBe('duplicate');
    expect(entries()).toHaveLength(1);
  });

  it('una moneda distinta a la base queda pendiente (CURRENCY_MISMATCH), sin asiento', async () => {
    const res = await posting.handle('purchasing.bill.posted', billEvent({ currencyCode: 'EUR' }));
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'CURRENCY_MISMATCH' });
    expect(entries()).toHaveLength(0);
    expect(pendings()).toHaveLength(1);
  });

  it('un total que no coincide con sus líneas queda pendiente en vez de asentarse descuadrado', async () => {
    const res = await posting.handle('purchasing.bill.posted', billEvent({ totalCents: 99999 }));
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'UNBALANCED_SOURCE' });
    expect(entries()).toHaveLength(0);
  });

  it('sin cuenta con el rol de proveedores queda pendiente y se contabiliza al asignarlo', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc('2.1.01.01'), systemRole: null });
    const res = await posting.handle('purchasing.bill.posted', billEvent());
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'MISSING_ROLE' });
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc('2.1.01.01'), systemRole: 'payables' });
    await posting.retry(ORG_A);
    expect(entries()).toHaveLength(1);
  });

  it('el rol de variación solo se exige si hay diferencia de precio', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc('5.2.11'), systemRole: null });
    expect((await posting.handle('purchasing.bill.posted', billEvent())).outcome).toBe('posted');
    const withVariance = billEvent({ subtotalCents: 3000, taxCents: 450, totalCents: 3450, lines: [stockLine({ subtotalCents: 3000, vatCents: 450, priceVarianceCents: 500 })] });
    expect(await posting.handle('purchasing.bill.posted', withVariance)).toMatchObject({ outcome: 'pending', reasonCode: 'MISSING_ROLE' });
  });

  it('una factura sin importe no genera asiento', async () => {
    const res = await posting.handle('purchasing.bill.posted', billEvent({ subtotalCents: 0, taxCents: 0, totalCents: 0, lines: [stockLine({ subtotalCents: 0, vatCents: 0 })] }));
    expect(res.outcome).toBe('skipped');
  });

  it('una liquidación (docType 03) NO se asienta aquí: su asiento nace de fiscal al autorizarse', async () => {
    const res = await posting.handle('purchasing.bill.posted', billEvent({ docType: '03' }));
    expect(res.outcome).toBe('skipped');
    expect(entries()).toHaveLength(0);
  });
});

describe('factura de compra anulada', () => {
  it('reversa el asiento y deja el original marcado', async () => {
    const ev = billEvent();
    await posting.handle('purchasing.bill.posted', ev);
    const res = await posting.handle('purchasing.bill.voided', { organizationId: ORG_A, billId: ev.billId, internalNumber: ev.internalNumber, voidReason: 'Factura emitida por error' });
    expect(res.outcome).toBe('posted');
    const original = entries().find((e) => e.kind === 'automatic')!;
    const reversal = entries().find((e) => e.kind === 'reversal')!;
    expect(original.reversedByEntryId).toBe(reversal.id);
    expect(reversal.lines.map((l) => [l.accountId, l.debitCents, l.creditCents])).toEqual(
      original.lines.map((l) => [l.accountId, l.creditCents, l.debitCents]),
    );
    expect(reversal.description).toContain('FC-2026-000001');
  });

  it('anularla dos veces no reversa dos veces', async () => {
    const ev = billEvent();
    await posting.handle('purchasing.bill.posted', ev);
    const voided = { organizationId: ORG_A, billId: ev.billId, internalNumber: ev.internalNumber };
    await posting.handle('purchasing.bill.voided', voided);
    expect((await posting.handle('purchasing.bill.voided', voided)).outcome).toBe('duplicate');
    expect(entries().filter((e) => e.kind === 'reversal')).toHaveLength(1);
  });

  it('si la factura aún estaba pendiente, la anulación descarta el pendiente', async () => {
    await env.uc.updateAccount.execute({ organizationId: ORG_A, accountId: acc('2.1.01.01'), systemRole: null });
    const ev = billEvent();
    await posting.handle('purchasing.bill.posted', ev);
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(1);
    const res = await posting.handle('purchasing.bill.voided', { organizationId: ORG_A, billId: ev.billId });
    expect(res.outcome).toBe('ignored');
    expect(pendings().filter((p) => p.status === 'pending')).toHaveLength(0);
    expect(entries()).toHaveLength(0);
  });

  it('una anulación de una factura que nunca tuvo asiento queda pendiente (ORIGINAL_NOT_POSTED)', async () => {
    const res = await posting.handle('purchasing.bill.voided', { organizationId: ORG_A, billId: uuid() });
    expect(res).toMatchObject({ outcome: 'pending', reasonCode: 'ORIGINAL_NOT_POSTED' });
  });
});

describe('liquidación de compra autorizada', () => {
  const settlementEvent = (over: Record<string, unknown> = {}) => ({
    organizationId: ORG_A,
    documentId: uuid(),
    internalNumber: '001-001-000000010',
    supplierId: SUPPLIER,
    supplier: { identification: '0912345678', legalName: 'Artesano Pérez' },
    docType: '03',
    supplierDocument: '001-001-000000010',
    issueDate: '2026-10-20T15:00:00.000Z',
    currencyCode: 'USD',
    subtotalCents: 4000,
    taxCents: 600,
    totalCents: 4600,
    establishmentId: EST,
    lines: [expenseLine()],
    ...over,
  });

  it('asienta igual que una compra: gasto + IVA crédito / proveedores', async () => {
    const ev = settlementEvent();
    const res = await posting.handle('fiscal.ec.purchase_settlement.issued', ev);
    expect(res.outcome).toBe('posted');
    expect(entries()[0]).toMatchObject({ sourceType: 'purchase_settlement', sourceId: ev.documentId });
    expect(shape(entries()[0]!)).toEqual(expect.arrayContaining([[acc('2.1.01.01'), 0, 4600], [acc('5.2.99'), 4000, 0], [acc('1.1.05.01'), 600, 0]]));
  });

  it('es idempotente', async () => {
    const ev = settlementEvent();
    await posting.handle('fiscal.ec.purchase_settlement.issued', ev);
    expect((await posting.handle('fiscal.ec.purchase_settlement.issued', ev)).outcome).toBe('duplicate');
    expect(entries()).toHaveLength(1);
  });
});

describe('convivencia con la retención y con el inventario', () => {
  it('factura de 1.120,00 con retención de 31,50: el saldo del proveedor queda en 1.088,50', async () => {
    const bill = billEvent({ subtotalCents: 100000, taxCents: 12000, totalCents: 112000, lines: [stockLine({ subtotalCents: 100000, vatCents: 12000 })] });
    await posting.handle('purchasing.bill.posted', bill);
    await posting.handle('fiscal.ec.withholding.issued', {
      organizationId: ORG_A, withholdingId: uuid(), number: '001-001-000000007', issueDate: '2026-10-21T15:00:00.000Z', establishmentId: EST,
      currencyCode: 'USD', supplier: { identification: '1790012345001', businessName: 'Proveedor Andino' },
      incomeTaxWithheldCents: 1000, vatWithheldCents: 2150, isdWithheldCents: 0, totalWithheldCents: 3150,
    });
    const payables = entries().flatMap((e) => e.lines).filter((l) => l.accountId === acc('2.1.01.01'));
    const balance = payables.reduce((s, l) => s + l.creditCents - l.debitCents, 0);
    expect(balance).toBe(108850); // 1.088,50
  });

  it('la entrada de inventario por compra (purchase_in) NO se asienta: la asienta la factura', async () => {
    const res = await posting.handle('inventory.stock.entered', {
      organizationId: ORG_A, movementId: uuid(), type: 'purchase_in', accountingNature: 'inventory_in', totalCostCents: 2500,
      currencyCode: 'USD', occurredAt: '2026-10-20T15:00:00.000Z',
    });
    expect(res.outcome).toBe('skipped');
    expect(entries()).toHaveLength(0);
  });
});

// Regresión (apareció al levantar la pila completa): compras y fiscal mandan `issueDate` como fecha SIN hora («2026-10-20»). Pasarla
// por `new Date()` la tomaba como medianoche UTC y en Guayaquil salía el día ANTERIOR: el asiento caía un día antes (otro periodo si
// era el 1.º de mes) y `auto_posting_from` lo descartaba. Las pruebas de arriba usan marcas de tiempo completas y no lo veían.
describe('fecha sin hora (issueDate de compras y de fiscal)', () => {
  it('la factura de compra se asienta el MISMO día que dice su fecha, no el anterior', async () => {
    await posting.handle('purchasing.bill.posted', billEvent({ issueDate: '2026-10-20' }));
    expect(entries()[0]!.entryDate).toBe('2026-10-20');
  });

  it('el 1.º de mes no cae en el mes anterior', async () => {
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPostingFrom: '2026-10-15' });
    await posting.handle('purchasing.bill.posted', billEvent({ issueDate: '2026-11-01' }));
    expect(entries()[0]!.entryDate).toBe('2026-11-01');
  });

  it('una factura fechada EXACTAMENTE el día de inicio de la contabilización automática sí se asienta', async () => {
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPostingFrom: '2026-10-20' });
    const res = await posting.handle('purchasing.bill.posted', billEvent({ issueDate: '2026-10-20' }));
    expect(res.outcome).toBe('posted');
  });

  it('una anterior a ese día sigue ignorándose', async () => {
    await env.uc.updatePostingSettings.execute({ organizationId: ORG_A, autoPostingFrom: '2026-10-20' });
    const res = await posting.handle('purchasing.bill.posted', billEvent({ issueDate: '2026-10-19' }));
    expect(res.outcome).toBe('ignored');
  });

  it('la retención de fiscal (fecha sin hora) tampoco se corre un día', async () => {
    await posting.handle('fiscal.ec.withholding.issued', {
      organizationId: ORG_A, withholdingId: uuid(), number: '001-001-000000007', issueDate: '2026-10-20', establishmentId: EST,
      currencyCode: 'USD', supplier: { identification: '1790012345001', businessName: 'Proveedor Andino' },
      incomeTaxWithheldCents: 100, vatWithheldCents: 450, isdWithheldCents: 0, totalWithheldCents: 550,
    });
    expect(entries()[0]!.entryDate).toBe('2026-10-20');
  });

  it('una fecha con hora sigue convirtiéndose a la zona de la organización (20:00 en Guayaquil ya es mañana en UTC)', async () => {
    await posting.handle('purchasing.bill.posted', billEvent({ issueDate: '2026-10-21T01:30:00.000Z' }));
    expect(entries()[0]!.entryDate).toBe('2026-10-20');
  });

  it('una fecha imposible se rechaza en vez de asentarse en una fecha inventada', async () => {
    await expect(posting.handle('purchasing.bill.posted', billEvent({ issueDate: '2026-13-45' }))).rejects.toThrow();
  });
});
