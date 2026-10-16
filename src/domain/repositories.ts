import type { Account, CostCenter, EntityStatus } from './account.js';
import type { JournalEntry } from './journal.js';
import type { FiscalPeriod, FiscalYear, LocalDate } from './period.js';
import type { CollectionRole } from './posting.js';
import type { AccountSums, LedgerLine } from './reports.js';

export interface DomainEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface OutboxRepository {
  add(event: DomainEvent): Promise<void>;
}

export interface AccountingSettings {
  organizationId: string;
  chartTemplate: string;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  initializedBy: string;
  initializedAt: Date;
  /** Zona horaria de la organización: de ella sale la fecha contable de los eventos (una venta a las 20:00 no es «mañana»). */
  timezone: string;
  /** Interruptor de la contabilización automática. Se apaga solo si el módulo se desactiva; mientras está apagado los eventos
   *  quedan pendientes (no se pierden). */
  autoPosting: boolean;
  /** Solo se contabilizan solos los documentos con fecha desde este día: lo anterior se carga como saldos iniciales. */
  autoPostingFrom: string | null;
  /** Forma de pago del SRI → dónde se cobra (caja, bancos o por cobrar). `null` = valores por defecto. */
  paymentMethodRoles: Record<string, CollectionRole> | null;
}

export interface SettingsRepository {
  find(organizationId: string): Promise<AccountingSettings | null>;
  create(settings: AccountingSettings): Promise<void>;
  update(settings: AccountingSettings): Promise<void>;
}

export type PendingStatus = 'pending' | 'posted' | 'discarded';

/** Un evento que debía generar asiento y no pudo (periodo cerrado, cuenta sin rol…). Se guarda con su contenido para reintentarlo. */
export interface PendingPosting {
  id: string;
  organizationId: string;
  eventType: string;
  sourceType: string;
  sourceId: string;
  payload: Record<string, unknown>;
  reasonCode: string;
  reasonMessage: string;
  status: PendingStatus;
  attempts: number;
  entryId: string | null;
  entryDate: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}

export interface PendingPostingRepository {
  findById(organizationId: string, id: string): Promise<PendingPosting | null>;
  findBySource(organizationId: string, eventType: string, sourceType: string, sourceId: string): Promise<PendingPosting | null>;
  list(organizationId: string, filters: { status?: PendingStatus; page: number; pageSize: number }): Promise<{ items: PendingPosting[]; total: number }>;
  /** Los pendientes más antiguos primero, para reintentarlos en orden. */
  listPending(organizationId: string, limit: number): Promise<PendingPosting[]>;
  countPending(organizationId: string): Promise<number>;
  save(row: PendingPosting): Promise<void>;
}

export interface AccountListFilters {
  status?: EntityStatus;
  type?: string;
}

export interface AccountRepository {
  findById(organizationId: string, accountId: string): Promise<Account | null>;
  findByIds(organizationId: string, ids: string[]): Promise<Account[]>;
  findByCode(organizationId: string, code: string): Promise<Account | null>;
  list(organizationId: string, filters?: AccountListFilters): Promise<Account[]>;
  /** ¿Tiene alguna línea de asiento (borrador o contabilizada)? Una cuenta con movimientos no puede pasar a ser de agrupación. */
  hasMovements(organizationId: string, accountId: string): Promise<boolean>;
  countActiveChildren(organizationId: string, accountId: string): Promise<number>;
  save(account: Account): Promise<void>;
  saveMany(accounts: Account[]): Promise<void>;
}

export interface CostCenterRepository {
  findById(organizationId: string, id: string): Promise<CostCenter | null>;
  findByIds(organizationId: string, ids: string[]): Promise<CostCenter[]>;
  findByCode(organizationId: string, code: string): Promise<CostCenter | null>;
  list(organizationId: string, status?: EntityStatus): Promise<CostCenter[]>;
  save(costCenter: CostCenter): Promise<void>;
}

export interface PeriodRepository {
  findYear(organizationId: string, year: number): Promise<FiscalYear | null>;
  listYears(organizationId: string): Promise<FiscalYear[]>;
  saveYear(year: FiscalYear, periods: FiscalPeriod[]): Promise<void>;
  listPeriods(organizationId: string, fiscalYearId: string): Promise<FiscalPeriod[]>;
  findPeriodById(organizationId: string, periodId: string): Promise<FiscalPeriod | null>;
  /**
   * Periodo que contiene la fecha, leído CON BLOQUEO COMPARTIDO dentro de la transacción: contabilizar y cerrar el periodo no
   * pueden cruzarse. Bajo REPEATABLE READ una lectura normal vería la «foto» anterior al cierre (ver persistence-guard.test.ts).
   */
  lockPeriodForDate(organizationId: string, date: LocalDate): Promise<FiscalPeriod | null>;
  /** El periodo con bloqueo exclusivo, para cerrarlo o reabrirlo. */
  lockPeriodById(organizationId: string, periodId: string): Promise<FiscalPeriod | null>;
  findYearById(organizationId: string, fiscalYearId: string): Promise<FiscalYear | null>;
  /** Ejercicio que contiene la fecha, sin bloqueo (informes). */
  findYearForDate(organizationId: string, date: LocalDate): Promise<FiscalYear | null>;
  hasOpenPeriodBefore(organizationId: string, startDate: LocalDate): Promise<boolean>;
  hasClosedPeriodAfter(organizationId: string, endDate: LocalDate): Promise<boolean>;
  save(period: FiscalPeriod): Promise<void>;
}

export interface JournalListFilters {
  status?: 'draft' | 'posted';
  kind?: string;
  from?: LocalDate;
  to?: LocalDate;
  sourceType?: string;
  accountId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export interface JournalRepository {
  findById(organizationId: string, entryId: string): Promise<JournalEntry | null>;
  /** El asiento con bloqueo exclusivo, para contabilizarlo o reversarlo sin que otra petición lo toque a la vez. */
  lockById(organizationId: string, entryId: string): Promise<JournalEntry | null>;
  findBySource(organizationId: string, sourceType: string, sourceId: string, kind: string): Promise<JournalEntry | null>;
  list(organizationId: string, filters: JournalListFilters): Promise<{ items: JournalEntry[]; total: number }>;
  /** Inserta o reemplaza el asiento y sus líneas (solo borradores pueden cambiar de líneas). Nunca `upsert`. */
  save(entry: JournalEntry): Promise<void>;
  delete(organizationId: string, entryId: string): Promise<void>;
  /** Siguiente número del ejercicio, con bloqueo de la fila contador: sin huecos ni repetidos aunque dos asientos se contabilicen a la vez. */
  nextNumber(organizationId: string, fiscalYear: number): Promise<number>;
  countDraftsInRange(organizationId: string, from: LocalDate, to: LocalDate): Promise<number>;
}

export interface SumFilters {
  from: LocalDate;
  to: LocalDate;
  yearStart: LocalDate;
  costCenterId?: string;
}

export interface LedgerQuery {
  accountId: string;
  from: LocalDate;
  to: LocalDate;
  page: number;
  pageSize: number;
}

export interface ReportRepository {
  sumByAccount(organizationId: string, filters: SumFilters): Promise<AccountSums[]>;
  /** Neto (debe - haber) de una cuenta antes de `before`. */
  netBefore(organizationId: string, accountId: string, before: LocalDate): Promise<number>;
  ledgerLines(organizationId: string, query: LedgerQuery, openingCents: number): Promise<{ lines: LedgerLine[]; total: number }>;
}

/** Unidad de trabajo: todos los repositorios comparten la misma transacción. */
export interface UnitOfWork {
  settings: SettingsRepository;
  accounts: AccountRepository;
  costCenters: CostCenterRepository;
  periods: PeriodRepository;
  journal: JournalRepository;
  reports: ReportRepository;
  pendingPostings: PendingPostingRepository;
  outbox: OutboxRepository;
}
