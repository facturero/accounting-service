import { isResultType } from '../../domain/account.js';
import { AccountNotFoundError, ValidationError } from '../../domain/errors.js';
import { isLocalDate } from '../../domain/period.js';
import type { UnitOfWork } from '../../domain/repositories.js';
import { buildTrialBalance, type Ledger, type TrialBalance } from '../../domain/reports.js';
import { buildBalanceSheet, buildIncomeStatement, type BalanceSheet, type IncomeStatement } from '../../domain/statements.js';

type Repos = Pick<UnitOfWork, 'accounts' | 'periods' | 'reports'>;

function assertRange(from: string, to: string): void {
  const details = [];
  if (!isLocalDate(from)) details.push({ field: 'from', message: 'La fecha inicial debe tener el formato YYYY-MM-DD.' });
  if (!isLocalDate(to)) details.push({ field: 'to', message: 'La fecha final debe tener el formato YYYY-MM-DD.' });
  if (details.length > 0) throw new ValidationError(details);
  if (from > to) throw new ValidationError([{ field: 'to', message: 'La fecha final no puede ser anterior a la inicial.' }]);
}

/** Inicio del ejercicio que contiene la fecha; si no hay ejercicio creado, el 1 de enero de ese año. */
async function yearStartFor(repos: Repos, organizationId: string, date: string): Promise<string> {
  const year = await repos.periods.findYearForDate(organizationId, date);
  return year?.startDate ?? `${date.slice(0, 4)}-01-01`;
}

export class TrialBalanceUseCase {
  constructor(private readonly repos: Repos) {}

  async execute(input: {
    organizationId: string;
    from: string;
    to: string;
    costCenterId?: string;
    includeZero?: boolean;
    maxLevel?: number;
  }): Promise<TrialBalance> {
    assertRange(input.from, input.to);
    const yearStart = await yearStartFor(this.repos, input.organizationId, input.from);
    const [accounts, sums] = await Promise.all([
      this.repos.accounts.list(input.organizationId),
      this.repos.reports.sumByAccount(input.organizationId, { from: input.from, to: input.to, yearStart, costCenterId: input.costCenterId }),
    ]);
    return buildTrialBalance({ accounts, sums, from: input.from, to: input.to, includeZero: input.includeZero ?? false, maxLevel: input.maxLevel });
  }
}

export class LedgerUseCase {
  constructor(private readonly repos: Repos) {}

  async execute(input: { organizationId: string; accountId: string; from: string; to: string; page: number; pageSize: number }): Promise<Ledger> {
    assertRange(input.from, input.to);
    const account = await this.repos.accounts.findById(input.organizationId, input.accountId);
    if (!account) throw new AccountNotFoundError();

    let opening = await this.repos.reports.netBefore(input.organizationId, account.id, input.from);
    if (isResultType(account.type)) {
      const yearStart = await yearStartFor(this.repos, input.organizationId, input.from);
      opening -= await this.repos.reports.netBefore(input.organizationId, account.id, yearStart);
    }
    const { lines, total } = await this.repos.reports.ledgerLines(
      input.organizationId,
      { accountId: account.id, from: input.from, to: input.to, page: input.page, pageSize: input.pageSize },
      opening,
    );
    return { accountId: account.id, from: input.from, to: input.to, openingCents: opening, lines, total, page: input.page, pageSize: input.pageSize };
  }
}

function assertDate(name: string, value: string): void {
  if (!isLocalDate(value)) throw new ValidationError([{ field: name, message: 'La fecha debe tener el formato YYYY-MM-DD.' }]);
}

/**
 * Balance general a una fecha, con la comparación opcional contra otra fecha (p. ej. el cierre del año pasado). El resultado del
 * ejercicio y el de ejercicios anteriores sin cerrar se muestran dentro del patrimonio: así activo = pasivo + patrimonio.
 */
export class BalanceSheetUseCase {
  constructor(private readonly repos: Repos) {}

  async execute(input: { organizationId: string; asOf: string; compareAsOf?: string; costCenterId?: string; includeZero?: boolean; maxLevel?: number }): Promise<BalanceSheet> {
    assertDate('asOf', input.asOf);
    if (input.compareAsOf !== undefined) assertDate('compareAsOf', input.compareAsOf);
    const accounts = await this.repos.accounts.list(input.organizationId);
    const sumsAt = async (date: string) =>
      this.repos.reports.sumByAccount(input.organizationId, {
        // from = to = la fecha: `netBeforeFrom + debit - credit` es el acumulado hasta ella.
        from: date,
        to: date,
        yearStart: await yearStartFor(this.repos, input.organizationId, date),
        costCenterId: input.costCenterId,
      });
    return buildBalanceSheet({
      accounts,
      sums: await sumsAt(input.asOf),
      compareSums: input.compareAsOf ? await sumsAt(input.compareAsOf) : null,
      asOf: input.asOf,
      compareAsOf: input.compareAsOf ?? null,
      includeZero: input.includeZero ?? false,
      maxLevel: input.maxLevel,
    });
  }
}

/** Estado de resultados de un rango, con la comparación opcional contra otro rango (periodo anterior, mismo periodo del año pasado). */
export class IncomeStatementUseCase {
  constructor(private readonly repos: Repos) {}

  async execute(input: {
    organizationId: string;
    from: string;
    to: string;
    compareFrom?: string;
    compareTo?: string;
    costCenterId?: string;
    includeZero?: boolean;
    maxLevel?: number;
  }): Promise<IncomeStatement> {
    assertRange(input.from, input.to);
    if ((input.compareFrom === undefined) !== (input.compareTo === undefined)) {
      throw new ValidationError([{ field: 'compareTo', message: 'Para comparar indica compareFrom y compareTo.' }]);
    }
    if (input.compareFrom !== undefined && input.compareTo !== undefined) assertRange(input.compareFrom, input.compareTo);
    const accounts = await this.repos.accounts.list(input.organizationId);
    const sumsFor = async (from: string, to: string) =>
      this.repos.reports.sumByAccount(input.organizationId, { from, to, yearStart: await yearStartFor(this.repos, input.organizationId, from), costCenterId: input.costCenterId });
    return buildIncomeStatement({
      accounts,
      sums: await sumsFor(input.from, input.to),
      compareSums: input.compareFrom && input.compareTo ? await sumsFor(input.compareFrom, input.compareTo) : null,
      from: input.from,
      to: input.to,
      compareFrom: input.compareFrom ?? null,
      compareTo: input.compareTo ?? null,
      includeZero: input.includeZero ?? false,
      maxLevel: input.maxLevel,
    });
  }
}
