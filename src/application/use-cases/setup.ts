import { Account } from '../../domain/account.js';
import { chartTemplate, type ChartTemplateCode } from '../../domain/chart-template.js';
import { AlreadySetUpError } from '../../domain/errors.js';
import { FiscalPeriod, FiscalYear, generatePeriods } from '../../domain/period.js';
import { localDateOf } from '../../domain/posting.js';
import type { AccountingSettings } from '../../domain/repositories.js';
import { fiscalYearCreatedEvent, setupCompletedEvent } from '../events.js';
import type { Clock, UnitOfWorkGateway } from '../ports.js';

export class GetSettingsUseCase {
  constructor(private readonly repos: { settings: { find(organizationId: string): Promise<AccountingSettings | null> } }) {}

  async execute(organizationId: string): Promise<AccountingSettings | null> {
    return this.repos.settings.find(organizationId);
  }
}

export interface SetupInput {
  organizationId: string;
  userId: string;
  chartTemplate: ChartTemplateCode;
  fiscalYear?: number;
  baseCurrency?: string;
  fiscalYearStartMonth?: number;
  timezone?: string;
  /** Desde cuándo se contabilizan solos los documentos. Por defecto, el día del alta: lo anterior se carga a mano como saldos iniciales. */
  autoPostingFrom?: string;
}

export interface SetupResult {
  settings: AccountingSettings;
  accountCount: number;
  fiscalYear: FiscalYear;
}

/**
 * Alta de la contabilidad de una organización: copia el plan de cuentas de partida, abre el primer ejercicio con sus doce periodos y
 * guarda la moneda base. Se hace UNA vez; después el plan se cambia cuenta por cuenta.
 */
export class SetupAccountingUseCase {
  constructor(private readonly uow: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(input: SetupInput): Promise<SetupResult> {
    const uow = await this.uow.begin();
    try {
      if (await uow.settings.find(input.organizationId)) throw new AlreadySetUpError();

      const now = this.clock();
      const startMonth = input.fiscalYearStartMonth ?? 1;
      const timezone = input.timezone ?? 'America/Guayaquil';
      const year = input.fiscalYear ?? now.getUTCFullYear();

      const template = chartTemplate(input.chartTemplate);
      const byCode = new Map<string, Account>();
      const accounts: Account[] = [];
      for (const t of template) {
        const parentCode = t.code.includes('.') ? t.code.slice(0, t.code.lastIndexOf('.')) : null;
        const parent = parentCode ? (byCode.get(parentCode) ?? null) : null;
        const isLeaf = !template.some((o) => o.code.startsWith(`${t.code}.`));
        const account = Account.create({
          organizationId: input.organizationId,
          code: t.code,
          name: t.name,
          type: t.type,
          parent,
          isPostable: isLeaf,
          systemRole: t.role ?? null,
        });
        byCode.set(t.code, account);
        accounts.push(account);
      }
      await uow.accounts.saveMany(accounts);

      const fiscalYear = FiscalYear.create({ organizationId: input.organizationId, year, startMonth });
      const periods = generatePeriods(year, startMonth).map((range) =>
        FiscalPeriod.create({ organizationId: input.organizationId, fiscalYearId: fiscalYear.id, range }),
      );
      await uow.periods.saveYear(fiscalYear, periods);

      const settings: AccountingSettings = {
        organizationId: input.organizationId,
        chartTemplate: input.chartTemplate,
        baseCurrency: input.baseCurrency ?? 'USD',
        fiscalYearStartMonth: startMonth,
        initializedBy: input.userId,
        initializedAt: now,
        timezone,
        autoPosting: true,
        autoPostingFrom: input.autoPostingFrom ?? localDateOf(now, timezone),
        paymentMethodRoles: null,
      };
      await uow.settings.create(settings);

      await uow.outbox.add(setupCompletedEvent({
        organizationId: input.organizationId,
        chartTemplate: settings.chartTemplate,
        baseCurrency: settings.baseCurrency,
        accountCount: accounts.length,
        fiscalYear: year,
      }));
      await uow.outbox.add(fiscalYearCreatedEvent(fiscalYear));

      await uow.commit();
      return { settings, accountCount: accounts.length, fiscalYear };
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}
