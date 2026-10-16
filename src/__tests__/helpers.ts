import { Account, CostCenter } from '../domain/account.js';
import { JournalEntry, formatEntryNumber } from '../domain/journal.js';
import { FiscalPeriod, FiscalYear } from '../domain/period.js';
import type {
  AccountingSettings,
  DomainEvent,
  JournalListFilters,
  LedgerQuery,
  PendingPosting,
  SumFilters,
  UnitOfWork,
} from '../domain/repositories.js';
import type { AccountSums, LedgerLine } from '../domain/reports.js';
import type { UnitOfWorkGateway, WriteUnitOfWork } from '../application/ports.js';
import { GetSettingsUseCase, SetupAccountingUseCase } from '../application/use-cases/setup.js';
import {
  CreateAccountUseCase,
  CreateCostCenterUseCase,
  GetAccountUseCase,
  ListAccountsUseCase,
  ListCostCentersUseCase,
  UpdateAccountUseCase,
  UpdateCostCenterUseCase,
} from '../application/use-cases/account-use-cases.js';
import {
  ClosePeriodUseCase,
  CreateFiscalYearUseCase,
  ListFiscalYearsUseCase,
  ReopenPeriodUseCase,
} from '../application/use-cases/period-use-cases.js';
import {
  CreateJournalEntryUseCase,
  DeleteJournalEntryUseCase,
  GetJournalEntryUseCase,
  ListJournalEntriesUseCase,
  PostJournalEntryUseCase,
  ReverseJournalEntryUseCase,
  UpdateJournalEntryUseCase,
} from '../application/use-cases/journal-use-cases.js';
import { BalanceSheetUseCase, IncomeStatementUseCase, LedgerUseCase, TrialBalanceUseCase } from '../application/use-cases/report-use-cases.js';
import { AutomaticPostingUseCase, DiscardPendingPostingUseCase, ListPendingPostingsUseCase } from '../application/use-cases/automatic-posting.js';
import {
  GetPostingSettingsUseCase,
  SetAutoPostingByPluginUseCase,
  UpdatePostingSettingsUseCase,
} from '../application/use-cases/posting-settings-use-cases.js';
import { createApp } from '../interface/http/app.js';
import type { AppDependencies } from '../interface/http/routes.js';

function cloneEntry(e: JournalEntry): JournalEntry {
  return JournalEntry.fromPersistence(e.toPersistence());
}
function cloneAccount(a: Account): Account {
  return Account.fromPersistence(a.toPersistence());
}

interface Snapshot {
  settings: Map<string, AccountingSettings>;
  accounts: Map<string, Account>;
  costCenters: Map<string, CostCenter>;
  years: Map<string, FiscalYear>;
  periods: Map<string, FiscalPeriod>;
  entries: Map<string, JournalEntry>;
  pending: Map<string, PendingPosting>;
  counters: Map<string, number>;
  outboxLength: number;
}

/** Unit of Work en memoria: todos los repos comparten un store y `begin()/rollback()` simulan una transacción por instantánea. */
export class InMemoryStore implements UnitOfWorkGateway {
  settingsMap = new Map<string, AccountingSettings>();
  accountMap = new Map<string, Account>();
  costCenterMap = new Map<string, CostCenter>();
  yearMap = new Map<string, FiscalYear>();
  periodMap = new Map<string, FiscalPeriod>();
  entryMap = new Map<string, JournalEntry>();
  pendingMap = new Map<string, PendingPosting>();
  counters = new Map<string, number>();
  readonly outboxEvents: DomainEvent[] = [];
  private snapshotStack: Snapshot[] = [];

  async begin(): Promise<WriteUnitOfWork> {
    this.snapshotStack.push({
      settings: new Map([...this.settingsMap].map(([k, v]) => [k, { ...v }])),
      accounts: new Map([...this.accountMap].map(([k, v]) => [k, cloneAccount(v)])),
      costCenters: new Map(this.costCenterMap),
      years: new Map(this.yearMap),
      periods: new Map([...this.periodMap].map(([k, v]) => [k, FiscalPeriod.fromPersistence(v.toPersistence())])),
      entries: new Map([...this.entryMap].map(([k, v]) => [k, cloneEntry(v)])),
      pending: new Map([...this.pendingMap].map(([k, v]) => [k, { ...v }])),
      counters: new Map(this.counters),
      outboxLength: this.outboxEvents.length,
    });
    const store = this;
    return Object.assign(this.uow(), {
      async commit() { store.snapshotStack.pop(); },
      async rollback() {
        const snap = store.snapshotStack.pop();
        if (!snap) return;
        store.settingsMap = snap.settings;
        store.accountMap = snap.accounts;
        store.costCenterMap = snap.costCenters;
        store.yearMap = snap.years;
        store.periodMap = snap.periods;
        store.entryMap = snap.entries;
        store.pendingMap = snap.pending;
        store.counters = snap.counters;
        store.outboxEvents.length = snap.outboxLength;
      },
    });
  }

  /** Repos de lectura sin transacción. */
  readonly repos: UnitOfWork = this.uow();

  private uow(): UnitOfWork {
    const s = this;
    const orgOf = <T extends { organizationId: string }>(rows: Iterable<T>, org: string) => [...rows].filter((r) => r.organizationId === org);
    return {
      settings: {
        async find(org) { const v = s.settingsMap.get(org); return v ? { ...v } : null; },
        async create(v) { s.settingsMap.set(v.organizationId, { ...v }); },
        async update(v) { s.settingsMap.set(v.organizationId, { ...v }); },
      },
      accounts: {
        async findById(org, id) { const a = s.accountMap.get(id); return a && a.organizationId === org ? cloneAccount(a) : null; },
        async findByIds(org, ids) { return ids.map((i) => s.accountMap.get(i)).filter((a): a is Account => !!a && a.organizationId === org).map(cloneAccount); },
        async findByCode(org, code) { const a = orgOf(s.accountMap.values(), org).find((x) => x.code === code); return a ? cloneAccount(a) : null; },
        async list(org, f) {
          return orgOf(s.accountMap.values(), org)
            .filter((a) => (!f?.status || a.status === f.status) && (!f?.type || a.type === f.type))
            .map(cloneAccount);
        },
        async hasMovements(org, id) {
          return [...s.entryMap.values()].some((e) => e.organizationId === org && e.lines.some((l) => l.accountId === id));
        },
        async countActiveChildren(org, id) {
          return orgOf(s.accountMap.values(), org).filter((a) => a.parentId === id && a.status === 'active').length;
        },
        async save(a) {
          const dup = orgOf(s.accountMap.values(), a.organizationId).find((x) => x.code === a.code && x.id !== a.id);
          if (dup) throw Object.assign(new Error('dup'), { name: 'SequelizeUniqueConstraintError' });
          s.accountMap.set(a.id, cloneAccount(a));
        },
        async saveMany(list) { for (const a of list) await this.save(a); },
      },
      costCenters: {
        async findById(org, id) { const c = s.costCenterMap.get(id); return c && c.organizationId === org ? c : null; },
        async findByIds(org, ids) { return ids.map((i) => s.costCenterMap.get(i)).filter((c): c is CostCenter => !!c && c.organizationId === org); },
        async findByCode(org, code) { return orgOf(s.costCenterMap.values(), org).find((c) => c.code === code) ?? null; },
        async list(org, status) { return orgOf(s.costCenterMap.values(), org).filter((c) => !status || c.status === status); },
        async save(c) { s.costCenterMap.set(c.id, CostCenter.fromPersistence(c.toPersistence())); },
      },
      periods: {
        async findYear(org, year) { return orgOf(s.yearMap.values(), org).find((y) => y.year === year) ?? null; },
        async listYears(org) { return orgOf(s.yearMap.values(), org).sort((a, b) => b.year - a.year); },
        async saveYear(y, ps) { s.yearMap.set(y.id, y); for (const p of ps) s.periodMap.set(p.id, p); },
        async listPeriods(org, yearId) { return orgOf(s.periodMap.values(), org).filter((p) => p.fiscalYearId === yearId).sort((a, b) => a.number - b.number); },
        async findPeriodById(org, id) { const p = s.periodMap.get(id); return p && p.organizationId === org ? p : null; },
        async lockPeriodForDate(org, date) { return orgOf(s.periodMap.values(), org).find((p) => p.contains(date)) ?? null; },
        async lockPeriodById(org, id) { const p = s.periodMap.get(id); return p && p.organizationId === org ? p : null; },
        async findYearById(org, id) { const y = s.yearMap.get(id); return y && y.organizationId === org ? y : null; },
        async findYearForDate(org, date) { return orgOf(s.yearMap.values(), org).find((y) => date >= y.startDate && date <= y.endDate) ?? null; },
        async hasOpenPeriodBefore(org, start) { return orgOf(s.periodMap.values(), org).some((p) => p.isOpen() && p.endDate < start); },
        async hasClosedPeriodAfter(org, end) { return orgOf(s.periodMap.values(), org).some((p) => !p.isOpen() && p.startDate > end); },
        async save(p) { s.periodMap.set(p.id, p); },
      },
      journal: {
        async findById(org, id) { const e = s.entryMap.get(id); return e && e.organizationId === org ? cloneEntry(e) : null; },
        async lockById(org, id) { const e = s.entryMap.get(id); return e && e.organizationId === org ? cloneEntry(e) : null; },
        async findBySource(org, type, id, kind) {
          const e = orgOf(s.entryMap.values(), org).find((x) => x.sourceType === type && x.sourceId === id && x.kind === kind);
          return e ? cloneEntry(e) : null;
        },
        async list(org, f: JournalListFilters) {
          const all = orgOf(s.entryMap.values(), org)
            .filter((e) => (!f.status || e.status === f.status) && (!f.kind || e.kind === f.kind) && (!f.from || e.entryDate >= f.from) && (!f.to || e.entryDate <= f.to))
            .filter((e) => !f.accountId || e.lines.some((l) => l.accountId === f.accountId))
            .filter((e) => !f.search || e.description.toLowerCase().includes(f.search.toLowerCase()))
            .sort((a, b) => b.entryDate.localeCompare(a.entryDate) || (b.number ?? 0) - (a.number ?? 0));
          const items = all.slice((f.page - 1) * f.pageSize, f.page * f.pageSize);
          return { items: items.map((e) => JournalEntry.fromPersistence({ ...e.toPersistence(), lines: [] })), total: all.length };
        },
        async save(e) {
          const existing = s.entryMap.get(e.id);
          if (existing?.status === 'posted') {
            // Un asiento contabilizado solo cambia de encabezado: se conservan sus líneas.
            s.entryMap.set(e.id, JournalEntry.fromPersistence({ ...e.toPersistence(), lines: existing.toPersistence().lines }));
          } else {
            s.entryMap.set(e.id, cloneEntry(e));
          }
        },
        async delete(org, id) { const e = s.entryMap.get(id); if (e?.organizationId === org) s.entryMap.delete(id); },
        async nextNumber(org, year) {
          const key = `${org}:${year}`;
          const n = (s.counters.get(key) ?? 0) + 1;
          s.counters.set(key, n);
          return n;
        },
        async countDraftsInRange(org, from, to) {
          return orgOf(s.entryMap.values(), org).filter((e) => e.status === 'draft' && e.entryDate >= from && e.entryDate <= to).length;
        },
      },
      reports: {
        async sumByAccount(org, f: SumFilters) {
          const sums = new Map<string, AccountSums>();
          for (const e of orgOf(s.entryMap.values(), org)) {
            if (e.status !== 'posted' || e.entryDate > f.to) continue;
            for (const l of e.lines) {
              if (f.costCenterId && l.costCenterId !== f.costCenterId) continue;
              const row = sums.get(l.accountId) ?? { accountId: l.accountId, netBeforeFrom: 0, netBeforeYearStart: 0, debit: 0, credit: 0 };
              const net = l.debitCents - l.creditCents;
              if (e.entryDate < f.from) row.netBeforeFrom += net;
              if (e.entryDate < f.yearStart) row.netBeforeYearStart += net;
              if (e.entryDate >= f.from && e.entryDate <= f.to) {
                row.debit += l.debitCents;
                row.credit += l.creditCents;
              }
              sums.set(l.accountId, row);
            }
          }
          return [...sums.values()];
        },
        async netBefore(org, accountId, before) {
          let net = 0;
          for (const e of orgOf(s.entryMap.values(), org)) {
            if (e.status !== 'posted' || e.entryDate >= before) continue;
            for (const l of e.lines) if (l.accountId === accountId) net += l.debitCents - l.creditCents;
          }
          return net;
        },
        async ledgerLines(org, q: LedgerQuery, opening) {
          const rows: { e: JournalEntry; l: JournalEntry['lines'][number] }[] = [];
          for (const e of orgOf(s.entryMap.values(), org)) {
            if (e.status !== 'posted' || e.entryDate < q.from || e.entryDate > q.to) continue;
            for (const l of e.lines) if (l.accountId === q.accountId) rows.push({ e, l });
          }
          rows.sort((a, b) => a.e.entryDate.localeCompare(b.e.entryDate) || (a.e.number ?? 0) - (b.e.number ?? 0) || a.l.lineNo - b.l.lineNo);
          let running = opening;
          const all: LedgerLine[] = rows.map(({ e, l }) => {
            running += l.debitCents - l.creditCents;
            return {
              entryId: e.id,
              entryNumber: e.number != null && e.fiscalYear != null ? formatEntryNumber(e.fiscalYear, e.number) : null,
              entryDate: e.entryDate,
              description: e.description,
              lineDescription: l.description,
              reference: e.reference,
              debitCents: l.debitCents,
              creditCents: l.creditCents,
              runningCents: running,
              costCenterId: l.costCenterId,
              sourceType: e.sourceType,
              sourceId: e.sourceId,
            };
          });
          return { lines: all.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: all.length };
        },
      },
      pendingPostings: {
        async findById(org, id) { const r = s.pendingMap.get(id); return r && r.organizationId === org ? { ...r } : null; },
        async findBySource(org, eventType, sourceType, sourceId) {
          const r = [...s.pendingMap.values()].find((x) => x.organizationId === org && x.eventType === eventType && x.sourceType === sourceType && x.sourceId === sourceId);
          return r ? { ...r } : null;
        },
        async list(org, f) {
          const all = [...s.pendingMap.values()].filter((x) => x.organizationId === org && (!f.status || x.status === f.status)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return { items: all.slice((f.page - 1) * f.pageSize, f.page * f.pageSize).map((x) => ({ ...x })), total: all.length };
        },
        async listPending(org, limit) {
          return [...s.pendingMap.values()].filter((x) => x.organizationId === org && x.status === 'pending').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, limit).map((x) => ({ ...x }));
        },
        async countPending(org) { return [...s.pendingMap.values()].filter((x) => x.organizationId === org && x.status === 'pending').length; },
        async save(row) { s.pendingMap.set(row.id, { ...row }); },
      },
      outbox: { async add(ev) { s.outboxEvents.push(ev); } },
    };
  }
}

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const USER = '33333333-3333-4333-8333-333333333333';
export const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

export const ALL_PERMISSIONS = [
  'account:read', 'account:manage', 'journal:read', 'journal:create', 'journal:post', 'journal:reverse', 'period:manage', 'ledger:read',
];

/** Reloj fijo para que las pruebas no dependan de la fecha de hoy. */
export const NOW = new Date('2026-10-15T12:00:00Z');

export function buildUseCases(store: InMemoryStore, clock: () => Date = () => NOW): AppDependencies['useCases'] {
  const repos = store.repos;
  return {
    getSettings: new GetSettingsUseCase(repos),
    setup: new SetupAccountingUseCase(store, clock),
    listAccounts: new ListAccountsUseCase(repos),
    getAccount: new GetAccountUseCase(repos),
    createAccount: new CreateAccountUseCase(store),
    updateAccount: new UpdateAccountUseCase(store),
    listCostCenters: new ListCostCentersUseCase(repos),
    createCostCenter: new CreateCostCenterUseCase(store),
    updateCostCenter: new UpdateCostCenterUseCase(store),
    listFiscalYears: new ListFiscalYearsUseCase(repos),
    createFiscalYear: new CreateFiscalYearUseCase(store),
    closePeriod: new ClosePeriodUseCase(store, clock),
    reopenPeriod: new ReopenPeriodUseCase(store, clock),
    listEntries: new ListJournalEntriesUseCase(repos),
    getEntry: new GetJournalEntryUseCase(repos),
    createEntry: new CreateJournalEntryUseCase(store, clock),
    updateEntry: new UpdateJournalEntryUseCase(store),
    deleteEntry: new DeleteJournalEntryUseCase(store),
    postEntry: new PostJournalEntryUseCase(store, clock),
    reverseEntry: new ReverseJournalEntryUseCase(store, clock),
    trialBalance: new TrialBalanceUseCase(repos),
    ledger: new LedgerUseCase(repos),
    balanceSheet: new BalanceSheetUseCase(repos),
    incomeStatement: new IncomeStatementUseCase(repos),
    postingSettings: new GetPostingSettingsUseCase(repos),
    updatePostingSettings: new UpdatePostingSettingsUseCase(store),
    listPending: new ListPendingPostingsUseCase(repos),
    retryPending: new AutomaticPostingUseCase(store, clock, SYSTEM_USER),
    discardPending: new DiscardPendingPostingUseCase(store, clock),
  };
}

/** El mismo caso de uso que usa el consumidor, con su reloj. */
export function buildPosting(store: InMemoryStore, clock: () => Date = () => NOW): AutomaticPostingUseCase {
  return new AutomaticPostingUseCase(store, clock, SYSTEM_USER);
}

export function buildPluginToggle(store: InMemoryStore): SetAutoPostingByPluginUseCase {
  return new SetAutoPostingByPluginUseCase(store);
}

export function buildApp(store: InMemoryStore) {
  return createApp({ useCases: buildUseCases(store), corsOrigin: '*' });
}

/** Una organización con el plan de cuentas de partida y el ejercicio 2026 ya creados. */
export async function setupOrg(store: InMemoryStore, organizationId = ORG_A) {
  const uc = buildUseCases(store);
  await uc.setup.execute({ organizationId, userId: USER, chartTemplate: 'ec-supercias', fiscalYear: 2026 });
  const accounts = await store.repos.accounts.list(organizationId);
  const byCode = (code: string) => {
    const a = accounts.find((x) => x.code === code);
    if (!a) throw new Error(`cuenta ${code} no existe`);
    return a;
  };
  return { uc, byCode };
}

export function headers(org = ORG_A, permissions: string[] = ALL_PERMISSIONS) {
  return {
    'Content-Type': 'application/json',
    'X-Organization-Id': org,
    'X-User-Id': USER,
    'X-Permissions': permissions.join(','),
  };
}
