import { Op, QueryTypes, Transaction, literal } from 'sequelize';
import { withActor } from '@facturero/outbox-relay';
import { sequelize } from './sequelize.js';
import {
  AccountModel,
  CostCenterModel,
  FiscalPeriodModel,
  FiscalYearModel,
  JournalEntryModel,
  JournalLineModel,
  OutboxModel,
  PendingPostingModel,
  SettingsModel,
} from './models.js';
import { Account, CostCenter } from '../../domain/account.js';
import { JournalEntry, type JournalLineProps } from '../../domain/journal.js';
import { FiscalPeriod, FiscalYear } from '../../domain/period.js';
import type { AccountSums, LedgerLine } from '../../domain/reports.js';
import { formatEntryNumber } from '../../domain/journal.js';
import type {
  AccountingSettings,
  AccountRepository,
  CostCenterRepository,
  DomainEvent,
  JournalRepository,
  OutboxRepository,
  PendingPosting,
  PendingPostingRepository,
  PeriodRepository,
  ReportRepository,
  SettingsRepository,
  UnitOfWork,
} from '../../domain/repositories.js';
import type { WriteUnitOfWork } from '../../application/ports.js';

// ── Mappers ─────────────────────────────────────────────────────────────────

function toAccount(m: AccountModel): Account {
  return Account.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    code: m.code,
    name: m.name,
    type: m.type,
    parentId: m.parent_id,
    level: Number(m.level),
    isPostable: Boolean(m.is_postable),
    status: m.status,
    systemRole: m.system_role as Account['systemRole'],
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  });
}

function toCostCenter(m: CostCenterModel): CostCenter {
  return CostCenter.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    code: m.code,
    name: m.name,
    status: m.status,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  });
}

function toYear(m: FiscalYearModel): FiscalYear {
  return FiscalYear.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    year: Number(m.year),
    startDate: m.start_date,
    endDate: m.end_date,
    createdAt: m.created_at,
  });
}

function toPeriod(m: FiscalPeriodModel): FiscalPeriod {
  return FiscalPeriod.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    fiscalYearId: m.fiscal_year_id,
    number: Number(m.number),
    startDate: m.start_date,
    endDate: m.end_date,
    status: m.status,
    closedAt: m.closed_at,
    closedBy: m.closed_by,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  });
}

function toLine(m: JournalLineModel): JournalLineProps {
  return {
    id: m.id,
    lineNo: Number(m.line_no),
    accountId: m.account_id,
    debitCents: Number(m.debit_cents),
    creditCents: Number(m.credit_cents),
    description: m.description,
    costCenterId: m.cost_center_id,
    projectId: m.project_id,
    establishmentId: m.establishment_id,
    partyType: m.party_type,
    partyId: m.party_id,
    currencyCode: m.currency_code,
    amountFcCents: m.amount_fc_cents == null ? null : Number(m.amount_fc_cents),
    exchangeRate: m.exchange_rate == null ? null : Number(m.exchange_rate),
  };
}

function toEntry(m: JournalEntryModel, lines: JournalLineModel[]): JournalEntry {
  return JournalEntry.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    number: m.number == null ? null : Number(m.number),
    fiscalYear: m.fiscal_year == null ? null : Number(m.fiscal_year),
    entryDate: m.entry_date,
    periodId: m.period_id,
    description: m.description,
    reference: m.reference,
    status: m.status,
    kind: m.kind,
    sourceType: m.source_type,
    sourceId: m.source_id,
    currencyCode: m.currency_code,
    totalDebitCents: Number(m.total_debit_cents),
    totalCreditCents: Number(m.total_credit_cents),
    reversesEntryId: m.reverses_entry_id,
    reversedByEntryId: m.reversed_by_entry_id,
    reversalReason: m.reversal_reason,
    createdBy: m.created_by,
    postedBy: m.posted_by,
    postedAt: m.posted_at,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    lines: lines.map(toLine).sort((a, b) => a.lineNo - b.lineNo),
  });
}

// ── Repositorios ────────────────────────────────────────────────────────────

function toSettings(m: SettingsModel): AccountingSettings {
  return {
    organizationId: m.organization_id,
    chartTemplate: m.chart_template,
    baseCurrency: m.base_currency,
    fiscalYearStartMonth: Number(m.fiscal_year_start_month),
    initializedBy: m.initialized_by,
    initializedAt: m.initialized_at,
    timezone: m.timezone,
    autoPosting: Boolean(m.auto_posting),
    autoPostingFrom: m.auto_posting_from,
    paymentMethodRoles: (m.payment_method_roles ?? null) as AccountingSettings['paymentMethodRoles'],
  };
}

function settingsValues(s: AccountingSettings) {
  return {
    organization_id: s.organizationId,
    chart_template: s.chartTemplate,
    base_currency: s.baseCurrency,
    fiscal_year_start_month: s.fiscalYearStartMonth,
    initialized_by: s.initializedBy,
    initialized_at: s.initializedAt,
    timezone: s.timezone,
    auto_posting: s.autoPosting,
    auto_posting_from: s.autoPostingFrom,
    payment_method_roles: s.paymentMethodRoles,
  };
}

function settingsRepository(tx?: Transaction): SettingsRepository {
  return {
    async find(organizationId) {
      const m = await SettingsModel.findByPk(organizationId, { transaction: tx });
      return m ? toSettings(m) : null;
    },
    async create(s) {
      await SettingsModel.create(settingsValues(s), { transaction: tx });
    },
    async update(s) {
      const { organization_id: _id, ...rest } = settingsValues(s);
      await SettingsModel.update(rest, { where: { organization_id: s.organizationId }, transaction: tx });
    },
  };
}

function toPending(m: PendingPostingModel): PendingPosting {
  return {
    id: m.id,
    organizationId: m.organization_id,
    eventType: m.event_type,
    sourceType: m.source_type,
    sourceId: m.source_id,
    payload: m.payload,
    reasonCode: m.reason_code,
    reasonMessage: m.reason_message,
    status: m.status,
    attempts: Number(m.attempts),
    entryId: m.entry_id,
    entryDate: m.entry_date,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    resolvedAt: m.resolved_at,
  };
}

function pendingPostingRepository(tx?: Transaction): PendingPostingRepository {
  return {
    async findById(organizationId, id) {
      const m = await PendingPostingModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toPending(m) : null;
    },
    async findBySource(organizationId, eventType, sourceType, sourceId) {
      const m = await PendingPostingModel.findOne({
        where: { organization_id: organizationId, event_type: eventType, source_type: sourceType, source_id: sourceId },
        transaction: tx,
      });
      return m ? toPending(m) : null;
    },
    async list(organizationId, filters) {
      const where: Record<string, unknown> = { organization_id: organizationId };
      if (filters.status) where.status = filters.status;
      const { rows, count } = await PendingPostingModel.findAndCountAll({
        where,
        order: [['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      return { items: rows.map(toPending), total: count };
    },
    async listPending(organizationId, limit) {
      const rows = await PendingPostingModel.findAll({
        where: { organization_id: organizationId, status: 'pending' },
        order: [['created_at', 'ASC']],
        limit,
        transaction: tx,
      });
      return rows.map(toPending);
    },
    async countPending(organizationId) {
      return PendingPostingModel.count({ where: { organization_id: organizationId, status: 'pending' }, transaction: tx });
    },
    async save(row) {
      const values = {
        id: row.id,
        organization_id: row.organizationId,
        event_type: row.eventType,
        source_type: row.sourceType,
        source_id: row.sourceId,
        payload: row.payload,
        reason_code: row.reasonCode,
        reason_message: row.reasonMessage,
        status: row.status,
        attempts: row.attempts,
        entry_id: row.entryId,
        entry_date: row.entryDate,
        updated_at: row.updatedAt,
        resolved_at: row.resolvedAt,
      };
      if (await PendingPostingModel.findByPk(row.id, { attributes: ['id'], transaction: tx })) {
        await PendingPostingModel.update(values, { where: { id: row.id }, transaction: tx });
      } else {
        await PendingPostingModel.create({ ...values, created_at: row.createdAt }, { transaction: tx });
      }
    },
  };
}

function accountValues(a: Account) {
  const p = a.toPersistence();
  return {
    id: p.id,
    organization_id: p.organizationId,
    code: p.code,
    name: p.name,
    type: p.type,
    parent_id: p.parentId,
    level: p.level,
    is_postable: p.isPostable,
    status: p.status,
    system_role: p.systemRole,
    updated_at: new Date(),
    created_at: p.createdAt,
  };
}

function accountRepository(tx?: Transaction): AccountRepository {
  const repo: AccountRepository = {
    async findById(organizationId, accountId) {
      const m = await AccountModel.findOne({ where: { id: accountId, organization_id: organizationId }, transaction: tx });
      return m ? toAccount(m) : null;
    },
    async findByIds(organizationId, ids) {
      if (ids.length === 0) return [];
      const rows = await AccountModel.findAll({ where: { organization_id: organizationId, id: { [Op.in]: ids } }, transaction: tx });
      return rows.map(toAccount);
    },
    async findByCode(organizationId, code) {
      const m = await AccountModel.findOne({ where: { organization_id: organizationId, code }, transaction: tx });
      return m ? toAccount(m) : null;
    },
    async list(organizationId, filters) {
      const where: Record<string, unknown> = { organization_id: organizationId };
      if (filters?.status) where.status = filters.status;
      if (filters?.type) where.type = filters.type;
      const rows = await AccountModel.findAll({ where, transaction: tx });
      return rows.map(toAccount);
    },
    async hasMovements(organizationId, accountId) {
      return (await JournalLineModel.count({ where: { organization_id: organizationId, account_id: accountId }, transaction: tx })) > 0;
    },
    async countActiveChildren(organizationId, accountId) {
      return AccountModel.count({ where: { organization_id: organizationId, parent_id: accountId, status: 'active' }, transaction: tx });
    },
    async save(account) {
      const values = accountValues(account);
      // findByPk + update/create, nunca `upsert`: ON DUPLICATE KEY UPDATE reacciona a CUALQUIER índice único y pisaría en silencio
      // la cuenta que tenga el mismo código (ver persistence-guard.test.ts).
      if (await AccountModel.findByPk(values.id, { attributes: ['id'], transaction: tx })) {
        const { created_at: _created, ...rest } = values;
        await AccountModel.update(rest, { where: { id: values.id }, transaction: tx });
      } else {
        await AccountModel.create(values, { transaction: tx });
      }
    },
    async saveMany(accounts) {
      for (const account of accounts) await repo.save(account);
    },
  };
  return repo;
}

function costCenterRepository(tx?: Transaction): CostCenterRepository {
  return {
    async findById(organizationId, id) {
      const m = await CostCenterModel.findOne({ where: { id, organization_id: organizationId }, transaction: tx });
      return m ? toCostCenter(m) : null;
    },
    async findByIds(organizationId, ids) {
      if (ids.length === 0) return [];
      const rows = await CostCenterModel.findAll({ where: { organization_id: organizationId, id: { [Op.in]: ids } }, transaction: tx });
      return rows.map(toCostCenter);
    },
    async findByCode(organizationId, code) {
      const m = await CostCenterModel.findOne({ where: { organization_id: organizationId, code }, transaction: tx });
      return m ? toCostCenter(m) : null;
    },
    async list(organizationId, status) {
      const where: Record<string, unknown> = { organization_id: organizationId };
      if (status) where.status = status;
      const rows = await CostCenterModel.findAll({ where, order: [['code', 'ASC']], transaction: tx });
      return rows.map(toCostCenter);
    },
    async save(cc) {
      const p = cc.toPersistence();
      const values = { id: p.id, organization_id: p.organizationId, code: p.code, name: p.name, status: p.status, updated_at: new Date() };
      if (await CostCenterModel.findByPk(p.id, { attributes: ['id'], transaction: tx })) {
        await CostCenterModel.update(values, { where: { id: p.id }, transaction: tx });
      } else {
        await CostCenterModel.create({ ...values, created_at: p.createdAt }, { transaction: tx });
      }
    },
  };
}

function periodRepository(tx?: Transaction): PeriodRepository {
  async function lockedPeriod(where: Record<string, unknown>, mode: 'share' | 'update'): Promise<FiscalPeriod | null> {
    if (!tx) throw new Error('Un bloqueo de periodo necesita una transacción.');
    const m = await FiscalPeriodModel.findOne({ where, transaction: tx, lock: mode === 'share' ? tx.LOCK.SHARE : tx.LOCK.UPDATE });
    return m ? toPeriod(m) : null;
  }

  return {
    async findYear(organizationId, year) {
      const m = await FiscalYearModel.findOne({ where: { organization_id: organizationId, year }, transaction: tx });
      return m ? toYear(m) : null;
    },
    async findYearById(organizationId, fiscalYearId) {
      const m = await FiscalYearModel.findOne({ where: { id: fiscalYearId, organization_id: organizationId }, transaction: tx });
      return m ? toYear(m) : null;
    },
    async findYearForDate(organizationId, date) {
      const m = await FiscalYearModel.findOne({
        where: { organization_id: organizationId, start_date: { [Op.lte]: date }, end_date: { [Op.gte]: date } },
        transaction: tx,
      });
      return m ? toYear(m) : null;
    },
    async listYears(organizationId) {
      const rows = await FiscalYearModel.findAll({ where: { organization_id: organizationId }, order: [['year', 'DESC']], transaction: tx });
      return rows.map(toYear);
    },
    async saveYear(year, periods) {
      const y = year.toPersistence();
      await FiscalYearModel.create(
        { id: y.id, organization_id: y.organizationId, year: y.year, start_date: y.startDate, end_date: y.endDate, created_at: y.createdAt },
        { transaction: tx },
      );
      // El contador de numeración nace con el ejercicio: así `nextNumber` solo hace UPDATE (ver allí por qué).
      await sequelize.query('INSERT IGNORE INTO entry_sequences (organization_id, fiscal_year, last_number) VALUES (:org, :year, 0)', {
        replacements: { org: y.organizationId, year: y.year },
        transaction: tx,
      });
      await FiscalPeriodModel.bulkCreate(
        periods.map((period) => {
          const p = period.toPersistence();
          return {
            id: p.id,
            organization_id: p.organizationId,
            fiscal_year_id: p.fiscalYearId,
            number: p.number,
            start_date: p.startDate,
            end_date: p.endDate,
            status: p.status,
            closed_at: p.closedAt,
            closed_by: p.closedBy,
            created_at: p.createdAt,
            updated_at: p.updatedAt,
          };
        }),
        { transaction: tx },
      );
    },
    async listPeriods(organizationId, fiscalYearId) {
      const rows = await FiscalPeriodModel.findAll({
        where: { organization_id: organizationId, fiscal_year_id: fiscalYearId },
        order: [['number', 'ASC']],
        transaction: tx,
      });
      return rows.map(toPeriod);
    },
    async findPeriodById(organizationId, periodId) {
      const m = await FiscalPeriodModel.findOne({ where: { id: periodId, organization_id: organizationId }, transaction: tx });
      return m ? toPeriod(m) : null;
    },
    async lockPeriodForDate(organizationId, date) {
      return lockedPeriod({ organization_id: organizationId, start_date: { [Op.lte]: date }, end_date: { [Op.gte]: date } }, 'share');
    },
    async lockPeriodById(organizationId, periodId) {
      return lockedPeriod({ id: periodId, organization_id: organizationId }, 'update');
    },
    async hasOpenPeriodBefore(organizationId, startDate) {
      return (await FiscalPeriodModel.count({ where: { organization_id: organizationId, status: 'open', end_date: { [Op.lt]: startDate } }, transaction: tx })) > 0;
    },
    async hasClosedPeriodAfter(organizationId, endDate) {
      return (await FiscalPeriodModel.count({ where: { organization_id: organizationId, status: 'closed', start_date: { [Op.gt]: endDate } }, transaction: tx })) > 0;
    },
    async save(period) {
      const p = period.toPersistence();
      await FiscalPeriodModel.update(
        { status: p.status, closed_at: p.closedAt, closed_by: p.closedBy, updated_at: p.updatedAt },
        { where: { id: p.id, organization_id: p.organizationId }, transaction: tx },
      );
    },
  };
}

function entryValues(entry: JournalEntry) {
  const p = entry.toPersistence();
  return {
    id: p.id,
    organization_id: p.organizationId,
    number: p.number,
    fiscal_year: p.fiscalYear,
    entry_date: p.entryDate,
    period_id: p.periodId,
    description: p.description,
    reference: p.reference,
    status: p.status,
    kind: p.kind,
    source_type: p.sourceType,
    source_id: p.sourceId,
    currency_code: p.currencyCode,
    total_debit_cents: p.totalDebitCents,
    total_credit_cents: p.totalCreditCents,
    reverses_entry_id: p.reversesEntryId,
    reversed_by_entry_id: p.reversedByEntryId,
    reversal_reason: p.reversalReason,
    created_by: p.createdBy,
    posted_by: p.postedBy,
    posted_at: p.postedAt,
    updated_at: new Date(),
    created_at: p.createdAt,
  };
}

function lineRows(entry: JournalEntry) {
  const p = entry.toPersistence();
  return p.lines.map((l) => ({
    id: l.id,
    entry_id: p.id,
    organization_id: p.organizationId,
    line_no: l.lineNo,
    account_id: l.accountId,
    debit_cents: l.debitCents,
    credit_cents: l.creditCents,
    description: l.description,
    cost_center_id: l.costCenterId,
    project_id: l.projectId,
    establishment_id: l.establishmentId,
    party_type: l.partyType,
    party_id: l.partyId,
    currency_code: l.currencyCode,
    amount_fc_cents: l.amountFcCents,
    exchange_rate: l.exchangeRate,
    entry_date: p.entryDate,
    is_posted: p.status === 'posted',
  }));
}

function journalRepository(tx?: Transaction): JournalRepository {
  async function load(m: JournalEntryModel, lock?: 'update'): Promise<JournalEntry> {
    // Las líneas de un asiento bloqueado también se leen con bloqueo: una lectura normal podría ver la «foto» de antes de que otra
    // transacción confirmara un cambio mientras esta esperaba el bloqueo del encabezado.
    const lines = await JournalLineModel.findAll({
      where: { entry_id: m.id },
      transaction: tx,
      ...(lock && tx ? { lock: tx.LOCK.UPDATE } : {}),
    });
    return toEntry(m, lines);
  }

  return {
    async findById(organizationId, entryId) {
      const m = await JournalEntryModel.findOne({ where: { id: entryId, organization_id: organizationId }, transaction: tx });
      return m ? load(m) : null;
    },
    async lockById(organizationId, entryId) {
      if (!tx) throw new Error('Un bloqueo de asiento necesita una transacción.');
      const m = await JournalEntryModel.findOne({ where: { id: entryId, organization_id: organizationId }, transaction: tx, lock: tx.LOCK.UPDATE });
      return m ? load(m, 'update') : null;
    },
    async findBySource(organizationId, sourceType, sourceId, kind) {
      const m = await JournalEntryModel.findOne({
        where: { organization_id: organizationId, source_type: sourceType, source_id: sourceId, kind },
        transaction: tx,
      });
      return m ? load(m) : null;
    },
    async list(organizationId, filters) {
      const where: Record<string, unknown> = { organization_id: organizationId };
      if (filters.status) where.status = filters.status;
      if (filters.kind) where.kind = filters.kind;
      if (filters.sourceType) where.source_type = filters.sourceType;
      if (filters.from || filters.to) {
        where.entry_date = { ...(filters.from ? { [Op.gte]: filters.from } : {}), ...(filters.to ? { [Op.lte]: filters.to } : {}) };
      }
      const and: unknown[] = [];
      if (filters.accountId) {
        and.push(
          literal(
            `id IN (SELECT entry_id FROM journal_lines WHERE organization_id = ${sequelize.escape(organizationId)} AND account_id = ${sequelize.escape(filters.accountId)})`,
          ),
        );
      }
      if (filters.search) {
        const like = `%${filters.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        and.push({ [Op.or]: [{ description: { [Op.like]: like } }, { reference: { [Op.like]: like } }] });
      }
      if (and.length > 0) where[Op.and as unknown as string] = and;

      const { rows, count } = await JournalEntryModel.findAndCountAll({
        where,
        order: [['entry_date', 'DESC'], ['fiscal_year', 'DESC'], ['number', 'DESC'], ['created_at', 'DESC']],
        limit: filters.pageSize,
        offset: (filters.page - 1) * filters.pageSize,
        transaction: tx,
      });
      // Los listados llevan solo el encabezado (con los totales): las líneas se piden en el detalle.
      return { items: rows.map((m) => toEntry(m, [])), total: count };
    },
    async save(entry) {
      const values = entryValues(entry);
      const existing = await JournalEntryModel.findByPk(values.id, { attributes: ['id', 'status'], transaction: tx });
      if (!existing) {
        await JournalEntryModel.create(values, { transaction: tx });
        await JournalLineModel.bulkCreate(lineRows(entry), { transaction: tx });
        return;
      }
      const { created_at: _created, ...rest } = values;
      await JournalEntryModel.update(rest, { where: { id: values.id }, transaction: tx });
      // Un asiento contabilizado es inmutable: solo cambia su encabezado (p. ej. la marca de reversado). Un borrador sí reescribe
      // sus líneas, y al contabilizarlo estas pasan a `is_posted`.
      if (existing.status === 'draft') {
        await JournalLineModel.destroy({ where: { entry_id: values.id }, transaction: tx });
        await JournalLineModel.bulkCreate(lineRows(entry), { transaction: tx });
      }
    },
    async delete(organizationId, entryId) {
      await JournalLineModel.destroy({ where: { entry_id: entryId, organization_id: organizationId }, transaction: tx });
      await JournalEntryModel.destroy({ where: { id: entryId, organization_id: organizationId }, transaction: tx });
    },
    async nextNumber(organizationId, fiscalYear) {
      if (!tx) throw new Error('Numerar un asiento necesita una transacción.');
      const replacements = { org: organizationId, year: fiscalYear };
      // El UPDATE toma el bloqueo EXCLUSIVO de la fila contador y lo mantiene hasta el commit: dos asientos que se contabilizan a la
      // vez se numeran uno detrás de otro, sin repetir ni dejar huecos. Debe ser lo PRIMERO que se hace con la fila: un INSERT
      // IGNORE previo sobre una fila ya existente toma un bloqueo COMPARTIDO, y dos transacciones que lo tienen a la vez se
      // interbloquean al pedir el exclusivo (se vio contra MySQL real: 23 de 30 contabilizaciones simultáneas morían).
      const read = () =>
        sequelize.query<{ last_number: number }>('SELECT last_number FROM entry_sequences WHERE organization_id = :org AND fiscal_year = :year', {
          replacements,
          type: QueryTypes.SELECT,
          transaction: tx,
        });
      const bump = () =>
        sequelize.query('UPDATE entry_sequences SET last_number = last_number + 1 WHERE organization_id = :org AND fiscal_year = :year', {
          replacements,
          transaction: tx,
        });
      await bump();
      let rows = await read();
      if (rows.length === 0) {
        // El contador de un ejercicio se crea con el ejercicio (`saveYear`); esto solo cubre ejercicios anteriores a esa regla.
        await sequelize.query('INSERT IGNORE INTO entry_sequences (organization_id, fiscal_year, last_number) VALUES (:org, :year, 0)', {
          replacements,
          transaction: tx,
        });
        await bump();
        rows = await read();
      }
      return Number(rows[0]!.last_number);
    },
    async countDraftsInRange(organizationId, from, to) {
      return JournalEntryModel.count({
        where: { organization_id: organizationId, status: 'draft', entry_date: { [Op.between]: [from, to] } },
        transaction: tx,
      });
    },
  };
}

function reportRepository(tx?: Transaction): ReportRepository {
  return {
    async sumByAccount(organizationId, f) {
      const rows = await sequelize.query<{
        account_id: string;
        net_before_from: string;
        net_before_year: string;
        debit: string;
        credit: string;
      }>(
        `SELECT account_id,
                SUM(CASE WHEN entry_date < :from THEN debit_cents - credit_cents ELSE 0 END) AS net_before_from,
                SUM(CASE WHEN entry_date < :yearStart THEN debit_cents - credit_cents ELSE 0 END) AS net_before_year,
                SUM(CASE WHEN entry_date BETWEEN :from AND :to THEN debit_cents ELSE 0 END) AS debit,
                SUM(CASE WHEN entry_date BETWEEN :from AND :to THEN credit_cents ELSE 0 END) AS credit
           FROM journal_lines
          WHERE organization_id = :org AND is_posted = 1 AND entry_date <= :to
            ${f.costCenterId ? 'AND cost_center_id = :cc' : ''}
          GROUP BY account_id`,
        {
          replacements: { org: organizationId, from: f.from, to: f.to, yearStart: f.yearStart, cc: f.costCenterId ?? null },
          type: QueryTypes.SELECT,
          transaction: tx,
        },
      );
      return rows.map((r): AccountSums => ({
        accountId: r.account_id,
        netBeforeFrom: Number(r.net_before_from),
        netBeforeYearStart: Number(r.net_before_year),
        debit: Number(r.debit),
        credit: Number(r.credit),
      }));
    },
    async netBefore(organizationId, accountId, before) {
      const rows = await sequelize.query<{ net: string | null }>(
        `SELECT COALESCE(SUM(debit_cents - credit_cents), 0) AS net
           FROM journal_lines
          WHERE organization_id = :org AND account_id = :acc AND is_posted = 1 AND entry_date < :before`,
        { replacements: { org: organizationId, acc: accountId, before }, type: QueryTypes.SELECT, transaction: tx },
      );
      return Number(rows[0]?.net ?? 0);
    },
    async ledgerLines(organizationId, q, openingCents) {
      const base = { org: organizationId, acc: q.accountId, from: q.from, to: q.to };
      const totalRows = await sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM journal_lines
          WHERE organization_id = :org AND account_id = :acc AND is_posted = 1 AND entry_date BETWEEN :from AND :to`,
        { replacements: base, type: QueryTypes.SELECT, transaction: tx },
      );
      // El saldo acumulado se calcula sobre TODAS las líneas del rango y la página se recorta después: así el saldo de la página 2
      // sigue de donde terminó la 1.
      const rows = await sequelize.query<{
        entry_id: string;
        number: number | null;
        fiscal_year: number | null;
        entry_date: string;
        description: string;
        line_description: string | null;
        reference: string | null;
        debit_cents: string;
        credit_cents: string;
        cost_center_id: string | null;
        source_type: string | null;
        source_id: string | null;
        running: string;
      }>(
        `SELECT * FROM (
           SELECT l.entry_id, e.number, e.fiscal_year, l.entry_date, e.description, l.description AS line_description, e.reference,
                  l.debit_cents, l.credit_cents, l.cost_center_id, e.source_type, e.source_id, l.line_no, l.id AS line_id,
                  :opening + SUM(l.debit_cents - l.credit_cents) OVER (ORDER BY l.entry_date, e.fiscal_year, e.number, l.line_no, l.id) AS running
             FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
            WHERE l.organization_id = :org AND l.account_id = :acc AND l.is_posted = 1 AND l.entry_date BETWEEN :from AND :to
         ) t
         ORDER BY entry_date, fiscal_year, number, line_no, line_id
         LIMIT :limit OFFSET :offset`,
        {
          replacements: { ...base, opening: openingCents, limit: q.pageSize, offset: (q.page - 1) * q.pageSize },
          type: QueryTypes.SELECT,
          transaction: tx,
        },
      );
      const lines = rows.map((r): LedgerLine => ({
        entryId: r.entry_id,
        entryNumber: r.number != null && r.fiscal_year != null ? formatEntryNumber(Number(r.fiscal_year), Number(r.number)) : null,
        entryDate: r.entry_date,
        description: r.description,
        lineDescription: r.line_description,
        reference: r.reference,
        debitCents: Number(r.debit_cents),
        creditCents: Number(r.credit_cents),
        runningCents: Number(r.running),
        costCenterId: r.cost_center_id,
        sourceType: r.source_type,
        sourceId: r.source_id,
      }));
      return { lines, total: Number(totalRows[0]?.n ?? 0) };
    },
  };
}

function outboxRepository(tx?: Transaction): OutboxRepository {
  return {
    async add(event: DomainEvent) {
      await OutboxModel.create(
        {
          id: event.eventId,
          aggregate_type: event.aggregateType,
          aggregate_id: event.aggregateId,
          type: event.type,
          // El actor/IP/request-id viajan en el contexto de la petición para que la bitácora sepa QUIÉN hizo cada cosa.
          payload: withActor(event.payload),
          occurred_at: event.occurredAt,
          processed_at: null,
        },
        { transaction: tx },
      );
    },
  };
}

// ── Ensamblaje ──────────────────────────────────────────────────────────────

export function buildRepositories(tx?: Transaction): UnitOfWork {
  return {
    settings: settingsRepository(tx),
    accounts: accountRepository(tx),
    costCenters: costCenterRepository(tx),
    periods: periodRepository(tx),
    journal: journalRepository(tx),
    reports: reportRepository(tx),
    pendingPostings: pendingPostingRepository(tx),
    outbox: outboxRepository(tx),
  };
}

/** UnitOfWork de lectura directa, sin transacción (listados, consultas). */
export const readOnlyRepositories: UnitOfWork = buildRepositories(undefined);

export class SequelizeUnitOfWork implements WriteUnitOfWork {
  readonly settings;
  readonly accounts;
  readonly costCenters;
  readonly periods;
  readonly journal;
  readonly reports;
  readonly pendingPostings;
  readonly outbox;

  constructor(readonly tx: Transaction) {
    const repos = buildRepositories(tx);
    this.settings = repos.settings;
    this.accounts = repos.accounts;
    this.costCenters = repos.costCenters;
    this.periods = repos.periods;
    this.journal = repos.journal;
    this.reports = repos.reports;
    this.pendingPostings = repos.pendingPostings;
    this.outbox = repos.outbox;
  }

  async commit(): Promise<void> {
    await this.tx.commit();
  }

  async rollback(): Promise<void> {
    // MySQL deshace por su cuenta la transacción que pierde un interbloqueo; volver a deshacerla lanzaría un error que taparía el
    // verdadero (el interbloqueo).
    if ((this.tx as unknown as { finished?: string }).finished) return;
    await this.tx.rollback();
  }
}

export class SequelizeUnitOfWorkFactory {
  constructor(private readonly onCommit?: (tx: Transaction) => void) {}

  async begin(): Promise<SequelizeUnitOfWork> {
    const tx = await sequelize.transaction();
    // El relay publica el outbox justo tras el commit; sin este enganche los eventos esperan los 30 s del temporizador de respaldo.
    this.onCommit?.(tx);
    return new SequelizeUnitOfWork(tx);
  }
}
