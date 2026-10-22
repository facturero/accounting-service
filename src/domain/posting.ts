import type { PartyType } from './journal.js';
import type { SystemRole } from './account.js';

/** Payload mínimo de factura de compra contabilizada (purchasing.bill.posted) — vienen centavos y texto. */
export interface PurchaseBillPostedPayload {
  billId: string;
  internalNumber?: string | null;
  supplierId: string;
  supplier: { identification?: string; legalName?: string } | null;
  docType: string;
  supplierDocument: string;
  issueDate?: string | null;
  dueDate?: string | null;
  currencyCode: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  establishmentId?: string | null;
  orderId?: string | null;
  matchStatus: string;
  lines: Array<{
    kind: 'stock' | 'expense';
    productId?: string | null;
    expenseAccountHint?: string | null;
    subtotalCents: number;
    vatCents: number;
    iceCents: number;
    irbpnrCents: number;
    priceVarianceCents: number;
  }>;
}

/** Payload de factura de compra anulada (purchasing.bill.voided). */
export interface PurchaseBillVoidedPayload {
  billId: string;
  reason?: string | null;
}

/** Payload de liquidación de compra autorizada (fiscal.ec.purchase_settlement.issued). */
export interface PurchaseSettlementIssuedPayload {
  documentId: string;
  internalNumber?: string | null;
  supplierId: string;
  supplier: { identification?: string; legalName?: string } | null;
  docType: string;
  supplierDocument: string;
  issueDate?: string | null;
  dueDate?: string | null;
  currencyCode: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  establishmentId?: string | null;
  lines: Array<{
    kind: 'stock' | 'expense';
    productId?: string | null;
    expenseAccountHint?: string | null;
    subtotalCents: number;
    vatCents: number;
    iceCents: number;
    irbpnrCents: number;
    priceVarianceCents: number;
  }>;
}

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

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fecha local `YYYY-MM-DD` de un instante en una zona horaria: una venta a las 20:00 en Guayaquil ya es «mañana» en UTC.
 *
 * Una fecha SIN hora (`2026-10-20`: la que mandan compras y fiscal en `issueDate`) ya ES una fecha local: no se convierte. Pasarla
 * por `new Date()` la toma como medianoche UTC y en Guayaquil (UTC-5) sale el día ANTERIOR: el asiento caía un día antes (en otro
 * periodo si era el 1.º de mes) y el filtro de `auto_posting_from` lo descartaba. Las pruebas usaban marcas de tiempo completas
 * y no lo vieron; apareció al levantar la pila completa.
 */
export function localDateOf(instant: string | Date, timeZone: string): string {
  if (typeof instant === 'string' && DATE_ONLY.test(instant)) {
    if (Number.isNaN(new Date(`${instant}T00:00:00Z`).getTime())) throw new Error(`fecha inválida: ${instant}`);
    return instant;
  }
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

// ── Factura de compra (purchasing.bill.posted) ────────────────────────────────

/**
 * Factura de compra contabilizada (doc_type 01 y 03 ya autorizada).
 *
 * - Cr `payables` por el TOTAL de la factura (con el proveedor como tercero: `party`).
 * - Dr `inventory` por el subtotal de las líneas `stock` (más ICE/IRBPNR si forman parte del costo; IVA crédito NO va al costo por defecto).
 * - Dr `other_expense` (o la cuenta indicada por `expenseAccountHint` si existe, es de detalle y activa; si no, el rol por defecto) por las líneas `expense`.
 * - Dr `vat_credit` por el IVA de la factura SOLO si la organización puede usar crédito tributario; por defecto sí.
 * - Diferencia de precio de compra (`priceVarianceCents ≠ 0` en líneas `stock` aprobadas con override): lleva la diferencia al rol `purchase_price_variance` (Dr si la factura costó más, Cr si costó menos) EN LUGAR de al inventario.
 * - Cuadre: Σ débitos = Σ créditos por construcción; si no, `UNBALANCED_SOURCE`.
 * - Moneda ≠ base → `CURRENCY_MISMATCH` (pendiente). Rol sin cuenta → queda en "Pendientes".
 * - Idempotente: `sourceType: 'purchase_bill'`, `sourceId: billId`.
 *
 * NOTA: las líneas de servicio o sin stock se pueden "recibir" (cuentan para cerrar la orden) pero inventario las ignora; aquí también ignoramos `kind !== 'stock'` para el Dr inventory.
 * DECISIÓN: el asiento nace de `fiscal.ec.purchase_settlement.issued` para liquidaciones (docType 03); `purchasing.bill.posted` ignora `docType === '03'` para no duplicar.
 */
export function draftFromPurchaseBillPosted(p: PurchaseBillPostedPayload, ctx: RuleContext): PostingRuleResult {
  const sourceType = 'purchase_bill';
  const blocked = (reasonCode: string, message: string): PostingBlocked => ({ kind: 'blocked', reasonCode, message, sourceType, sourceId: p.billId });

  // Ignorar liquidaciones (docType 03): su asiento nace de fiscal.ec.purchase_settlement.issued
  if (p.docType === '03') return { kind: 'skip', reason: 'liquidación de compra se contabiliza desde fiscal.ec.purchase_settlement.issued' };

  if ((p.currencyCode ?? ctx.baseCurrency) !== ctx.baseCurrency) {
    return blocked('CURRENCY_MISMATCH', `La factura de compra está en ${p.currencyCode} y la contabilidad lleva ${ctx.baseCurrency}.`);
  }
  const total = asCents(p.totalCents);
  if (total <= 0) return { kind: 'skip', reason: 'factura de compra sin importe' };

  // Validar cuadre: total = subtotal + tax + ice + irbpnr (aprox, tolerancia 1 centavo por redondeo de proveedor)
  const linesSubtotal = p.lines.reduce((sum, l) => sum + asCents(l.subtotalCents), 0);
  const linesTax = p.lines.reduce((sum, l) => sum + asCents(l.vatCents) + asCents(l.iceCents) + asCents(l.irbpnrCents), 0);
  if (Math.abs(total - (linesSubtotal + linesTax)) > 1) {
    return blocked('UNBALANCED_SOURCE', `Total factura (${total}) ≠ subtotal+impuestos (${linesSubtotal + linesTax}) en centavos.`);
  }

  const est = p.establishmentId ?? null;
  const party = { partyType: 'supplier' as const, partyId: p.supplierId };

  const lines: DraftLine[] = [];

  // 1) Cr payables por el TOTAL (con proveedor como tercero)
  lines.push({ role: 'payables', debitCents: 0, creditCents: total, establishmentId: est, ...party });

  // 2) Dr inventory por líneas stock (subtotal + ICE/IRBPNR; IVA NO va al costo).
  //    Con una variación de precio aprobada (override) el inventario entra al costo de la ORDEN y la
  //    diferencia se lleva a purchase_price_variance (paso 5): al inventario va `costo − variación`.
  let inventorySubtotal = 0;
  for (const line of p.lines) {
    if (line.kind !== 'stock') continue;
    const lineCost = asCents(line.subtotalCents) + asCents(line.iceCents) + asCents(line.irbpnrCents);
    const toInventory = lineCost - asCents(line.priceVarianceCents);
    if (toInventory > 0) inventorySubtotal += toInventory;
  }
  if (inventorySubtotal > 0) lines.push({ role: 'inventory', debitCents: inventorySubtotal, creditCents: 0, establishmentId: est });

  // 3) Dr other_expense (o expenseAccountHint si existe y es detalle/activa) por líneas expense
  for (const line of p.lines) {
    if (line.kind !== 'expense') continue;
    const expSub = asCents(line.subtotalCents);
    const expIce = asCents(line.iceCents);
    const expIrbpnr = asCents(line.irbpnrCents);
    const expCost = expSub + expIce + expIrbpnr;
    if (expCost > 0) {
      // Si hay expenseAccountHint, se resolvería en automatic-posting si existe una cuenta con ese hint y está activa;
      // por simplicidad usamos other_expense (rol por defecto). El hint se guarda en la descripción.
      const desc = line.expenseAccountHint ? ` (cuenta sugerida: ${line.expenseAccountHint})` : '';
      lines.push({ role: 'other_expense', debitCents: expCost, creditCents: 0, description: desc.slice(0, 255), establishmentId: null });
    }
  }

  // 4) Dr vat_credit por el IVA (crédito tributario) — solo si la org puede usarlo; por defecto sí
  const totalVat = p.lines.reduce((sum, l) => sum + asCents(l.vatCents), 0);
  if (totalVat > 0) lines.push({ role: 'vat_credit', debitCents: totalVat, creditCents: 0, establishmentId: est });

  // 5) purchase_price_variance por líneas stock con priceVarianceCents ≠ 0 (override aprobado)
  for (const line of p.lines) {
    if (line.kind !== 'stock') continue;
    const pv = asCents(line.priceVarianceCents);
    if (pv === 0) continue;
    // Dr si factura costó más (pv > 0), Cr si costó menos (pv < 0)
    if (pv > 0) {
      lines.push({ role: 'purchase_price_variance', debitCents: pv, creditCents: 0, establishmentId: est });
    } else {
      lines.push({ role: 'purchase_price_variance', debitCents: 0, creditCents: -pv, establishmentId: est });
    }
  }

  const number = p.internalNumber ?? p.billId;
  const supplierName = p.supplier?.legalName ?? '';

  // Guardia de cuadre: si algo no suma, mejor un pendiente visible que un asiento descuadrado.
  const debitTotal = lines.reduce((sum, l) => sum + asCents(l.debitCents), 0);
  const creditTotal = lines.reduce((sum, l) => sum + asCents(l.creditCents), 0);
  if (debitTotal !== creditTotal) {
    return blocked('UNBALANCED_SOURCE', `El asiento de la factura de compra no cuadra: débitos ${debitTotal} ≠ créditos ${creditTotal} en centavos.`);
  }

  return {
    kind: 'draft',
    entryDate: localDateOf(p.issueDate ?? ctx.now, ctx.timeZone),
    description: `Factura de compra ${number}${supplierName ? ` — ${supplierName}` : ''}`.slice(0, 255),
    reference: String(number).slice(0, 60),
    sourceType,
    sourceId: p.billId,
    currencyCode: ctx.baseCurrency,
    lines,
  };
}

// ── Liquidación de compra autorizada (fiscal.ec.purchase_settlement.issued) ───

/**
 * Liquidación de compra autorizada (codDoc 03): mismo asiento que una factura de compra.
 * Para no duplicar con purchasing.bill.posted de una liquidación: el asiento nace de ESTE evento
 * (autorizado = existe legalmente) y purchasing.bill.posted ignora docType '03'.
 */
export function draftFromPurchaseSettlementIssued(p: PurchaseSettlementIssuedPayload, ctx: RuleContext): PostingRuleResult {
  const sourceType = 'purchase_settlement';
  const blocked = (reasonCode: string, message: string): PostingBlocked => ({ kind: 'blocked', reasonCode, message, sourceType, sourceId: p.documentId });

  if ((p.currencyCode ?? ctx.baseCurrency) !== ctx.baseCurrency) {
    return blocked('CURRENCY_MISMATCH', `La liquidación está en ${p.currencyCode} y la contabilidad lleva ${ctx.baseCurrency}.`);
  }
  const total = asCents(p.totalCents);
  if (total <= 0) return { kind: 'skip', reason: 'liquidación sin importe' };

  const linesSubtotal = p.lines.reduce((sum, l) => sum + asCents(l.subtotalCents), 0);
  const linesTax = p.lines.reduce((sum, l) => sum + asCents(l.vatCents) + asCents(l.iceCents) + asCents(l.irbpnrCents), 0);
  if (Math.abs(total - (linesSubtotal + linesTax)) > 1) {
    return blocked('UNBALANCED_SOURCE', `Total liquidación (${total}) ≠ subtotal+impuestos (${linesSubtotal + linesTax}) en centavos.`);
  }

  const est = p.establishmentId ?? null;
  const party = { partyType: 'supplier' as const, partyId: p.supplierId };

  const lines: DraftLine[] = [];

  // 1) Cr payables por el TOTAL
  lines.push({ role: 'payables', debitCents: 0, creditCents: total, establishmentId: est, ...party });

  // 2) Dr inventory por líneas stock (subtotal + ICE/IRBPNR; IVA NO al costo). Igual que en la factura
  //    de compra: el inventario va al costo estándar y la variación de precio aparte.
  let inventorySubtotal = 0;
  for (const line of p.lines) {
    if (line.kind !== 'stock') continue;
    const lineCost = asCents(line.subtotalCents) + asCents(line.iceCents) + asCents(line.irbpnrCents);
    const toInventory = lineCost - asCents(line.priceVarianceCents);
    if (toInventory > 0) inventorySubtotal += toInventory;
  }
  if (inventorySubtotal > 0) lines.push({ role: 'inventory', debitCents: inventorySubtotal, creditCents: 0, establishmentId: est });

  // 3) Dr other_expense por líneas expense
  for (const line of p.lines) {
    if (line.kind !== 'expense') continue;
    const expSub = asCents(line.subtotalCents);
    const expIce = asCents(line.iceCents);
    const expIrbpnr = asCents(line.irbpnrCents);
    const expCost = expSub + expIce + expIrbpnr;
    if (expCost > 0) {
      const desc = line.expenseAccountHint ? ` (cuenta sugerida: ${line.expenseAccountHint})` : '';
      lines.push({ role: 'other_expense', debitCents: expCost, creditCents: 0, description: desc.slice(0, 255), establishmentId: null });
    }
  }

  // 4) Dr vat_credit por el IVA
  const totalVat = p.lines.reduce((sum, l) => sum + asCents(l.vatCents), 0);
  if (totalVat > 0) lines.push({ role: 'vat_credit', debitCents: totalVat, creditCents: 0, establishmentId: est });

  // 5) purchase_price_variance
  for (const line of p.lines) {
    if (line.kind !== 'stock') continue;
    const pv = asCents(line.priceVarianceCents);
    if (pv === 0) continue;
    if (pv > 0) {
      lines.push({ role: 'purchase_price_variance', debitCents: pv, creditCents: 0, establishmentId: est });
    } else {
      lines.push({ role: 'purchase_price_variance', debitCents: 0, creditCents: -pv, establishmentId: est });
    }
  }

  const number = p.internalNumber ?? p.documentId;
  const supplierName = p.supplier?.legalName ?? '';

  // Guardia de cuadre, igual que en la factura de compra.
  const debitTotal = lines.reduce((sum, l) => sum + asCents(l.debitCents), 0);
  const creditTotal = lines.reduce((sum, l) => sum + asCents(l.creditCents), 0);
  if (debitTotal !== creditTotal) {
    return blocked('UNBALANCED_SOURCE', `El asiento de la liquidación no cuadra: débitos ${debitTotal} ≠ créditos ${creditTotal} en centavos.`);
  }

  return {
    kind: 'draft',
    entryDate: localDateOf(p.issueDate ?? ctx.now, ctx.timeZone),
    description: `Liquidación de compra ${number}${supplierName ? ` — ${supplierName}` : ''}`.slice(0, 255),
    reference: String(number).slice(0, 60),
    sourceType,
    sourceId: p.documentId,
    currencyCode: ctx.baseCurrency,
    lines,
  };
}

// ── Cobros a clientes (tesorería) ───────────────────────────────────────────

/** Payload de `treasury.receipt.posted`: lo que entró, lo que se aplicó y a dónde. Importes en centavos; `receiptDate` es `AAAA-MM-DD`. */
export interface ReceiptPostedPayload {
  receiptId: string;
  number?: string | null;
  receiptDate: string;
  customerId?: string | null;
  customerName?: string | null;
  currencyCode?: string;
  /** Rol contable que recibe el dinero. */
  accountRole?: string;
  /** Lo que entró a caja o banco. */
  totalCents: number;
  /** De anticipos anteriores del cliente que el cobro consume (no entra dinero). */
  advanceUsedCents?: number;
  /** Lo aplicado a deudas. */
  appliedCents: number;
  /** Excedente: queda como anticipo nuevo del cliente. */
  advanceCents?: number;
  establishmentId?: string | null;
}

/**
 * Cobro a un cliente contabilizado por tesorería:
 *
 *     Dr Caja o Bancos (según `accountRole`)       lo que entró
 *     Dr Anticipos de clientes                     lo que se consume de anticipos anteriores
 *     Cr Cuentas por cobrar (cliente)              lo aplicado a deudas
 *     Cr Anticipos de clientes (cliente)           el excedente
 *
 * El dinero que entra y los anticipos que se consumen suman lo mismo que lo aplicado y el excedente (la igualdad la fija un CHECK en
 * tesorería): si el evento llegara descuadrado se aparta como pendiente en vez de asentarse mal. El cliente va como tercero en las
 * líneas de cuentas por cobrar y de anticipos: es lo que permite cuadrar el submayor de tesorería con el libro mayor POR CLIENTE.
 * La factura NO se asienta otra vez: su asiento lo hizo `billing.invoice.issued`.
 */
export function draftFromReceiptPosted(p: ReceiptPostedPayload, ctx: RuleContext): PostingRuleResult {
  const sourceType = 'receipt';
  const blocked = (reasonCode: string, message: string): PostingBlocked => ({ kind: 'blocked', reasonCode, message, sourceType, sourceId: p.receiptId });

  if ((p.currencyCode ?? ctx.baseCurrency) !== ctx.baseCurrency) {
    return blocked('CURRENCY_MISMATCH', `El cobro está en ${p.currencyCode} y la contabilidad lleva ${ctx.baseCurrency}.`);
  }
  const cash = asCents(p.totalCents);
  const used = asCents(p.advanceUsedCents);
  const applied = asCents(p.appliedCents);
  const advance = asCents(p.advanceCents);
  if (cash + used <= 0) return { kind: 'skip', reason: 'cobro sin importe' };
  if (cash + used !== applied + advance) {
    return blocked('UNBALANCED_SOURCE', `Lo cobrado más los anticipos (${cash + used}) no coincide con lo aplicado más el excedente (${applied + advance}), en centavos.`);
  }
  const role = p.accountRole ?? 'cash';
  if (role !== 'cash' && role !== 'bank') return blocked('UNMAPPED_COLLECTION_ROLE', `El cobro llega a «${role}», que no es caja ni bancos.`);

  const party = p.customerId ? { partyType: 'customer' as const, partyId: p.customerId } : {};
  const est = p.establishmentId ?? null;
  const lines: DraftLine[] = [];
  if (cash > 0) lines.push({ role, debitCents: cash, creditCents: 0, establishmentId: est });
  if (used > 0) lines.push({ role: 'customer_advances', debitCents: used, creditCents: 0, establishmentId: est, ...party });
  if (applied > 0) lines.push({ role: 'receivables', debitCents: 0, creditCents: applied, establishmentId: est, ...party });
  if (advance > 0) lines.push({ role: 'customer_advances', debitCents: 0, creditCents: advance, establishmentId: est, ...party });

  const number = p.number ?? p.receiptId;
  const customer = p.customerName ?? '';
  return {
    kind: 'draft',
    // `receiptDate` ya es una fecha de calendario: NO se convierte por UTC (en Guayaquil saldría el día anterior y no se asentaría).
    entryDate: localDateOf(p.receiptDate ?? ctx.now, ctx.timeZone),
    description: `Cobro ${number}${customer ? ` — ${customer}` : ''}`.slice(0, 255),
    reference: String(number).slice(0, 60),
    sourceType,
    sourceId: p.receiptId,
    currencyCode: ctx.baseCurrency,
    lines,
  };
}

// ── Pagos a proveedores (tesorería) ─────────────────────────────────────────

/** Payload de `treasury.payment.posted`: lo que salió, lo que se aplicó y de dónde. Importes en centavos; `paymentDate` es `AAAA-MM-DD`. */
export interface PaymentPostedPayload {
  paymentId: string;
  number?: string | null;
  paymentDate: string;
  supplierId?: string | null;
  supplierName?: string | null;
  currencyCode?: string;
  /** Rol contable de donde sale el dinero. */
  accountRole?: string;
  /** Lo que salió de caja o banco. */
  totalCents: number;
  /** De anticipos anteriores a proveedores que el pago consume (no sale dinero). */
  advanceUsedCents?: number;
  /** Lo aplicado a facturas. */
  appliedCents: number;
  /** Excedente: queda como anticipo a proveedores. */
  advanceCents?: number;
  establishmentId?: string | null;
}

/**
 * Pago a un proveedor contabilizado por tesorería (espejo del cobro):
 *
 *     Dr Proveedores (proveedor)                 lo aplicado a facturas
 *     Dr Anticipos a proveedores (proveedor)     el excedente
 *     Cr Caja o Bancos (según `accountRole`)     lo que salió
 *     Cr Anticipos a proveedores (proveedor)     lo que se consume de anticipos anteriores
 *
 * El dinero que sale y los anticipos que se consumen suman lo mismo que lo aplicado y el excedente (la igualdad la fija un CHECK en
 * tesorería): si el evento llegara descuadrado se aparta como pendiente en vez de asentarse mal. El proveedor va como tercero en las líneas
 * de proveedores y de anticipos: es lo que permite cuadrar el submayor de tesorería con el libro mayor POR PROVEEDOR. La factura de compra
 * NO se asienta otra vez: su asiento lo hizo `purchasing.bill.posted`.
 */
export function draftFromPaymentPosted(p: PaymentPostedPayload, ctx: RuleContext): PostingRuleResult {
  const sourceType = 'payment';
  const blocked = (reasonCode: string, message: string): PostingBlocked => ({ kind: 'blocked', reasonCode, message, sourceType, sourceId: p.paymentId });

  if ((p.currencyCode ?? ctx.baseCurrency) !== ctx.baseCurrency) {
    return blocked('CURRENCY_MISMATCH', `El pago está en ${p.currencyCode} y la contabilidad lleva ${ctx.baseCurrency}.`);
  }
  const cash = asCents(p.totalCents);
  const used = asCents(p.advanceUsedCents);
  const applied = asCents(p.appliedCents);
  const advance = asCents(p.advanceCents);
  if (cash + used <= 0) return { kind: 'skip', reason: 'pago sin importe' };
  if (cash + used !== applied + advance) {
    return blocked('UNBALANCED_SOURCE', `Lo pagado más los anticipos (${cash + used}) no coincide con lo aplicado más el excedente (${applied + advance}), en centavos.`);
  }
  const role = p.accountRole ?? 'bank';
  if (role !== 'cash' && role !== 'bank') return blocked('UNMAPPED_COLLECTION_ROLE', `El pago sale de «${role}», que no es caja ni bancos.`);

  const party = p.supplierId ? { partyType: 'supplier' as const, partyId: p.supplierId } : {};
  const est = p.establishmentId ?? null;
  const lines: DraftLine[] = [];
  if (applied > 0) lines.push({ role: 'payables', debitCents: applied, creditCents: 0, establishmentId: est, ...party });
  if (advance > 0) lines.push({ role: 'supplier_advances', debitCents: advance, creditCents: 0, establishmentId: est, ...party });
  if (cash > 0) lines.push({ role, debitCents: 0, creditCents: cash, establishmentId: est });
  if (used > 0) lines.push({ role: 'supplier_advances', debitCents: 0, creditCents: used, establishmentId: est, ...party });

  const number = p.number ?? p.paymentId;
  const supplier = p.supplierName ?? '';
  return {
    kind: 'draft',
    // `paymentDate` ya es una fecha de calendario: NO se convierte por UTC (en Guayaquil saldría el día anterior y no se asentaría).
    entryDate: localDateOf(p.paymentDate ?? ctx.now, ctx.timeZone),
    description: `Pago ${number}${supplier ? ` — ${supplier}` : ''}`.slice(0, 255),
    reference: String(number).slice(0, 60),
    sourceType,
    sourceId: p.paymentId,
    currencyCode: ctx.baseCurrency,
    lines,
  };
}
