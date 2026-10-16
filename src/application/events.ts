import { randomUUID } from 'node:crypto';
import type { Account, CostCenter } from '../domain/account.js';
import type { JournalEntry } from '../domain/journal.js';
import type { FiscalPeriod, FiscalYear } from '../domain/period.js';
import type { AccountingSettings, DomainEvent, PendingPosting } from '../domain/repositories.js';

/** Construye un DomainEvent con el envelope de bitácora (eventId/type/occurredAt). */
export function domainEvent(params: {
  type: string;
  aggregateType: string;
  aggregateId: string;
  organizationId: string;
  payload: Record<string, unknown>;
}): DomainEvent {
  return {
    eventId: randomUUID(),
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    type: params.type,
    // La bitácora exige organizationId en el payload de todo mensaje.
    payload: { ...params.payload, organizationId: params.organizationId },
    occurredAt: new Date(),
  };
}

export function setupCompletedEvent(params: {
  organizationId: string;
  chartTemplate: string;
  baseCurrency: string;
  accountCount: number;
  fiscalYear: number;
}): DomainEvent {
  return domainEvent({
    type: 'accounting.setup.completed',
    aggregateType: 'accounting_settings',
    aggregateId: params.organizationId,
    organizationId: params.organizationId,
    payload: {
      chartTemplate: params.chartTemplate,
      baseCurrency: params.baseCurrency,
      accountCount: params.accountCount,
      fiscalYear: params.fiscalYear,
    },
  });
}

function accountPayload(a: Account): Record<string, unknown> {
  return {
    accountId: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    parentId: a.parentId,
    isPostable: a.isPostable,
    status: a.status,
    systemRole: a.systemRole,
  };
}

export function accountCreatedEvent(a: Account): DomainEvent {
  return domainEvent({ type: 'accounting.account.created', aggregateType: 'account', aggregateId: a.id, organizationId: a.organizationId, payload: accountPayload(a) });
}

export function accountUpdatedEvent(a: Account, previous: { name: string; status: string; systemRole?: string | null }): DomainEvent {
  return domainEvent({
    type: 'accounting.account.updated',
    aggregateType: 'account',
    aggregateId: a.id,
    organizationId: a.organizationId,
    payload: { ...accountPayload(a), previous },
  });
}

export function costCenterUpsertedEvent(c: CostCenter): DomainEvent {
  return domainEvent({
    type: 'accounting.cost_center.upserted',
    aggregateType: 'cost_center',
    aggregateId: c.id,
    organizationId: c.organizationId,
    payload: { costCenterId: c.id, code: c.code, name: c.name, status: c.status },
  });
}

export function fiscalYearCreatedEvent(y: FiscalYear): DomainEvent {
  return domainEvent({
    type: 'accounting.fiscal_year.created',
    aggregateType: 'fiscal_year',
    aggregateId: y.id,
    organizationId: y.organizationId,
    payload: { fiscalYearId: y.id, year: y.year, startDate: y.startDate, endDate: y.endDate },
  });
}

export function periodClosedEvent(p: FiscalPeriod): DomainEvent {
  return periodEvent('accounting.period.closed', p);
}

export function periodReopenedEvent(p: FiscalPeriod): DomainEvent {
  return periodEvent('accounting.period.reopened', p);
}

function periodEvent(type: string, p: FiscalPeriod): DomainEvent {
  return domainEvent({
    type,
    aggregateType: 'fiscal_period',
    aggregateId: p.id,
    organizationId: p.organizationId,
    payload: { periodId: p.id, fiscalYearId: p.fiscalYearId, number: p.number, startDate: p.startDate, endDate: p.endDate, status: p.status },
  });
}

function entryPayload(e: JournalEntry): Record<string, unknown> {
  return {
    entryId: e.id,
    number: e.displayNumber(),
    entryDate: e.entryDate,
    description: e.description,
    status: e.status,
    kind: e.kind,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    currencyCode: e.currencyCode,
    totalDebitCents: e.totalDebitCents,
    totalCreditCents: e.totalCreditCents,
    lineCount: e.lines.length,
  };
}

export function journalEntrySavedEvent(e: JournalEntry): DomainEvent {
  return domainEvent({ type: 'accounting.journal_entry.saved', aggregateType: 'journal_entry', aggregateId: e.id, organizationId: e.organizationId, payload: entryPayload(e) });
}

export function journalEntryDeletedEvent(e: JournalEntry): DomainEvent {
  return domainEvent({ type: 'accounting.journal_entry.deleted', aggregateType: 'journal_entry', aggregateId: e.id, organizationId: e.organizationId, payload: entryPayload(e) });
}

/** Asiento contabilizado: lleva las líneas, porque es el hecho que reportes y BI consumen. */
export function journalEntryPostedEvent(e: JournalEntry): DomainEvent {
  return domainEvent({
    type: 'accounting.journal_entry.posted',
    aggregateType: 'journal_entry',
    aggregateId: e.id,
    organizationId: e.organizationId,
    payload: {
      ...entryPayload(e),
      periodId: e.periodId,
      reversesEntryId: e.reversesEntryId,
      lines: e.lines.map((l) => ({
        accountId: l.accountId,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        costCenterId: l.costCenterId,
        partyType: l.partyType,
        partyId: l.partyId,
      })),
    },
  });
}

export function journalEntryReversedEvent(original: JournalEntry, reversal: JournalEntry): DomainEvent {
  return domainEvent({
    type: 'accounting.journal_entry.reversed',
    aggregateType: 'journal_entry',
    aggregateId: original.id,
    organizationId: original.organizationId,
    payload: {
      entryId: original.id,
      number: original.displayNumber(),
      reversalEntryId: reversal.id,
      reversalNumber: reversal.displayNumber(),
      reason: reversal.reversalReason,
    },
  });
}

// ── Contabilización automática ──────────────────────────────────────────────

/** Un evento no pudo contabilizarse solo. Es lo que debe hacer sonar la campana: una persona tiene que resolverlo. */
export function postingPendingEvent(p: PendingPosting): DomainEvent {
  return domainEvent({
    type: 'accounting.posting.pending',
    aggregateType: 'pending_posting',
    aggregateId: p.id,
    organizationId: p.organizationId,
    payload: {
      pendingId: p.id,
      eventType: p.eventType,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
      reasonCode: p.reasonCode,
      reasonMessage: p.reasonMessage,
      entryDate: p.entryDate,
    },
  });
}

export function postingResolvedEvent(p: PendingPosting, how: 'posted' | 'discarded', reason?: string): DomainEvent {
  return domainEvent({
    type: 'accounting.posting.resolved',
    aggregateType: 'pending_posting',
    aggregateId: p.id,
    organizationId: p.organizationId,
    payload: {
      pendingId: p.id,
      eventType: p.eventType,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
      outcome: how,
      entryId: p.entryId,
      attempts: p.attempts,
      ...(reason ? { reason } : {}),
    },
  });
}

export function postingSettingsUpdatedEvent(s: AccountingSettings, previous: { autoPosting: boolean; autoPostingFrom: string | null }): DomainEvent {
  return domainEvent({
    type: 'accounting.posting_settings.updated',
    aggregateType: 'accounting_settings',
    aggregateId: s.organizationId,
    organizationId: s.organizationId,
    payload: {
      autoPosting: s.autoPosting,
      autoPostingFrom: s.autoPostingFrom,
      timezone: s.timezone,
      paymentMethodRoles: s.paymentMethodRoles,
      previous,
    },
  });
}
