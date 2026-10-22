import { randomUUID } from 'node:crypto';
import { AppError } from '../../domain/errors.js';
import { JournalEntry, type JournalLineInput } from '../../domain/journal.js';
import {
  draftFromInvoiceIssued,
  draftFromPurchaseBillPosted,
  draftFromPurchaseSettlementIssued,
  draftFromBankAdjustmentPosted,
  draftFromPaymentPosted,
  draftFromReceiptPosted,
  draftFromStockMovement,
  draftFromWithholdingIssued,
  localDateOf,
  type InvoiceIssuedPayload,
  type PostingDraft,
  type PurchaseBillPostedPayload,
  type PurchaseSettlementIssuedPayload,
  type BankAdjustmentPostedPayload,
  type PaymentPostedPayload,
  type ReceiptPostedPayload,
  type RuleContext,
  type StockMovementPayload,
  type WithholdingIssuedPayload,
} from '../../domain/posting.js';
import type { Account } from '../../domain/account.js';
import type { AccountingSettings, PendingPosting, UnitOfWork } from '../../domain/repositories.js';
import { journalEntryReversedEvent, postingPendingEvent, postingResolvedEvent } from '../events.js';
import type { Clock, UnitOfWorkGateway, WriteUnitOfWork } from '../ports.js';
import { postEntryInTransaction } from './journal-use-cases.js';

/** Eventos de otros servicios que generan asientos. */
export const POSTING_EVENT_TYPES = [
  'billing.invoice.issued',
  'billing.invoice.voided',
  'inventory.stock.consumed',
  'inventory.stock.entered',
  'inventory.stock.adjusted',
  'fiscal.ec.withholding.issued',
  'purchasing.bill.posted',
  'purchasing.bill.voided',
  'fiscal.ec.purchase_settlement.issued',
  'treasury.receipt.posted',
  'treasury.receipt.voided',
  'treasury.payment.posted',
  'treasury.payment.voided',
  'treasury.bank_adjustment.posted',
  'treasury.bank_adjustment.voided',
] as const;

export const GENERAL_LEDGER_PLUGIN = 'finance.general_ledger';

export type ProcessResult =
  | { outcome: 'posted'; entryId: string }
  | { outcome: 'duplicate'; entryId: string | null }
  | { outcome: 'ignored' | 'skipped'; reason: string }
  | { outcome: 'pending'; reasonCode: string; message: string; sourceType: string; sourceId: string; entryDate: string | null };

type PendingResult = Extract<ProcessResult, { outcome: 'pending' }>;
type Step = { result: ProcessResult; commit: boolean };

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'SequelizeUniqueConstraintError';
}

function ruleContext(settings: AccountingSettings, now: Date): RuleContext {
  return { baseCurrency: settings.baseCurrency, timeZone: settings.timezone, paymentMethodRoles: settings.paymentMethodRoles, now };
}

/**
 * Convierte los eventos de facturación e inventario en asientos contabilizados («contabilización automática»).
 *
 * Garantías:
 *  - **Idempotente:** un documento de origen genera, como mucho, un asiento automático (`UNIQUE` por origen + comprobación previa).
 *    Un evento repetido no duplica nada.
 *  - **No se pierde nada:** si no se puede contabilizar (periodo cerrado o sin crear, falta la cuenta de un rol, el asiento no
 *    cuadra, el módulo está apagado…) el evento queda en `pending_postings` con su contenido y el motivo, y se avisa. Cuando la
 *    persona lo arregla, `retry` lo contabiliza.
 *  - **Solo para quien tiene contabilidad:** una organización sin configurar se ignora; y solo cuentan los documentos con fecha
 *    desde `autoPostingFrom` (lo anterior se carga como saldos iniciales: contarlo dos veces descuadraría los libros).
 *  - **El fallo técnico se reintenta, el de negocio se aparta:** un error de base de datos sube al consumidor (reintentos con
 *    espera); un `AppError` (periodo cerrado, validación) deja el evento pendiente.
 */
export class AutomaticPostingUseCase {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly clock: Clock,
    private readonly systemUserId: string,
  ) {}

  /** Punto de entrada del consumidor de eventos. */
  async handle(eventType: string, payload: unknown): Promise<ProcessResult> {
    const p = (payload ?? {}) as Record<string, unknown>;
    const organizationId = typeof p.organizationId === 'string' ? p.organizationId : null;
    if (!organizationId) return { outcome: 'ignored', reason: 'evento sin organización' };
    const result = await this.process(organizationId, eventType, p);
    if (result.outcome === 'pending') {
      const row = await this.recordPending(organizationId, eventType, p, result);
      // La emisión pudo contabilizarse entre que se miró y se anotó el pendiente: se reintenta una vez para no dejarlo esperando.
      if (row && result.reasonCode === 'ORIGINAL_NOT_POSTED') await this.retry(organizationId, [row.id]);
    } else if (result.outcome === 'posted' && eventType === 'billing.invoice.issued' && typeof p.invoiceId === 'string') {
      await this.resolveWaitingVoid(organizationId, p.invoiceId);
    } else if (result.outcome === 'posted' && eventType === 'treasury.receipt.posted' && typeof p.receiptId === 'string') {
      await this.resolveWaitingReceiptVoid(organizationId, p.receiptId);
    } else if (result.outcome === 'posted' && eventType === 'treasury.payment.posted' && typeof p.paymentId === 'string') {
      await this.resolveWaitingPaymentVoid(organizationId, p.paymentId);
    } else if (result.outcome === 'posted' && eventType === 'treasury.bank_adjustment.posted' && typeof p.adjustmentId === 'string') {
      await this.resolveWaitingAdjustmentVoid(organizationId, p.adjustmentId);
    }
    return result;
  }

  /** La anulación llegó antes que la emisión: ahora que el asiento existe, se reversa. */
  private async resolveWaitingVoid(organizationId: string, invoiceId: string): Promise<void> {
    const uow = await this.gateway.begin();
    let waiting: PendingPosting | null;
    try {
      waiting = await uow.pendingPostings.findBySource(organizationId, 'billing.invoice.voided', 'invoice_void', invoiceId);
      await uow.commit();
    } catch (err) {
      await uow.rollback();
      throw err;
    }
    if (waiting && waiting.status === 'pending') await this.retry(organizationId, [waiting.id]);
  }

  /** La anulación del cobro llegó antes que su contabilización: ahora que el asiento existe, se reversa. */
  private async resolveWaitingReceiptVoid(organizationId: string, receiptId: string): Promise<void> {
    const uow = await this.gateway.begin();
    let waiting: PendingPosting | null;
    try {
      waiting = await uow.pendingPostings.findBySource(organizationId, 'treasury.receipt.voided', 'receipt_void', receiptId);
      await uow.commit();
    } catch (err) {
      await uow.rollback();
      throw err;
    }
    if (waiting && waiting.status === 'pending') await this.retry(organizationId, [waiting.id]);
  }

  /** La anulación del pago llegó antes que su contabilización: ahora que el asiento existe, se reversa. */
  private async resolveWaitingPaymentVoid(organizationId: string, paymentId: string): Promise<void> {
    const uow = await this.gateway.begin();
    let waiting: PendingPosting | null;
    try {
      waiting = await uow.pendingPostings.findBySource(organizationId, 'treasury.payment.voided', 'payment_void', paymentId);
      await uow.commit();
    } catch (err) {
      await uow.rollback();
      throw err;
    }
    if (waiting && waiting.status === 'pending') await this.retry(organizationId, [waiting.id]);
  }

  /** La anulación del ajuste bancario llegó antes que su contabilización: ahora que el asiento existe, se reversa. */
  private async resolveWaitingAdjustmentVoid(organizationId: string, adjustmentId: string): Promise<void> {
    const uow = await this.gateway.begin();
    let waiting: PendingPosting | null;
    try {
      waiting = await uow.pendingPostings.findBySource(organizationId, 'treasury.bank_adjustment.voided', 'bank_adjustment_void', adjustmentId);
      await uow.commit();
    } catch (err) {
      await uow.rollback();
      throw err;
    }
    if (waiting && waiting.status === 'pending') await this.retry(organizationId, [waiting.id]);
  }

  /** Intenta contabilizar un evento. NO toca `pending_postings`: lo hacen `handle` y `retry`. */
  async process(organizationId: string, eventType: string, payload: Record<string, unknown>): Promise<ProcessResult> {
    const uow = await this.gateway.begin();
    try {
      const step = await this.run(uow, organizationId, eventType, payload);
      if (step.commit) await uow.commit();
      else await uow.rollback();
      return step.result;
    } catch (err) {
      await uow.rollback();
      // Dos entregas del mismo evento a la vez: gana una, la otra choca con el UNIQUE y es un duplicado, no un fallo.
      if (isUniqueViolation(err)) return { outcome: 'duplicate', entryId: null };
      throw err;
    }
  }

  private async run(uow: WriteUnitOfWork, organizationId: string, eventType: string, payload: Record<string, unknown>): Promise<Step> {
    const settings = await uow.settings.find(organizationId);
    if (!settings) return { result: { outcome: 'ignored', reason: 'la organización no tiene contabilidad' }, commit: false };
    const now = this.clock();
    const ctx = ruleContext(settings, now);

    if (eventType === 'billing.invoice.voided') return this.runVoid(uow, settings, payload, ctx);
    if (eventType === 'purchasing.bill.voided') return this.runVoidPurchaseBill(uow, settings, payload, ctx);
    if (eventType === 'treasury.receipt.voided') return this.runVoidReceipt(uow, settings, payload, ctx);
    if (eventType === 'treasury.payment.voided') return this.runVoidPayment(uow, settings, payload, ctx);
    if (eventType === 'treasury.bank_adjustment.voided') return this.runVoidBankAdjustment(uow, settings, payload, ctx);

    const rule =
      eventType === 'billing.invoice.issued'
        ? draftFromInvoiceIssued(payload as unknown as InvoiceIssuedPayload, ctx)
        : eventType === 'fiscal.ec.withholding.issued'
          ? draftFromWithholdingIssued(payload as unknown as WithholdingIssuedPayload, ctx)
          : eventType === 'purchasing.bill.posted'
            ? draftFromPurchaseBillPosted(payload as unknown as PurchaseBillPostedPayload, ctx)
            : eventType === 'fiscal.ec.purchase_settlement.issued'
              ? draftFromPurchaseSettlementIssued(payload as unknown as PurchaseSettlementIssuedPayload, ctx)
              : eventType === 'treasury.receipt.posted'
                ? draftFromReceiptPosted(payload as unknown as ReceiptPostedPayload, ctx)
                : eventType === 'treasury.payment.posted'
                  ? draftFromPaymentPosted(payload as unknown as PaymentPostedPayload, ctx)
                  : eventType === 'treasury.bank_adjustment.posted'
                    ? draftFromBankAdjustmentPosted(payload as unknown as BankAdjustmentPostedPayload, ctx)
                    : draftFromStockMovement(eventType, payload as unknown as StockMovementPayload, ctx);

    if (rule.kind === 'skip') return { result: { outcome: 'skipped', reason: rule.reason }, commit: false };
    if (rule.kind === 'blocked') {
      return { result: { outcome: 'pending', reasonCode: rule.reasonCode, message: rule.message, sourceType: rule.sourceType, sourceId: rule.sourceId, entryDate: null }, commit: false };
    }
    const draft = rule;

    if (settings.autoPostingFrom && draft.entryDate < settings.autoPostingFrom) {
      return { result: { outcome: 'ignored', reason: `documento anterior al ${settings.autoPostingFrom}` }, commit: false };
    }
    if (!settings.autoPosting) {
      return { result: this.pending(draft, 'AUTO_POSTING_OFF', 'La contabilización automática está apagada.'), commit: false };
    }

    const existing = await uow.journal.findBySource(organizationId, draft.sourceType, draft.sourceId, 'automatic');
    if (existing) return { result: { outcome: 'duplicate', entryId: existing.id }, commit: false };

    // «Costo de ventas — factura <uuid>» no le dice nada a nadie: si la factura ya tiene asiento, se nombra por su número.
    if (draft.sourceType === 'stock_movement' && payload.referenceType === 'invoice' && typeof payload.referenceId === 'string') {
      const invoiceEntry = await uow.journal.findBySource(organizationId, 'invoice', payload.referenceId, 'automatic');
      if (invoiceEntry?.reference) draft.description = draft.description.replace(payload.referenceId, invoiceEntry.reference);
    }

    return this.postDraft(uow, organizationId, draft);
  }

  private pending(draft: PostingDraft, reasonCode: string, message: string): PendingResult {
    return { outcome: 'pending', reasonCode, message, sourceType: draft.sourceType, sourceId: draft.sourceId, entryDate: draft.entryDate };
  }

  private async postDraft(uow: WriteUnitOfWork, organizationId: string, draft: PostingDraft): Promise<Step> {
    const accounts = await uow.accounts.list(organizationId);
    const byRole = new Map<string, Account>();
    for (const a of accounts) if (a.systemRole) byRole.set(a.systemRole, a);

    const lines: JournalLineInput[] = [];
    for (const l of draft.lines) {
      const account = byRole.get(l.role);
      if (!account) {
        return { result: this.pending(draft, 'MISSING_ROLE', `Ninguna cuenta tiene el rol «${l.role}». Asígnalo en la contabilización automática.`), commit: false };
      }
      if (!account.canReceiveMovements()) {
        return { result: this.pending(draft, 'ACCOUNT_NOT_POSTABLE', `La cuenta ${account.code} (rol «${l.role}») está inactiva o es de agrupación.`), commit: false };
      }
      lines.push({
        accountId: account.id,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        description: l.description ?? null,
        partyType: l.partyType ?? null,
        partyId: l.partyId ?? null,
        establishmentId: l.establishmentId ?? null,
      });
    }

    try {
      const entry = JournalEntry.create({
        organizationId,
        entryDate: draft.entryDate,
        description: draft.description,
        reference: draft.reference,
        kind: 'automatic',
        sourceType: draft.sourceType,
        sourceId: draft.sourceId,
        currencyCode: draft.currencyCode,
        lines,
        createdBy: this.systemUserId,
      });
      await uow.journal.save(entry);
      await postEntryInTransaction(uow, entry, this.systemUserId, this.clock());
      return { result: { outcome: 'posted', entryId: entry.id }, commit: true };
    } catch (err) {
      // Periodo cerrado o inexistente, asiento que no cuadra…: se aparta el evento (se deshace lo escrito) y queda pendiente.
      if (err instanceof AppError) return { result: this.pending(draft, err.code, err.message), commit: false };
      throw err;
    }
  }

  /** Anulación de una factura: se reversa el asiento automático que la contabilizó. */
  private async runVoid(uow: WriteUnitOfWork, settings: AccountingSettings, payload: Record<string, unknown>, ctx: RuleContext): Promise<Step> {
    const organizationId = settings.organizationId;
    const invoiceId = typeof payload.invoiceId === 'string' ? payload.invoiceId : null;
    if (!invoiceId) return { result: { outcome: 'ignored', reason: 'anulación sin factura' }, commit: false };

    const original = await uow.journal.findBySource(organizationId, 'invoice', invoiceId, 'automatic');
    if (!original) {
      // Se anuló antes de contabilizarse (estaba pendiente) o es anterior a la contabilidad: no hay nada que reversar.
      const waiting = await uow.pendingPostings.findBySource(organizationId, 'billing.invoice.issued', 'invoice', invoiceId);
      if (waiting && waiting.status === 'pending') {
        waiting.status = 'discarded';
        waiting.reasonMessage = 'La factura se anuló antes de contabilizarse.';
        waiting.resolvedAt = this.clock();
        waiting.updatedAt = waiting.resolvedAt;
        await uow.pendingPostings.save(waiting);
        await uow.outbox.add(postingResolvedEvent(waiting, 'discarded', waiting.reasonMessage));
        return { result: { outcome: 'ignored', reason: 'anulada antes de contabilizarse' }, commit: true };
      }
      // Sin asiento y sin pendiente: o la factura es anterior a la contabilidad, o su evento de emisión todavía no se contabilizó (los
      // mensajes de RabbitMQ no llegan en orden garantizado: una anulación rápida puede adelantarse a la emisión). Con la fecha de
      // emisión se distingue; sin ella se prefiere esperar a perder la anulación.
      const issuedOn = typeof payload.issueDate === 'string' ? localDateOf(payload.issueDate, ctx.timeZone) : null;
      if (issuedOn && settings.autoPostingFrom && issuedOn < settings.autoPostingFrom) {
        return { result: { outcome: 'ignored', reason: `factura anterior al ${settings.autoPostingFrom}` }, commit: false };
      }
      return {
        result: {
          outcome: 'pending',
          reasonCode: 'ORIGINAL_NOT_POSTED',
          message: 'La factura todavía no tiene asiento: se reversará cuando se contabilice.',
          sourceType: 'invoice_void',
          sourceId: invoiceId,
          entryDate: localDateOf(typeof payload.voidedAt === 'string' ? payload.voidedAt : ctx.now, ctx.timeZone),
        },
        commit: false,
      };
    }
    const already = await uow.journal.findBySource(organizationId, 'invoice', invoiceId, 'reversal');
    if (already) return { result: { outcome: 'duplicate', entryId: already.id }, commit: false };

    const voidedAt = typeof payload.voidedAt === 'string' ? payload.voidedAt : ctx.now;
    const entryDate = localDateOf(voidedAt, ctx.timeZone);
    const pending = (code: string, message: string): Step => ({
      result: { outcome: 'pending', reasonCode: code, message, sourceType: 'invoice_void', sourceId: invoiceId, entryDate },
      commit: false,
    });
    if (!settings.autoPosting) return pending('AUTO_POSTING_OFF', 'La contabilización automática está apagada.');

    const locked = await uow.journal.lockById(organizationId, original.id);
    if (!locked) return { result: { outcome: 'ignored', reason: 'el asiento original ya no existe' }, commit: false };
    // Dos entregas a la vez (la anulación y el reintento): quien llega segundo, ya con el bloqueo, ve que el otro lo reversó.
    if (locked.reversedByEntryId) return { result: { outcome: 'duplicate', entryId: locked.reversedByEntryId }, commit: false };
    try {
      const number = typeof payload.number === 'string' ? payload.number : invoiceId;
      const reversal = JournalEntry.reversalOf(locked, {
        entryDate,
        reason: `Anulación de la factura ${number}`,
        createdBy: this.systemUserId,
        sourceType: 'invoice',
        sourceId: invoiceId,
      });
      await uow.journal.save(reversal);
      await postEntryInTransaction(uow, reversal, this.systemUserId, this.clock());
      locked.markReversed(reversal.id);
      await uow.journal.save(locked);
      await uow.outbox.add(journalEntryReversedEvent(locked, reversal));
      return { result: { outcome: 'posted', entryId: reversal.id }, commit: true };
    } catch (err) {
      if (err instanceof AppError) return pending(err.code, err.message);
      throw err;
    }
  }

  /** Anulación de una factura de compra: reversa del asiento de la factura (misma lógica que billing.invoice.voided). */
  private async runVoidPurchaseBill(uow: WriteUnitOfWork, settings: AccountingSettings, payload: Record<string, unknown>, ctx: RuleContext): Promise<Step> {
    const organizationId = settings.organizationId;
    const billId = typeof payload.billId === 'string' ? payload.billId : null;
    if (!billId) return { result: { outcome: 'ignored', reason: 'anulación sin factura de compra' }, commit: false };

    const original = await uow.journal.findBySource(organizationId, 'purchase_bill', billId, 'automatic');
    if (!original) {
      // Se anuló antes de contabilizarse (estaba pendiente) o es anterior a la contabilidad.
      const waiting = await uow.pendingPostings.findBySource(organizationId, 'purchasing.bill.posted', 'purchase_bill', billId);
      if (waiting && waiting.status === 'pending') {
        waiting.status = 'discarded';
        waiting.reasonMessage = 'La factura de compra se anuló antes de contabilizarse.';
        waiting.resolvedAt = this.clock();
        waiting.updatedAt = waiting.resolvedAt;
        await uow.pendingPostings.save(waiting);
        await uow.outbox.add(postingResolvedEvent(waiting, 'discarded', waiting.reasonMessage));
        return { result: { outcome: 'ignored', reason: 'anulada antes de contabilizarse' }, commit: true };
      }
      const issuedOn = typeof payload.issueDate === 'string' ? localDateOf(payload.issueDate, ctx.timeZone) : null;
      if (issuedOn && settings.autoPostingFrom && issuedOn < settings.autoPostingFrom) {
        return { result: { outcome: 'ignored', reason: `factura anterior al ${settings.autoPostingFrom}` }, commit: false };
      }
      return {
        result: {
          outcome: 'pending',
          reasonCode: 'ORIGINAL_NOT_POSTED',
          message: 'La factura de compra todavía no tiene asiento: se reversará cuando se contabilice.',
          sourceType: 'purchase_bill_void',
          sourceId: billId,
          entryDate: localDateOf(typeof payload.voidedAt === 'string' ? payload.voidedAt : ctx.now, ctx.timeZone),
        },
        commit: false,
      };
    }
    const already = await uow.journal.findBySource(organizationId, 'purchase_bill', billId, 'reversal');
    if (already) return { result: { outcome: 'duplicate', entryId: already.id }, commit: false };

    const voidedAt = typeof payload.voidedAt === 'string' ? payload.voidedAt : ctx.now;
    const entryDate = localDateOf(voidedAt, ctx.timeZone);
    const pending = (code: string, message: string): Step => ({
      result: { outcome: 'pending', reasonCode: code, message, sourceType: 'purchase_bill_void', sourceId: billId, entryDate },
      commit: false,
    });
    if (!settings.autoPosting) return pending('AUTO_POSTING_OFF', 'La contabilización automática está apagada.');

    const locked = await uow.journal.lockById(organizationId, original.id);
    if (!locked) return { result: { outcome: 'ignored', reason: 'el asiento original ya no existe' }, commit: false };
    if (locked.reversedByEntryId) return { result: { outcome: 'duplicate', entryId: locked.reversedByEntryId }, commit: false };
    try {
      // purchasing.bill.voided trae `internalNumber` (FC-AAAA-NNNNNN) y el motivo de la anulación en `voidReason`.
      const number = typeof payload.internalNumber === 'string' ? payload.internalNumber : typeof payload.number === 'string' ? payload.number : billId;
      const why = typeof payload.voidReason === 'string' && payload.voidReason ? `: ${payload.voidReason}` : '';
      const reversal = JournalEntry.reversalOf(locked, {
        entryDate,
        reason: `Anulación de factura de compra ${number}${why}`.slice(0, 255),
        createdBy: this.systemUserId,
        sourceType: 'purchase_bill',
        sourceId: billId,
      });
      await uow.journal.save(reversal);
      await postEntryInTransaction(uow, reversal, this.systemUserId, this.clock());
      locked.markReversed(reversal.id);
      await uow.journal.save(locked);
      await uow.outbox.add(journalEntryReversedEvent(locked, reversal));
      return { result: { outcome: 'posted', entryId: reversal.id }, commit: true };
    } catch (err) {
      if (err instanceof AppError) return pending(err.code, err.message);
      throw err;
    }
  }

  /** Anulación de un cobro: reversa del asiento del cobro (misma lógica que la factura de compra anulada). */
  private async runVoidReceipt(uow: WriteUnitOfWork, settings: AccountingSettings, payload: Record<string, unknown>, ctx: RuleContext): Promise<Step> {
    const organizationId = settings.organizationId;
    const receiptId = typeof payload.receiptId === 'string' ? payload.receiptId : null;
    if (!receiptId) return { result: { outcome: 'ignored', reason: 'anulación sin cobro' }, commit: false };

    const original = await uow.journal.findBySource(organizationId, 'receipt', receiptId, 'automatic');
    if (!original) {
      // Se anuló antes de contabilizarse (estaba pendiente) o es anterior a la contabilidad.
      const waiting = await uow.pendingPostings.findBySource(organizationId, 'treasury.receipt.posted', 'receipt', receiptId);
      if (waiting && waiting.status === 'pending') {
        waiting.status = 'discarded';
        waiting.reasonMessage = 'El cobro se anuló antes de contabilizarse.';
        waiting.resolvedAt = this.clock();
        waiting.updatedAt = waiting.resolvedAt;
        await uow.pendingPostings.save(waiting);
        await uow.outbox.add(postingResolvedEvent(waiting, 'discarded', waiting.reasonMessage));
        return { result: { outcome: 'ignored', reason: 'anulado antes de contabilizarse' }, commit: true };
      }
      const receivedOn = typeof payload.receiptDate === 'string' ? localDateOf(payload.receiptDate, ctx.timeZone) : null;
      if (receivedOn && settings.autoPostingFrom && receivedOn < settings.autoPostingFrom) {
        return { result: { outcome: 'ignored', reason: `cobro anterior al ${settings.autoPostingFrom}` }, commit: false };
      }
      return {
        result: {
          outcome: 'pending',
          reasonCode: 'ORIGINAL_NOT_POSTED',
          message: 'El cobro todavía no tiene asiento: se reversará cuando se contabilice.',
          sourceType: 'receipt_void',
          sourceId: receiptId,
          entryDate: localDateOf(typeof payload.voidedAt === 'string' ? payload.voidedAt : ctx.now, ctx.timeZone),
        },
        commit: false,
      };
    }
    const already = await uow.journal.findBySource(organizationId, 'receipt', receiptId, 'reversal');
    if (already) return { result: { outcome: 'duplicate', entryId: already.id }, commit: false };

    const entryDate = localDateOf(typeof payload.voidedAt === 'string' ? payload.voidedAt : ctx.now, ctx.timeZone);
    const pending = (code: string, message: string): Step => ({
      result: { outcome: 'pending', reasonCode: code, message, sourceType: 'receipt_void', sourceId: receiptId, entryDate },
      commit: false,
    });
    if (!settings.autoPosting) return pending('AUTO_POSTING_OFF', 'La contabilización automática está apagada.');

    const locked = await uow.journal.lockById(organizationId, original.id);
    if (!locked) return { result: { outcome: 'ignored', reason: 'el asiento original ya no existe' }, commit: false };
    if (locked.reversedByEntryId) return { result: { outcome: 'duplicate', entryId: locked.reversedByEntryId }, commit: false };
    try {
      const number = typeof payload.number === 'string' ? payload.number : receiptId;
      const why = typeof payload.reason === 'string' && payload.reason ? `: ${payload.reason}` : '';
      const reversal = JournalEntry.reversalOf(locked, {
        entryDate,
        reason: `Anulación del cobro ${number}${why}`.slice(0, 255),
        createdBy: this.systemUserId,
        sourceType: 'receipt',
        sourceId: receiptId,
      });
      await uow.journal.save(reversal);
      await postEntryInTransaction(uow, reversal, this.systemUserId, this.clock());
      locked.markReversed(reversal.id);
      await uow.journal.save(locked);
      await uow.outbox.add(journalEntryReversedEvent(locked, reversal));
      return { result: { outcome: 'posted', entryId: reversal.id }, commit: true };
    } catch (err) {
      if (err instanceof AppError) return pending(err.code, err.message);
      throw err;
    }
  }

  /** Anulación de un pago: reversa del asiento del pago (misma lógica que el cobro anulado). */
  private async runVoidPayment(uow: WriteUnitOfWork, settings: AccountingSettings, payload: Record<string, unknown>, ctx: RuleContext): Promise<Step> {
    const organizationId = settings.organizationId;
    const paymentId = typeof payload.paymentId === 'string' ? payload.paymentId : null;
    if (!paymentId) return { result: { outcome: 'ignored', reason: 'anulación sin pago' }, commit: false };

    const original = await uow.journal.findBySource(organizationId, 'payment', paymentId, 'automatic');
    if (!original) {
      // Se anuló antes de contabilizarse (estaba pendiente) o es anterior a la contabilidad.
      const waiting = await uow.pendingPostings.findBySource(organizationId, 'treasury.payment.posted', 'payment', paymentId);
      if (waiting && waiting.status === 'pending') {
        waiting.status = 'discarded';
        waiting.reasonMessage = 'El pago se anuló antes de contabilizarse.';
        waiting.resolvedAt = this.clock();
        waiting.updatedAt = waiting.resolvedAt;
        await uow.pendingPostings.save(waiting);
        await uow.outbox.add(postingResolvedEvent(waiting, 'discarded', waiting.reasonMessage));
        return { result: { outcome: 'ignored', reason: 'anulado antes de contabilizarse' }, commit: true };
      }
      const paidOn = typeof payload.paymentDate === 'string' ? localDateOf(payload.paymentDate, ctx.timeZone) : null;
      if (paidOn && settings.autoPostingFrom && paidOn < settings.autoPostingFrom) {
        return { result: { outcome: 'ignored', reason: `pago anterior al ${settings.autoPostingFrom}` }, commit: false };
      }
      return {
        result: {
          outcome: 'pending',
          reasonCode: 'ORIGINAL_NOT_POSTED',
          message: 'El pago todavía no tiene asiento: se reversará cuando se contabilice.',
          sourceType: 'payment_void',
          sourceId: paymentId,
          entryDate: localDateOf(typeof payload.voidedAt === 'string' ? payload.voidedAt : ctx.now, ctx.timeZone),
        },
        commit: false,
      };
    }
    const already = await uow.journal.findBySource(organizationId, 'payment', paymentId, 'reversal');
    if (already) return { result: { outcome: 'duplicate', entryId: already.id }, commit: false };

    const entryDate = localDateOf(typeof payload.voidedAt === 'string' ? payload.voidedAt : ctx.now, ctx.timeZone);
    const pending = (code: string, message: string): Step => ({
      result: { outcome: 'pending', reasonCode: code, message, sourceType: 'payment_void', sourceId: paymentId, entryDate },
      commit: false,
    });
    if (!settings.autoPosting) return pending('AUTO_POSTING_OFF', 'La contabilización automática está apagada.');

    const locked = await uow.journal.lockById(organizationId, original.id);
    if (!locked) return { result: { outcome: 'ignored', reason: 'el asiento original ya no existe' }, commit: false };
    if (locked.reversedByEntryId) return { result: { outcome: 'duplicate', entryId: locked.reversedByEntryId }, commit: false };
    try {
      const number = typeof payload.number === 'string' ? payload.number : paymentId;
      const why = typeof payload.reason === 'string' && payload.reason ? `: ${payload.reason}` : '';
      const reversal = JournalEntry.reversalOf(locked, {
        entryDate,
        reason: `Anulación del pago ${number}${why}`.slice(0, 255),
        createdBy: this.systemUserId,
        sourceType: 'payment',
        sourceId: paymentId,
      });
      await uow.journal.save(reversal);
      await postEntryInTransaction(uow, reversal, this.systemUserId, this.clock());
      locked.markReversed(reversal.id);
      await uow.journal.save(locked);
      await uow.outbox.add(journalEntryReversedEvent(locked, reversal));
      return { result: { outcome: 'posted', entryId: reversal.id }, commit: true };
    } catch (err) {
      if (err instanceof AppError) return pending(err.code, err.message);
      throw err;
    }
  }

  /** Anulación de un ajuste bancario: reversa del asiento del ajuste (misma lógica que el pago anulado). */
  private async runVoidBankAdjustment(uow: WriteUnitOfWork, settings: AccountingSettings, payload: Record<string, unknown>, ctx: RuleContext): Promise<Step> {
    const organizationId = settings.organizationId;
    const adjustmentId = typeof payload.adjustmentId === 'string' ? payload.adjustmentId : null;
    if (!adjustmentId) return { result: { outcome: 'ignored', reason: 'anulación sin ajuste' }, commit: false };

    const original = await uow.journal.findBySource(organizationId, 'bank_adjustment', adjustmentId, 'automatic');
    if (!original) {
      // Se anuló antes de contabilizarse (estaba pendiente) o es anterior a la contabilidad.
      const waiting = await uow.pendingPostings.findBySource(organizationId, 'treasury.bank_adjustment.posted', 'bank_adjustment', adjustmentId);
      if (waiting && waiting.status === 'pending') {
        waiting.status = 'discarded';
        waiting.reasonMessage = 'El ajuste bancario se anuló antes de contabilizarse.';
        waiting.resolvedAt = this.clock();
        waiting.updatedAt = waiting.resolvedAt;
        await uow.pendingPostings.save(waiting);
        await uow.outbox.add(postingResolvedEvent(waiting, 'discarded', waiting.reasonMessage));
        return { result: { outcome: 'ignored', reason: 'anulado antes de contabilizarse' }, commit: true };
      }
      const on = typeof payload.adjustmentDate === 'string' ? localDateOf(payload.adjustmentDate, ctx.timeZone) : null;
      if (on && settings.autoPostingFrom && on < settings.autoPostingFrom) {
        return { result: { outcome: 'ignored', reason: `ajuste anterior al ${settings.autoPostingFrom}` }, commit: false };
      }
      return {
        result: {
          outcome: 'pending',
          reasonCode: 'ORIGINAL_NOT_POSTED',
          message: 'El ajuste bancario todavía no tiene asiento: se reversará cuando se contabilice.',
          sourceType: 'bank_adjustment_void',
          sourceId: adjustmentId,
          entryDate: localDateOf(ctx.now, ctx.timeZone),
        },
        commit: false,
      };
    }
    const already = await uow.journal.findBySource(organizationId, 'bank_adjustment', adjustmentId, 'reversal');
    if (already) return { result: { outcome: 'duplicate', entryId: already.id }, commit: false };

    const entryDate = localDateOf(ctx.now, ctx.timeZone);
    const pending = (code: string, message: string): Step => ({
      result: { outcome: 'pending', reasonCode: code, message, sourceType: 'bank_adjustment_void', sourceId: adjustmentId, entryDate },
      commit: false,
    });
    if (!settings.autoPosting) return pending('AUTO_POSTING_OFF', 'La contabilización automática está apagada.');

    const locked = await uow.journal.lockById(organizationId, original.id);
    if (!locked) return { result: { outcome: 'ignored', reason: 'el asiento original ya no existe' }, commit: false };
    if (locked.reversedByEntryId) return { result: { outcome: 'duplicate', entryId: locked.reversedByEntryId }, commit: false };
    try {
      const why = typeof payload.reason === 'string' && payload.reason ? `: ${payload.reason}` : '';
      const reversal = JournalEntry.reversalOf(locked, {
        entryDate,
        reason: `Anulación del ajuste bancario${why}`.slice(0, 255),
        createdBy: this.systemUserId,
        sourceType: 'bank_adjustment',
        sourceId: adjustmentId,
      });
      await uow.journal.save(reversal);
      await postEntryInTransaction(uow, reversal, this.systemUserId, this.clock());
      locked.markReversed(reversal.id);
      await uow.journal.save(locked);
      await uow.outbox.add(journalEntryReversedEvent(locked, reversal));
      return { result: { outcome: 'posted', entryId: reversal.id }, commit: true };
    } catch (err) {
      if (err instanceof AppError) return pending(err.code, err.message);
      throw err;
    }
  }

  // ── Pendientes ────────────────────────────────────────────────────────────

  private async recordPending(organizationId: string, eventType: string, payload: Record<string, unknown>, result: PendingResult): Promise<PendingPosting | null> {
    const uow = await this.gateway.begin();
    try {
      const existing = await uow.pendingPostings.findBySource(organizationId, eventType, result.sourceType, result.sourceId);
      const now = this.clock();
      let saved: PendingPosting | null = existing && existing.status === 'pending' ? existing : null;
      if (existing) {
        // Redelivery del mismo evento: solo se refresca el motivo mientras siga pendiente.
        if (existing.status === 'pending') {
          existing.reasonCode = result.reasonCode;
          existing.reasonMessage = result.message.slice(0, 255);
          existing.updatedAt = now;
          await uow.pendingPostings.save(existing);
        }
      } else {
        const row: PendingPosting = {
          id: randomUUID(),
          organizationId,
          eventType,
          sourceType: result.sourceType,
          sourceId: result.sourceId,
          payload,
          reasonCode: result.reasonCode,
          reasonMessage: result.message.slice(0, 255),
          status: 'pending',
          attempts: 1,
          entryId: null,
          entryDate: result.entryDate,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        };
        await uow.pendingPostings.save(row);
        await uow.outbox.add(postingPendingEvent(row));
        saved = row;
      }
      await uow.commit();
      return saved;
    } catch (err) {
      await uow.rollback();
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /** Reintenta los pendientes (todos, o los indicados). Devuelve cuántos se contabilizaron, cuántos siguen y cuántos ya no aplican. */
  async retry(organizationId: string, ids?: string[]): Promise<{ posted: number; stillPending: number; discarded: number }> {
    const read = await this.gateway.begin();
    let rows: PendingPosting[];
    try {
      if (ids && ids.length > 0) {
        rows = [];
        for (const id of ids) {
          const row = await read.pendingPostings.findById(organizationId, id);
          if (row && row.status === 'pending') rows.push(row);
        }
      } else {
        rows = await read.pendingPostings.listPending(organizationId, 200);
      }
      await read.commit();
    } catch (err) {
      await read.rollback();
      throw err;
    }

    const summary = { posted: 0, stillPending: 0, discarded: 0 };
    for (const row of rows) {
      const result = await this.process(organizationId, row.eventType, row.payload);
      const uow = await this.gateway.begin();
      try {
        const fresh = await uow.pendingPostings.findById(organizationId, row.id);
        if (!fresh || fresh.status !== 'pending') {
          await uow.commit();
          continue;
        }
        const now = this.clock();
        fresh.attempts += 1;
        fresh.updatedAt = now;
        if (result.outcome === 'posted' || result.outcome === 'duplicate') {
          fresh.status = 'posted';
          fresh.entryId = result.entryId;
          fresh.resolvedAt = now;
          await uow.pendingPostings.save(fresh);
          await uow.outbox.add(postingResolvedEvent(fresh, 'posted'));
          summary.posted += 1;
        } else if (result.outcome === 'ignored' || result.outcome === 'skipped') {
          fresh.status = 'discarded';
          fresh.reasonMessage = `Ya no aplica: ${result.reason}`.slice(0, 255);
          fresh.resolvedAt = now;
          await uow.pendingPostings.save(fresh);
          await uow.outbox.add(postingResolvedEvent(fresh, 'discarded', fresh.reasonMessage));
          summary.discarded += 1;
        } else if (result.outcome === 'pending') {
          fresh.reasonCode = result.reasonCode;
          fresh.reasonMessage = result.message.slice(0, 255);
          await uow.pendingPostings.save(fresh);
          summary.stillPending += 1;
        }
        await uow.commit();
      } catch (err) {
        await uow.rollback();
        throw err;
      }
    }
    return summary;
  }
}

export class ListPendingPostingsUseCase {
  constructor(private readonly repos: Pick<UnitOfWork, 'pendingPostings'>) {}

  async execute(organizationId: string, filters: { status?: 'pending' | 'posted' | 'discarded'; page: number; pageSize: number }) {
    return this.repos.pendingPostings.list(organizationId, filters);
  }
}

export class DiscardPendingPostingUseCase {
  constructor(private readonly gateway: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(input: { organizationId: string; id: string; reason: string }): Promise<PendingPosting> {
    const uow = await this.gateway.begin();
    try {
      const row = await uow.pendingPostings.findById(input.organizationId, input.id);
      if (!row) throw new PendingNotFound();
      if (row.status !== 'pending') throw new PendingNotPending();
      const now = this.clock();
      row.status = 'discarded';
      row.reasonMessage = `Descartado: ${input.reason}`.slice(0, 255);
      row.resolvedAt = now;
      row.updatedAt = now;
      await uow.pendingPostings.save(row);
      await uow.outbox.add(postingResolvedEvent(row, 'discarded', input.reason));
      await uow.commit();
      return row;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

class PendingNotFound extends AppError {
  readonly code = 'PENDING_POSTING_NOT_FOUND';
  readonly httpStatus = 404;
  constructor() { super('Pendiente no encontrado.'); }
}

class PendingNotPending extends AppError {
  readonly code = 'PENDING_POSTING_NOT_PENDING';
  readonly httpStatus = 409;
  constructor() { super('Ese pendiente ya está resuelto.'); }
}
