import type { PartyType } from './journal.js';
import type { SystemRole } from './account.js';

/**
 * Reglas de contabilización: de un evento de otro servicio a las líneas de un asiento. Son funciones PURAS (sin base de datos):
 * devuelven qué cuenta —por ROL— va al debe y cuál al haber, y los importes. Resolver el rol a una cuenta concreta y escribir el
 * asiento lo hace el caso de uso (`automatic-posting.ts`).
 *
 * Es el equivalente a la «determinación de cuentas» de SAP: la regla no conoce códigos de cuenta, solo roles (`receivables`,
 * `vat_payable`, `cogs`…); la organización decide qué cuenta lleva cada rol (`PATCH /accounting/accounts/:id`).
 */

export type DraftLine = {
  role: SystemRole;
  debitCents: number;
  creditCents: number;
  description?: string;
  partyType?: PartyType;
  partyId?: string;
  establishmentId?: string | null;
};

export interface PostingDraft {
  kind: 'draft';
  /** Fecha contable (local de la organización). */
  entryDate: string;
  description: string;
  reference: string | null;
  sourceType: string;
  sourceId: string;
  currencyCode: string;
  lines: DraftLine[];
}

/** El evento no genera asiento (no es de su incumbencia, o no hay importe). */
export interface PostingSkip {
  kind: 'skip';
  reason: string;
}

/** El evento sí debería generar asiento pero no se puede decidir solo: queda pendiente para que una persona lo resuelva. */
export interface PostingBlocked {
  kind: 'blocked';
  reasonCode: string;
  message: string;
  sourceType: string;
  sourceId: string;
}

export type PostingRuleResult = PostingDraft | PostingSkip | PostingBlocked;

/** Códigos de forma de pago del SRI. Con una forma de pago el cobro es inmediato; sin ella, la venta queda por cobrar. */
export type CollectionRole = 'cash' | 'bank' | 'receivables';
export const COLLECTION_ROLES: readonly CollectionRole[] = ['cash', 'bank', 'receivables'];

/**
 * 01 sin utilización del sistema financiero (efectivo) → caja; 16 débito, 17 dinero electrónico, 18 prepago, 19 crédito y 20 otros
 * con utilización del sistema financiero → bancos; el resto (15 compensación, 21 endoso…) o ninguna → por cobrar.
 */
export const DEFAULT_PAYMENT_METHOD_ROLES: Readonly<Record<string, CollectionRole>> = {
  '01': 'cash',
  '16': 'bank',
  '17': 'bank',
  '18': 'bank',
  '19': 'bank',
  '20': 'bank',
};

export function collectionRoleFor(code: string | null | undefined, overrides: Record<string, CollectionRole> | null): CollectionRole {
  if (!code) return 'receivables';
  return overrides?.[code] ?? DEFAULT_PAYMENT_METHOD_ROLES[code] ?? 'receivables';
}

/** Fecha local `YYYY-MM-DD` de un instante en una zona horaria: una venta a las 20:00 en Guayaquil ya es «mañana» en UTC. */
export function localDateOf(instant: string | Date, timeZone: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new Error(`fecha inválida: ${String(instant)}`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface RuleContext {
  baseCurrency: string;
  timeZone: string;
  paymentMethodRoles: Record<string, CollectionRole> | null;
  now: Date;
}

const asCents = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0);

// ── Facturas y notas de crédito ─────────────────────────────────────────────

export interface InvoiceIssuedPayload {
  invoiceId: string;
  number?: string | null;
  issueDate?: string | null;
  documentTypeCode?: string;
  establishmentId?: string | null;
  customerSnapshot?: { id?: string; businessName?: string } | null;
  totalCents: number;
  currencyCode?: string;
  paymentMethodCode?: string | null;
  relatedInvoiceId?: string;
  lines?: { subtotalCents: number; taxes?: { kind: string; amountCents: number }[] }[];
}

/**
 * Factura (`01`): el cliente (o la caja/banco si se cobró) debe el total; se reconoce la venta y el IVA por pagar.
 * Nota de crédito (`04`): lo inverso, contra la cuenta de devoluciones y descuentos en ventas.
 * Nota de débito (`05`): cargos que se suman a una factura (intereses de mora, gastos de cobranza): igual que la factura, pero lo
 * cobrado de más se reconoce en `other_income` (otros ingresos), no en ventas.
 * La guía de remisión y la retención no pasan por billing; las demás clases de comprobante se ignoran.
 */
export function draftFromInvoiceIssued(p: InvoiceIssuedPayload, ctx: RuleContext): PostingRuleResult {
  const doc = p.documentTypeCode ?? '01';
  if (doc !== '01' && doc !== '04' && doc !== '05') return { kind: 'skip', reason: `comprobante ${doc} sin regla` };

  const sourceType = 'invoice';
  const blocked = (reasonCode: string, message: string): PostingBlocked => ({ kind: 'blocked', reasonCode, message, sourceType, sourceId: p.invoiceId });

  if ((p.currencyCode ?? ctx.baseCurrency) !== ctx.baseCurrency) {
    return blocked('CURRENCY_MISMATCH', `El comprobante está en ${p.currencyCode} y la contabilidad lleva ${ctx.baseCurrency}.`);
  }
  const total = asCents(p.totalCents);
  if (total <= 0) return { kind: 'skip', reason: 'comprobante sin importe' };

  let revenue = 0;
  let vat = 0;
  for (const line of p.lines ?? []) {
    revenue += asCents(line.subtotalCents);
    for (const tax of line.taxes ?? []) {
      if (tax.kind !== 'vat') {
        return blocked('UNMAPPED_TAX_KIND', `El comprobante lleva un impuesto «${tax.kind}» que todavía no tiene cuenta asignada.`);
      }
      vat += asCents(tax.amountCents);
    }
  }
  if (revenue + vat !== total) {
    return blocked('UNBALANCED_SOURCE', `El total del comprobante (${total}) no coincide con ventas + IVA (${revenue + vat}), en centavos.`);
  }

  const isCredit = doc === '04';
  const collection = collectionRoleFor(p.paymentMethodCode, ctx.paymentMethodRoles);
  const customerName = p.customerSnapshot?.businessName ?? '';
  const party = p.customerSnapshot?.id ? { partyType: 'customer' as const, partyId: p.customerSnapshot.id } : {};
  const est = p.establishmentId ?? null;
  const number = p.number ?? p.invoiceId;

  const lines: DraftLine[] = [];
  if (!isCredit) {
    lines.push({ role: collection, debitCents: total, creditCents: 0, establishmentId: est, ...party });
    lines.push({ role: doc === '05' ? 'other_income' : 'sales_revenue', debitCents: 0, creditCents: revenue, establishmentId: est });
    if (vat > 0) lines.push({ role: 'vat_payable', debitCents: 0, creditCents: vat, establishmentId: est });
  } else {
    lines.push({ role: 'sales_returns', debitCents: revenue, creditCents: 0, establishmentId: est });
    if (vat > 0) lines.push({ role: 'vat_payable', debitCents: vat, creditCents: 0, establishmentId: est });
    lines.push({ role: collection, debitCents: 0, creditCents: total, establishmentId: est, ...party });
  }

  return {
    kind: 'draft',
    entryDate: localDateOf(p.issueDate ?? ctx.now, ctx.timeZone),
    description: `${isCredit ? 'Nota de crédito' : doc === '05' ? 'Nota de débito' : 'Factura'} ${number}${customerName ? ` — ${customerName}` : ''}`.slice(0, 255),
    reference: String(number).slice(0, 60),
    sourceType,
    sourceId: p.invoiceId,
    currencyCode: ctx.baseCurrency,
    lines,
  };
}

// ── Retenciones emitidas ────────────────────────────────────────────────────

export interface WithholdingIssuedPayload {
  withholdingId: string;
  number?: string | null;
  issueDate?: string | null;
  establishmentId?: string | null;
  currencyCode?: string;
  supplier?: { identification?: string; businessName?: string } | null;
  incomeTaxWithheldCents?: number;
  vatWithheldCents?: number;
  isdWithheldCents?: number;
  totalWithheldCents: number;
}

/**
 * Retención que LA EMPRESA hizo a un proveedor y el SRI autorizó: lo retenido ya no se le debe al proveedor (baja de `payables`)
 * sino al fisco (sube `income_tax_withholding_payable` / `vat_withholding_payable`):
 *
 *     Dr Proveedores                        total retenido
 *     Cr Retenciones en la fuente por pagar   renta
 *     Cr Retenciones de IVA por pagar         IVA
 *
 * Supone que la COMPRA ya está en proveedores (módulo de compras, Fase 2, o un asiento manual): sin ella el saldo del proveedor
 * queda transitoriamente deudor. El ISD no tiene cuenta propia todavía: se aparta como pendiente en vez de asentarlo mal.
 */
export function draftFromWithholdingIssued(p: WithholdingIssuedPayload, ctx: RuleContext): PostingRuleResult {
  const sourceType = 'withholding';
  const blocked = (reasonCode: string, message: string): PostingBlocked => ({ kind: 'blocked', reasonCode, message, sourceType, sourceId: p.withholdingId });

  if ((p.currencyCode ?? ctx.baseCurrency) !== ctx.baseCurrency) {
    return blocked('CURRENCY_MISMATCH', `La retención está en ${p.currencyCode} y la contabilidad lleva ${ctx.baseCurrency}.`);
  }
  const total = asCents(p.totalWithheldCents);
  if (total <= 0) return { kind: 'skip', reason: 'retención sin importe' };

  const income = asCents(p.incomeTaxWithheldCents);
  const vat = asCents(p.vatWithheldCents);
  const isd = asCents(p.isdWithheldCents);
  if (isd > 0) return blocked('UNMAPPED_TAX_KIND', 'La retención incluye ISD, que todavía no tiene cuenta asignada.');
  if (income + vat !== total) {
    return blocked('UNBALANCED_SOURCE', `El total retenido (${total}) no coincide con renta + IVA (${income + vat}), en centavos.`);
  }

  const est = p.establishmentId ?? null;
  const lines: DraftLine[] = [{ role: 'payables', debitCents: total, creditCents: 0, establishmentId: est }];
  if (income > 0) lines.push({ role: 'income_tax_withholding_payable', debitCents: 0, creditCents: income, establishmentId: est });
  if (vat > 0) lines.push({ role: 'vat_withholding_payable', debitCents: 0, creditCents: vat, establishmentId: est });

  const number = p.number ?? p.withholdingId;
  const supplier = p.supplier?.businessName ?? '';
  return {
    kind: 'draft',
    entryDate: localDateOf(p.issueDate ?? ctx.now, ctx.timeZone),
    description: `Retención ${number}${supplier ? ` — ${supplier}` : ''}`.slice(0, 255),
    reference: String(number).slice(0, 60),
    sourceType,
    sourceId: p.withholdingId,
    currencyCode: ctx.baseCurrency,
    lines,
  };
}

// ── Inventario ──────────────────────────────────────────────────────────────

export interface StockMovementPayload {
  movementId: string;
  type: string;
  totalCostCents?: number | null;
  currencyCode?: string;
  referenceType?: string | null;
  referenceId?: string | null;
  accountingNature?: string | null;
  reasonCode?: string | null;
  occurredAt?: string | null;
}

/**
 * Movimientos del kardex:
 *  - venta (`consumed`, `sale_out`): costo de ventas contra inventario, por lo que costó la mercadería (no por el precio de venta);
 *  - reposición por anulación de factura (`entered`, `adjustment_in` con naturaleza `inventory_in`): lo inverso;
 *  - saldo inicial (`entered`, `opening_balance`): inventario contra ganancias acumuladas;
 *  - ajustes (`adjusted`): sobrante → ganancia por ajuste; faltante → mermas; uso interno → otros gastos.
 *  - COMPRA (`purchase_in`): NO se contabiliza aquí; la contabiliza el módulo de compras con la factura del proveedor (Fase 2),
 *    contra proveedores. Hacerlo aquí duplicaría el inventario.
 *  - traslados entre bodegas: no cambian el inventario total.
 */
export function draftFromStockMovement(eventType: string, p: StockMovementPayload, ctx: RuleContext): PostingRuleResult {
  const sourceType = 'stock_movement';
  const cost = asCents(p.totalCostCents);
  if (cost <= 0) return { kind: 'skip', reason: 'movimiento sin costo' };
  if ((p.currencyCode ?? ctx.baseCurrency) !== ctx.baseCurrency) {
    return { kind: 'blocked', reasonCode: 'CURRENCY_MISMATCH', message: `El movimiento está en ${p.currencyCode} y la contabilidad lleva ${ctx.baseCurrency}.`, sourceType, sourceId: p.movementId };
  }

  let debit: SystemRole | null = null;
  let credit: SystemRole | null = null;
  let what = '';

  if (eventType === 'inventory.stock.consumed' && p.type === 'sale_out') {
    debit = 'cogs';
    credit = 'inventory';
    what = 'Costo de ventas';
  } else if (eventType === 'inventory.stock.entered') {
    if (p.type === 'opening_balance') {
      debit = 'inventory';
      credit = 'retained_earnings';
      what = 'Saldo inicial de inventario';
    } else if (p.type === 'adjustment_in' && p.accountingNature === 'inventory_in') {
      debit = 'inventory';
      credit = 'cogs';
      what = 'Reposición de inventario por anulación';
    } else {
      return { kind: 'skip', reason: `entrada ${p.type} sin regla` };
    }
  } else if (eventType === 'inventory.stock.adjusted') {
    switch (p.accountingNature) {
      case 'inventory_gain':
        debit = 'inventory';
        credit = 'inventory_gain';
        what = 'Sobrante de inventario';
        break;
      case 'shrinkage':
        debit = 'inventory_shrinkage';
        credit = 'inventory';
        what = 'Merma de inventario';
        break;
      case 'expense':
        debit = 'other_expense';
        credit = 'inventory';
        what = 'Uso interno de inventario';
        break;
      default:
        return { kind: 'skip', reason: `ajuste con naturaleza ${p.accountingNature} sin regla` };
    }
  } else {
    return { kind: 'skip', reason: `${eventType} sin regla` };
  }

  const ref = p.referenceType === 'invoice' && p.referenceId ? ` — factura ${p.referenceId}` : p.reasonCode ? ` — ${p.reasonCode}` : '';
  return {
    kind: 'draft',
    entryDate: localDateOf(p.occurredAt ?? ctx.now, ctx.timeZone),
    description: `${what}${ref}`.slice(0, 255),
    reference: null,
    sourceType,
    sourceId: p.movementId,
    currencyCode: ctx.baseCurrency,
    lines: [
      { role: debit, debitCents: cost, creditCents: 0 },
      { role: credit, debitCents: 0, creditCents: cost },
    ],
  };
}
