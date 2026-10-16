import { describe, expect, it } from 'vitest';
import {
  collectionRoleFor,
  draftFromInvoiceIssued,
  draftFromStockMovement,
  draftFromWithholdingIssued,
  localDateOf,
  type PostingDraft,
  type RuleContext,
} from '../domain/posting.js';

const ctx: RuleContext = { baseCurrency: 'USD', timeZone: 'America/Guayaquil', paymentMethodRoles: null, now: new Date('2026-10-20T15:00:00Z') };

const invoice = (over: Record<string, unknown> = {}) => ({
  invoiceId: 'inv-1',
  number: '001-001-000000001',
  issueDate: '2026-10-20T15:00:00.000Z',
  documentTypeCode: '01',
  establishmentId: 'est-1',
  customerSnapshot: { id: 'cust-1', businessName: 'Ana Pérez' },
  totalCents: 11500,
  currencyCode: 'USD',
  lines: [{ subtotalCents: 10000, taxes: [{ kind: 'vat', amountCents: 1500 }] }],
  ...over,
});

const draft = (r: ReturnType<typeof draftFromInvoiceIssued>): PostingDraft => {
  expect(r.kind).toBe('draft');
  return r as PostingDraft;
};

describe('fecha contable', () => {
  it('es la fecha LOCAL de la organización, no la de UTC', () => {
    // 01:00 UTC del 21 son las 20:00 del 20 en Guayaquil (UTC-5).
    expect(localDateOf('2026-10-21T01:00:00Z', 'America/Guayaquil')).toBe('2026-10-20');
    expect(localDateOf('2026-10-21T01:00:00Z', 'UTC')).toBe('2026-10-21');
    expect(localDateOf('2026-12-31T23:30:00Z', 'America/Guayaquil')).toBe('2026-12-31');
  });
});

describe('factura emitida', () => {
  it('sin forma de pago queda por cobrar: cliente / ventas / IVA', () => {
    const d = draft(draftFromInvoiceIssued(invoice(), ctx));
    expect(d.lines).toEqual([
      { role: 'receivables', debitCents: 11500, creditCents: 0, establishmentId: 'est-1', partyType: 'customer', partyId: 'cust-1' },
      { role: 'sales_revenue', debitCents: 0, creditCents: 10000, establishmentId: 'est-1' },
      { role: 'vat_payable', debitCents: 0, creditCents: 1500, establishmentId: 'est-1' },
    ]);
    expect(d).toMatchObject({ sourceType: 'invoice', sourceId: 'inv-1', entryDate: '2026-10-20', reference: '001-001-000000001' });
    expect(d.description).toBe('Factura 001-001-000000001 — Ana Pérez');
  });

  it('con una forma de pago se cobra al instante: efectivo → caja; tarjeta → bancos', () => {
    expect(draft(draftFromInvoiceIssued(invoice({ paymentMethodCode: '01' }), ctx)).lines[0]!.role).toBe('cash');
    expect(draft(draftFromInvoiceIssued(invoice({ paymentMethodCode: '19' }), ctx)).lines[0]!.role).toBe('bank');
    expect(draft(draftFromInvoiceIssued(invoice({ paymentMethodCode: '15' }), ctx)).lines[0]!.role).toBe('receivables');
  });

  it('la organización puede cambiar a dónde va cada forma de pago', () => {
    expect(collectionRoleFor('19', { '19': 'receivables' })).toBe('receivables');
    const d = draft(draftFromInvoiceIssued(invoice({ paymentMethodCode: '01' }), { ...ctx, paymentMethodRoles: { '01': 'bank' } }));
    expect(d.lines[0]!.role).toBe('bank');
  });

  it('una venta sin IVA no lleva línea de IVA', () => {
    const d = draft(draftFromInvoiceIssued(invoice({ totalCents: 10000, lines: [{ subtotalCents: 10000, taxes: [{ kind: 'vat', amountCents: 0 }] }] }), ctx));
    expect(d.lines.map((l) => l.role)).toEqual(['receivables', 'sales_revenue']);
  });

  it('suma varias líneas', () => {
    const d = draft(
      draftFromInvoiceIssued(
        invoice({
          totalCents: 17250,
          lines: [
            { subtotalCents: 10000, taxes: [{ kind: 'vat', amountCents: 1500 }] },
            { subtotalCents: 5000, taxes: [{ kind: 'vat', amountCents: 750 }] },
          ],
        }),
        ctx,
      ),
    );
    expect(d.lines.find((l) => l.role === 'sales_revenue')!.creditCents).toBe(15000);
    expect(d.lines.find((l) => l.role === 'vat_payable')!.creditCents).toBe(2250);
  });

  it('la nota de crédito es lo inverso, contra devoluciones en ventas', () => {
    const d = draft(draftFromInvoiceIssued(invoice({ documentTypeCode: '04' }), ctx));
    expect(d.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([
      ['sales_returns', 10000, 0],
      ['vat_payable', 1500, 0],
      ['receivables', 0, 11500],
    ]);
    expect(d.description).toMatch(/^Nota de crédito/);
  });

  it('la nota de débito cobra como una factura pero reconoce el cargo en otros ingresos', () => {
    const d = draft(draftFromInvoiceIssued(invoice({ documentTypeCode: '05', totalCents: 1460, lines: [{ subtotalCents: 1000, taxes: [{ kind: 'vat', amountCents: 0 }] }, { subtotalCents: 400, taxes: [{ kind: 'vat', amountCents: 60 }] }] }), ctx));
    expect(d.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([
      ['receivables', 1460, 0],
      ['other_income', 0, 1400],
      ['vat_payable', 0, 60],
    ]);
    expect(d.description).toMatch(/^Nota de débito/);
    expect(draft(draftFromInvoiceIssued(invoice({ documentTypeCode: '05', paymentMethodCode: '01', totalCents: 1000, lines: [{ subtotalCents: 1000, taxes: [{ kind: 'vat', amountCents: 0 }] }] }), ctx)).lines[0]!.role).toBe('cash');
  });

  it('un comprobante que todavía no tiene regla se ignora', () => {
    for (const code of ['06', '07']) expect(draftFromInvoiceIssued(invoice({ documentTypeCode: code }), ctx).kind).toBe('skip');
  });

  it('lo que no se puede decidir solo queda bloqueado con su motivo', () => {
    const special = draftFromInvoiceIssued(invoice({ lines: [{ subtotalCents: 10000, taxes: [{ kind: 'special', amountCents: 1500 }] }] }), ctx);
    expect(special).toMatchObject({ kind: 'blocked', reasonCode: 'UNMAPPED_TAX_KIND', sourceType: 'invoice', sourceId: 'inv-1' });
    expect(draftFromInvoiceIssued(invoice({ totalCents: 11000 }), ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'UNBALANCED_SOURCE' });
    expect(draftFromInvoiceIssued(invoice({ currencyCode: 'EUR' }), ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'CURRENCY_MISMATCH' });
  });

  it('un comprobante sin importe no genera asiento', () => {
    expect(draftFromInvoiceIssued(invoice({ totalCents: 0, lines: [] }), ctx).kind).toBe('skip');
  });
});

describe('retención emitida', () => {
  const withholding = (over: Record<string, unknown> = {}) => ({
    withholdingId: 'ret-1',
    number: '001-001-000000007',
    issueDate: '2026-10-20T15:00:00.000Z',
    establishmentId: 'est-1',
    currencyCode: 'USD',
    supplier: { identification: '1790012345001', businessName: 'Proveedor Andino' },
    incomeTaxWithheldCents: 100,
    vatWithheldCents: 450,
    isdWithheldCents: 0,
    totalWithheldCents: 550,
    ...over,
  });

  it('baja lo que se le debe al proveedor y sube lo que se debe al fisco, por impuesto', () => {
    const d = draft(draftFromWithholdingIssued(withholding(), ctx));
    expect(d.lines).toEqual([
      { role: 'payables', debitCents: 550, creditCents: 0, establishmentId: 'est-1' },
      { role: 'income_tax_withholding_payable', debitCents: 0, creditCents: 100, establishmentId: 'est-1' },
      { role: 'vat_withholding_payable', debitCents: 0, creditCents: 450, establishmentId: 'est-1' },
    ]);
    expect(d).toMatchObject({ sourceType: 'withholding', sourceId: 'ret-1', entryDate: '2026-10-20', reference: '001-001-000000007' });
    expect(d.description).toBe('Retención 001-001-000000007 — Proveedor Andino');
  });

  it('una retención solo de renta no lleva línea de IVA', () => {
    const d = draft(draftFromWithholdingIssued(withholding({ vatWithheldCents: 0, totalWithheldCents: 100 }), ctx));
    expect(d.lines.map((l) => l.role)).toEqual(['payables', 'income_tax_withholding_payable']);
  });

  it('el ISD, un total que no cuadra o otra moneda quedan bloqueados con su motivo', () => {
    expect(draftFromWithholdingIssued(withholding({ isdWithheldCents: 50, totalWithheldCents: 600 }), ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'UNMAPPED_TAX_KIND', sourceType: 'withholding' });
    expect(draftFromWithholdingIssued(withholding({ totalWithheldCents: 999 }), ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'UNBALANCED_SOURCE' });
    expect(draftFromWithholdingIssued(withholding({ currencyCode: 'EUR' }), ctx)).toMatchObject({ kind: 'blocked', reasonCode: 'CURRENCY_MISMATCH' });
  });

  it('sin importe no genera asiento', () => {
    expect(draftFromWithholdingIssued(withholding({ incomeTaxWithheldCents: 0, vatWithheldCents: 0, totalWithheldCents: 0 }), ctx).kind).toBe('skip');
  });
});

describe('movimientos de inventario', () => {
  const move = (over: Record<string, unknown>) => ({ movementId: 'mov-1', totalCostCents: 6000, currencyCode: 'USD', ...over });

  it('la venta lleva el COSTO (no el precio) a costo de ventas contra inventario', () => {
    const d = draftFromStockMovement('inventory.stock.consumed', move({ type: 'sale_out', accountingNature: 'cogs', referenceType: 'invoice', referenceId: 'inv-1' }), ctx) as PostingDraft;
    expect(d.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([['cogs', 6000, 0], ['inventory', 0, 6000]]);
    expect(d).toMatchObject({ sourceType: 'stock_movement', sourceId: 'mov-1' });
  });

  it('la reposición por anulación de factura es lo inverso', () => {
    const d = draftFromStockMovement('inventory.stock.entered', move({ type: 'adjustment_in', accountingNature: 'inventory_in' }), ctx) as PostingDraft;
    expect(d.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([['inventory', 6000, 0], ['cogs', 0, 6000]]);
  });

  it('el saldo inicial va contra ganancias acumuladas', () => {
    const d = draftFromStockMovement('inventory.stock.entered', move({ type: 'opening_balance', accountingNature: 'inventory_in' }), ctx) as PostingDraft;
    expect(d.lines.map((l) => l.role)).toEqual(['inventory', 'retained_earnings']);
  });

  it('la compra NO se contabiliza aquí (lo hará el módulo de compras contra proveedores)', () => {
    expect(draftFromStockMovement('inventory.stock.entered', move({ type: 'purchase_in', accountingNature: 'inventory_in' }), ctx).kind).toBe('skip');
  });

  it('ajustes: sobrante, merma y uso interno', () => {
    const roles = (nature: string) => (draftFromStockMovement('inventory.stock.adjusted', move({ type: 'adjustment_in', accountingNature: nature }), ctx) as PostingDraft).lines.map((l) => l.role);
    expect(roles('inventory_gain')).toEqual(['inventory', 'inventory_gain']);
    expect(roles('shrinkage')).toEqual(['inventory_shrinkage', 'inventory']);
    expect(roles('expense')).toEqual(['other_expense', 'inventory']);
    expect(draftFromStockMovement('inventory.stock.adjusted', move({ accountingNature: 'internal_transfer' }), ctx).kind).toBe('skip');
  });

  it('sin costo no hay asiento; y la fecha sale del movimiento si la trae', () => {
    expect(draftFromStockMovement('inventory.stock.consumed', move({ type: 'sale_out', totalCostCents: 0 }), ctx).kind).toBe('skip');
    expect(draftFromStockMovement('inventory.stock.consumed', move({ type: 'sale_out', totalCostCents: null }), ctx).kind).toBe('skip');
    const d = draftFromStockMovement('inventory.stock.consumed', move({ type: 'sale_out', occurredAt: '2026-10-22T02:00:00Z' }), ctx) as PostingDraft;
    expect(d.entryDate).toBe('2026-10-21');
  });

  it('los traslados y otros eventos no generan asiento', () => {
    expect(draftFromStockMovement('inventory.stock.transferred', move({}), ctx).kind).toBe('skip');
  });
});
