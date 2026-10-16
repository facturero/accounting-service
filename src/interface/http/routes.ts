import { Hono, type Context } from 'hono';
import type { AccountType, EntityStatus, SystemRole } from '../../domain/account.js';
import type { JournalLineInput } from '../../domain/journal.js';
import type { ChartTemplateCode } from '../../domain/chart-template.js';
import { ValidationError } from '../../domain/errors.js';
import { isLocalDate } from '../../domain/period.js';
import type { GetSettingsUseCase, SetupAccountingUseCase } from '../../application/use-cases/setup.js';
import type {
  CreateAccountUseCase,
  CreateCostCenterUseCase,
  GetAccountUseCase,
  ListAccountsUseCase,
  ListCostCentersUseCase,
  UpdateAccountUseCase,
  UpdateCostCenterUseCase,
} from '../../application/use-cases/account-use-cases.js';
import type {
  ClosePeriodUseCase,
  CreateFiscalYearUseCase,
  ListFiscalYearsUseCase,
  ReopenPeriodUseCase,
} from '../../application/use-cases/period-use-cases.js';
import type {
  CreateJournalEntryUseCase,
  DeleteJournalEntryUseCase,
  GetJournalEntryUseCase,
  ListJournalEntriesUseCase,
  PostJournalEntryUseCase,
  ReverseJournalEntryUseCase,
  UpdateJournalEntryUseCase,
} from '../../application/use-cases/journal-use-cases.js';
import type { BalanceSheetUseCase, IncomeStatementUseCase, LedgerUseCase, TrialBalanceUseCase } from '../../application/use-cases/report-use-cases.js';
import type { AutomaticPostingUseCase, DiscardPendingPostingUseCase, ListPendingPostingsUseCase } from '../../application/use-cases/automatic-posting.js';
import type { GetPostingSettingsUseCase, UpdatePostingSettingsUseCase } from '../../application/use-cases/posting-settings-use-cases.js';
import type { CollectionRole } from '../../domain/posting.js';
import { type ContextVariables, requireOrganization, requirePermission, requireUser } from './middlewares.js';
import {
  createAccountSchema,
  createCostCenterSchema,
  createEntrySchema,
  createFiscalYearSchema,
  discardPendingSchema,
  intParam,
  retryPendingSchema,
  reverseEntrySchema,
  setupSchema,
  updateAccountSchema,
  updateCostCenterSchema,
  updatePostingSettingsSchema,
  updateEntrySchema,
  validateJson,
} from './validators.js';
import {
  toAccountJSON,
  toCostCenterJSON,
  toEntryJSON,
  toFiscalYearJSON,
  toFiscalYearViewJSON,
  toPendingJSON,
  toPeriodJSON,
  toSettingsJSON,
} from './serializers.js';

type Vars = { Variables: ContextVariables };
type Ctx = Context<Vars>;

export interface AppDependencies {
  useCases: {
    getSettings: GetSettingsUseCase;
    setup: SetupAccountingUseCase;
    listAccounts: ListAccountsUseCase;
    getAccount: GetAccountUseCase;
    createAccount: CreateAccountUseCase;
    updateAccount: UpdateAccountUseCase;
    listCostCenters: ListCostCentersUseCase;
    createCostCenter: CreateCostCenterUseCase;
    updateCostCenter: UpdateCostCenterUseCase;
    listFiscalYears: ListFiscalYearsUseCase;
    createFiscalYear: CreateFiscalYearUseCase;
    closePeriod: ClosePeriodUseCase;
    reopenPeriod: ReopenPeriodUseCase;
    listEntries: ListJournalEntriesUseCase;
    getEntry: GetJournalEntryUseCase;
    createEntry: CreateJournalEntryUseCase;
    updateEntry: UpdateJournalEntryUseCase;
    deleteEntry: DeleteJournalEntryUseCase;
    postEntry: PostJournalEntryUseCase;
    reverseEntry: ReverseJournalEntryUseCase;
    trialBalance: TrialBalanceUseCase;
    ledger: LedgerUseCase;
    balanceSheet: BalanceSheetUseCase;
    incomeStatement: IncomeStatementUseCase;
    postingSettings: GetPostingSettingsUseCase;
    updatePostingSettings: UpdatePostingSettingsUseCase;
    listPending: ListPendingPostingsUseCase;
    retryPending: AutomaticPostingUseCase;
    discardPending: DiscardPendingPostingUseCase;
  };
  corsOrigin: string;
}

export function healthRoutes(): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ status: 'ok' }));
  return r;
}

function requiredDate(c: Ctx, name: string): string {
  const value = c.req.query(name) ?? '';
  if (!isLocalDate(value)) throw new ValidationError([{ field: name, message: `Indica ${name} con el formato YYYY-MM-DD.` }]);
  return value;
}

/**
 * El gateway reenvía `ANY /accounting/*` SIN quitar el prefijo, así que las rutas se sirven con `/accounting` delante. El health no
 * lleva prefijo. Los permisos son finos a propósito (quien escribe un asiento no tiene por qué poder contabilizarlo ni cerrar el
 * periodo): separación de funciones.
 */
export function accountingRoutes(deps: AppDependencies): Hono<Vars> {
  const r = new Hono<Vars>();
  const { useCases: uc } = deps;
  const org = requireOrganization();

  // ── Configuración inicial ─────────────────────────────────────────────────
  r.get('/accounting/settings', org, requirePermission('account:read'), async (c: Ctx) => {
    const settings = await uc.getSettings.execute(c.get('organizationId'));
    return c.json({ configured: settings !== null, settings: settings ? toSettingsJSON(settings) : null }, 200);
  });
  r.post('/accounting/setup', org, requireUser(), requirePermission('account:manage'), validateJson(setupSchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { chartTemplate: ChartTemplateCode; fiscalYear?: number; baseCurrency?: string; fiscalYearStartMonth?: number };
    const result = await uc.setup.execute({ ...body, organizationId: c.get('organizationId'), userId: c.get('userId') });
    return c.json({ settings: toSettingsJSON(result.settings), accountCount: result.accountCount, fiscalYear: toFiscalYearJSON(result.fiscalYear) }, 201);
  });

  // ── Plan de cuentas ───────────────────────────────────────────────────────
  r.get('/accounting/accounts', org, requirePermission('account:read'), async (c: Ctx) => {
    const status = c.req.query('status') as EntityStatus | undefined;
    const accounts = await uc.listAccounts.execute(c.get('organizationId'), { status, type: c.req.query('type') || undefined });
    return c.json(accounts.map(toAccountJSON), 200);
  });
  r.post('/accounting/accounts', org, requirePermission('account:manage'), validateJson(createAccountSchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { code: string; name: string; type?: AccountType; parentId?: string | null; isPostable?: boolean; systemRole?: SystemRole | null };
    const account = await uc.createAccount.execute({ ...body, organizationId: c.get('organizationId') });
    return c.json(toAccountJSON(account), 201);
  });
  r.get('/accounting/accounts/:id', org, requirePermission('account:read'), async (c: Ctx) => {
    return c.json(toAccountJSON(await uc.getAccount.execute(c.get('organizationId'), c.req.param('id') ?? '')), 200);
  });
  r.patch('/accounting/accounts/:id', org, requirePermission('account:manage'), validateJson(updateAccountSchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { name?: string; status?: EntityStatus; systemRole?: SystemRole | null };
    const account = await uc.updateAccount.execute({ ...body, organizationId: c.get('organizationId'), accountId: c.req.param('id') ?? '' });
    return c.json(toAccountJSON(account), 200);
  });

  // ── Centros de costo ──────────────────────────────────────────────────────
  r.get('/accounting/cost-centers', org, requirePermission('account:read'), async (c: Ctx) => {
    const status = c.req.query('status') as EntityStatus | undefined;
    return c.json((await uc.listCostCenters.execute(c.get('organizationId'), status)).map(toCostCenterJSON), 200);
  });
  r.post('/accounting/cost-centers', org, requirePermission('account:manage'), validateJson(createCostCenterSchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { code: string; name: string };
    return c.json(toCostCenterJSON(await uc.createCostCenter.execute({ ...body, organizationId: c.get('organizationId') })), 201);
  });
  r.patch('/accounting/cost-centers/:id', org, requirePermission('account:manage'), validateJson(updateCostCenterSchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { name?: string; status?: EntityStatus };
    return c.json(toCostCenterJSON(await uc.updateCostCenter.execute({ ...body, organizationId: c.get('organizationId'), id: c.req.param('id') ?? '' })), 200);
  });

  // ── Ejercicios y periodos ─────────────────────────────────────────────────
  r.get('/accounting/fiscal-years', org, requirePermission('account:read'), async (c: Ctx) => {
    return c.json((await uc.listFiscalYears.execute(c.get('organizationId'))).map(toFiscalYearViewJSON), 200);
  });
  r.post('/accounting/fiscal-years', org, requirePermission('period:manage'), validateJson(createFiscalYearSchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { year: number };
    return c.json(toFiscalYearViewJSON(await uc.createFiscalYear.execute({ organizationId: c.get('organizationId'), year: body.year })), 201);
  });
  r.post('/accounting/periods/:id/close', org, requireUser(), requirePermission('period:manage'), async (c: Ctx) => {
    const period = await uc.closePeriod.execute({ organizationId: c.get('organizationId'), periodId: c.req.param('id') ?? '', userId: c.get('userId') });
    return c.json(toPeriodJSON(period), 200);
  });
  r.post('/accounting/periods/:id/reopen', org, requirePermission('period:manage'), async (c: Ctx) => {
    const period = await uc.reopenPeriod.execute({ organizationId: c.get('organizationId'), periodId: c.req.param('id') ?? '' });
    return c.json(toPeriodJSON(period), 200);
  });

  // ── Asientos ──────────────────────────────────────────────────────────────
  r.get('/accounting/journal-entries', org, requirePermission('journal:read'), async (c: Ctx) => {
    const q = (k: string) => c.req.query(k) || undefined;
    const from = q('from');
    const to = q('to');
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value && !isLocalDate(value)) throw new ValidationError([{ field: name, message: 'La fecha debe tener el formato YYYY-MM-DD.' }]);
    }
    const status = q('status');
    if (status && status !== 'draft' && status !== 'posted') throw new ValidationError([{ field: 'status', message: 'Debe ser draft o posted.' }]);
    const page = intParam(c.req.query('page'), 1, 1, 100_000);
    const pageSize = intParam(c.req.query('pageSize'), 25, 1, 100);
    const { items, total } = await uc.listEntries.execute(c.get('organizationId'), {
      status: status as 'draft' | 'posted' | undefined,
      kind: q('kind'),
      from,
      to,
      sourceType: q('sourceType'),
      accountId: q('accountId'),
      search: q('q'),
      page,
      pageSize,
    });
    return c.json({ items: items.map((e) => toEntryJSON(e, false)), total, page, pageSize }, 200);
  });
  r.post('/accounting/journal-entries', org, requireUser(), requirePermission('journal:create'), validateJson(createEntrySchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { entryDate: string; description: string; reference?: string | null; lines: JournalLineInput[]; post: boolean };
    // Contabilizar al crear exige además el permiso de contabilizar: crear un borrador y publicarlo son funciones distintas.
    if (body.post && !(c.get('permissions') ?? []).includes('journal:post')) {
      return c.json({ code: 'FORBIDDEN', message: 'Permiso insuficiente para contabilizar.' }, 403);
    }
    const entry = await uc.createEntry.execute({ ...body, organizationId: c.get('organizationId'), userId: c.get('userId') });
    return c.json(toEntryJSON(entry), 201);
  });
  r.get('/accounting/journal-entries/:id', org, requirePermission('journal:read'), async (c: Ctx) => {
    return c.json(toEntryJSON(await uc.getEntry.execute(c.get('organizationId'), c.req.param('id') ?? '')), 200);
  });
  r.put('/accounting/journal-entries/:id', org, requirePermission('journal:create'), validateJson(updateEntrySchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { entryDate: string; description: string; reference?: string | null; lines: JournalLineInput[] };
    const entry = await uc.updateEntry.execute({ ...body, organizationId: c.get('organizationId'), entryId: c.req.param('id') ?? '' });
    return c.json(toEntryJSON(entry), 200);
  });
  r.delete('/accounting/journal-entries/:id', org, requirePermission('journal:create'), async (c: Ctx) => {
    await uc.deleteEntry.execute({ organizationId: c.get('organizationId'), entryId: c.req.param('id') ?? '' });
    return c.body(null, 204);
  });
  r.post('/accounting/journal-entries/:id/post', org, requireUser(), requirePermission('journal:post'), async (c: Ctx) => {
    const entry = await uc.postEntry.execute({ organizationId: c.get('organizationId'), entryId: c.req.param('id') ?? '', userId: c.get('userId') });
    return c.json(toEntryJSON(entry), 200);
  });
  r.post('/accounting/journal-entries/:id/reverse', org, requireUser(), requirePermission('journal:reverse'), validateJson(reverseEntrySchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { reason: string; entryDate?: string };
    const { original, reversal } = await uc.reverseEntry.execute({
      organizationId: c.get('organizationId'),
      entryId: c.req.param('id') ?? '',
      userId: c.get('userId'),
      reason: body.reason,
      entryDate: body.entryDate,
    });
    return c.json({ original: toEntryJSON(original), reversal: toEntryJSON(reversal) }, 201);
  });

  // ── Contabilización automática ────────────────────────────────────────────
  r.get('/accounting/posting-settings', org, requirePermission('account:read'), async (c: Ctx) => {
    const view = await uc.postingSettings.execute(c.get('organizationId'));
    return c.json({ settings: toSettingsJSON(view.settings), pendingCount: view.pendingCount, defaultPaymentMethodRoles: view.defaultPaymentMethodRoles }, 200);
  });
  r.put('/accounting/posting-settings', org, requirePermission('account:manage'), validateJson(updatePostingSettingsSchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { autoPosting?: boolean; autoPostingFrom?: string | null; timezone?: string; paymentMethodRoles?: Record<string, CollectionRole> | null };
    const settings = await uc.updatePostingSettings.execute({ ...body, organizationId: c.get('organizationId') });
    return c.json(toSettingsJSON(settings), 200);
  });
  r.get('/accounting/pending-postings', org, requirePermission('journal:read'), async (c: Ctx) => {
    const status = c.req.query('status');
    if (status && !['pending', 'posted', 'discarded'].includes(status)) throw new ValidationError([{ field: 'status', message: 'Debe ser pending, posted o discarded.' }]);
    const page = intParam(c.req.query('page'), 1, 1, 100_000);
    const pageSize = intParam(c.req.query('pageSize'), 25, 1, 100);
    const { items, total } = await uc.listPending.execute(c.get('organizationId'), { status: status as 'pending' | 'posted' | 'discarded' | undefined, page, pageSize });
    return c.json({ items: items.map(toPendingJSON), total, page, pageSize }, 200);
  });
  // Reintentar contabiliza asientos: pide `journal:post`, igual que contabilizar a mano.
  r.post('/accounting/pending-postings/retry', org, requirePermission('journal:post'), validateJson(retryPendingSchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { ids?: string[] };
    return c.json(await uc.retryPending.retry(c.get('organizationId'), body.ids), 200);
  });
  r.post('/accounting/pending-postings/:id/discard', org, requirePermission('journal:post'), validateJson(discardPendingSchema), async (c: Ctx) => {
    const body = c.req.valid('json' as never) as { reason: string };
    const row = await uc.discardPending.execute({ organizationId: c.get('organizationId'), id: c.req.param('id') ?? '', reason: body.reason });
    return c.json(toPendingJSON(row), 200);
  });

  // ── Informes ──────────────────────────────────────────────────────────────
  r.get('/accounting/reports/trial-balance', org, requirePermission('ledger:read'), async (c: Ctx) => {
    const maxLevel = c.req.query('maxLevel');
    const report = await uc.trialBalance.execute({
      organizationId: c.get('organizationId'),
      from: requiredDate(c, 'from'),
      to: requiredDate(c, 'to'),
      costCenterId: c.req.query('costCenterId') || undefined,
      includeZero: c.req.query('includeZero') === 'true',
      maxLevel: maxLevel ? intParam(maxLevel, 10, 1, 10) : undefined,
    });
    return c.json(report, 200);
  });
  r.get('/accounting/reports/balance-sheet', org, requirePermission('ledger:read'), async (c: Ctx) => {
    const maxLevel = c.req.query('maxLevel');
    const compareAsOf = c.req.query('compareAsOf') || undefined;
    const report = await uc.balanceSheet.execute({
      organizationId: c.get('organizationId'),
      asOf: requiredDate(c, 'asOf'),
      compareAsOf,
      costCenterId: c.req.query('costCenterId') || undefined,
      includeZero: c.req.query('includeZero') === 'true',
      maxLevel: maxLevel ? intParam(maxLevel, 10, 1, 10) : undefined,
    });
    return c.json(report, 200);
  });
  r.get('/accounting/reports/income-statement', org, requirePermission('ledger:read'), async (c: Ctx) => {
    const maxLevel = c.req.query('maxLevel');
    const report = await uc.incomeStatement.execute({
      organizationId: c.get('organizationId'),
      from: requiredDate(c, 'from'),
      to: requiredDate(c, 'to'),
      compareFrom: c.req.query('compareFrom') || undefined,
      compareTo: c.req.query('compareTo') || undefined,
      costCenterId: c.req.query('costCenterId') || undefined,
      includeZero: c.req.query('includeZero') === 'true',
      maxLevel: maxLevel ? intParam(maxLevel, 10, 1, 10) : undefined,
    });
    return c.json(report, 200);
  });
  r.get('/accounting/reports/ledger', org, requirePermission('ledger:read'), async (c: Ctx) => {
    const accountId = c.req.query('accountId') ?? '';
    if (!accountId) throw new ValidationError([{ field: 'accountId', message: 'Indica la cuenta.' }]);
    const report = await uc.ledger.execute({
      organizationId: c.get('organizationId'),
      accountId,
      from: requiredDate(c, 'from'),
      to: requiredDate(c, 'to'),
      page: intParam(c.req.query('page'), 1, 1, 100_000),
      pageSize: intParam(c.req.query('pageSize'), 50, 1, 200),
    });
    return c.json(report, 200);
  });

  return r;
}
