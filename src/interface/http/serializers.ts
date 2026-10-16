import type { Account, CostCenter } from '../../domain/account.js';
import type { JournalEntry } from '../../domain/journal.js';
import type { FiscalPeriod, FiscalYear } from '../../domain/period.js';
import type { AccountingSettings, PendingPosting } from '../../domain/repositories.js';
import type { FiscalYearView } from '../../application/use-cases/period-use-cases.js';

/** Entidad → JSON del openapi. Las fechas contables salen como `YYYY-MM-DD`; los instantes, ISO; el dinero, en centavos. */

export function toSettingsJSON(s: AccountingSettings) {
  return {
    organizationId: s.organizationId,
    chartTemplate: s.chartTemplate,
    baseCurrency: s.baseCurrency,
    fiscalYearStartMonth: s.fiscalYearStartMonth,
    initializedAt: s.initializedAt.toISOString(),
    timezone: s.timezone,
    autoPosting: s.autoPosting,
    autoPostingFrom: s.autoPostingFrom,
    paymentMethodRoles: s.paymentMethodRoles,
  };
}

export function toPendingJSON(p: PendingPosting) {
  return {
    id: p.id,
    eventType: p.eventType,
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    reasonCode: p.reasonCode,
    reasonMessage: p.reasonMessage,
    status: p.status,
    attempts: p.attempts,
    entryId: p.entryId,
    entryDate: p.entryDate,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    resolvedAt: p.resolvedAt ? p.resolvedAt.toISOString() : null,
  };
}

export function toAccountJSON(a: Account) {
  return {
    id: a.id,
    organizationId: a.organizationId,
    code: a.code,
    name: a.name,
    type: a.type,
    parentId: a.parentId,
    level: a.level,
    isPostable: a.isPostable,
    status: a.status,
    systemRole: a.systemRole,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function toCostCenterJSON(c: CostCenter) {
  return {
    id: c.id,
    organizationId: c.organizationId,
    code: c.code,
    name: c.name,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function toPeriodJSON(p: FiscalPeriod) {
  return {
    id: p.id,
    fiscalYearId: p.fiscalYearId,
    number: p.number,
    startDate: p.startDate,
    endDate: p.endDate,
    status: p.status,
    closedAt: p.closedAt ? p.closedAt.toISOString() : null,
    closedBy: p.closedBy,
  };
}

export function toFiscalYearJSON(y: FiscalYear, periods: FiscalPeriod[] = []) {
  return {
    id: y.id,
    year: y.year,
    startDate: y.startDate,
    endDate: y.endDate,
    periods: periods.map(toPeriodJSON),
  };
}

export function toFiscalYearViewJSON(v: FiscalYearView) {
  return toFiscalYearJSON(v.year, v.periods);
}

export function toEntryJSON(e: JournalEntry, withLines = true) {
  return {
    id: e.id,
    organizationId: e.organizationId,
    number: e.displayNumber(),
    entryDate: e.entryDate,
    periodId: e.periodId,
    description: e.description,
    reference: e.reference,
    status: e.status,
    kind: e.kind,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    currencyCode: e.currencyCode,
    totalDebitCents: e.totalDebitCents,
    totalCreditCents: e.totalCreditCents,
    reversesEntryId: e.reversesEntryId,
    reversedByEntryId: e.reversedByEntryId,
    reversalReason: e.reversalReason,
    createdBy: e.createdBy,
    postedBy: e.postedBy,
    postedAt: e.postedAt ? e.postedAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
    ...(withLines
      ? {
          lines: e.lines.map((l) => ({
            id: l.id,
            lineNo: l.lineNo,
            accountId: l.accountId,
            debitCents: l.debitCents,
            creditCents: l.creditCents,
            description: l.description,
            costCenterId: l.costCenterId,
            projectId: l.projectId,
            establishmentId: l.establishmentId,
            partyType: l.partyType,
            partyId: l.partyId,
            currencyCode: l.currencyCode,
            amountFcCents: l.amountFcCents,
            exchangeRate: l.exchangeRate,
          })),
        }
      : {}),
  };
}
