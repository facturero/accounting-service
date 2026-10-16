import {
  FiscalYearExistsError,
  NextPeriodClosedError,
  NotSetUpError,
  PeriodAlreadyInStateError,
  PeriodHasDraftsError,
  PeriodNotFoundError,
  PreviousPeriodOpenError,
} from '../../domain/errors.js';
import { FiscalPeriod, FiscalYear, generatePeriods } from '../../domain/period.js';
import type { PeriodRepository } from '../../domain/repositories.js';
import { fiscalYearCreatedEvent, periodClosedEvent, periodReopenedEvent } from '../events.js';
import type { Clock, UnitOfWorkGateway } from '../ports.js';

export interface FiscalYearView {
  year: FiscalYear;
  periods: FiscalPeriod[];
}

export class ListFiscalYearsUseCase {
  constructor(private readonly repos: { periods: Pick<PeriodRepository, 'listYears' | 'listPeriods'> }) {}

  async execute(organizationId: string): Promise<FiscalYearView[]> {
    const years = await this.repos.periods.listYears(organizationId);
    const out: FiscalYearView[] = [];
    for (const year of years) {
      out.push({ year, periods: await this.repos.periods.listPeriods(organizationId, year.id) });
    }
    return out;
  }
}

export class CreateFiscalYearUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: { organizationId: string; year: number }): Promise<FiscalYearView> {
    const uow = await this.uow.begin();
    try {
      const settings = await uow.settings.find(input.organizationId);
      if (!settings) throw new NotSetUpError();
      if (await uow.periods.findYear(input.organizationId, input.year)) throw new FiscalYearExistsError();

      const year = FiscalYear.create({ organizationId: input.organizationId, year: input.year, startMonth: settings.fiscalYearStartMonth });
      const periods = generatePeriods(input.year, settings.fiscalYearStartMonth).map((range) =>
        FiscalPeriod.create({ organizationId: input.organizationId, fiscalYearId: year.id, range }),
      );
      await uow.periods.saveYear(year, periods);
      await uow.outbox.add(fiscalYearCreatedEvent(year));
      await uow.commit();
      return { year, periods };
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

/**
 * Cerrar un periodo impide contabilizar con fecha dentro de él. Se cierran en orden (el anterior primero) y no puede haber
 * borradores con fecha en el periodo: quedarían atrapados sin poder contabilizarse.
 */
export class ClosePeriodUseCase {
  constructor(private readonly uow: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(input: { organizationId: string; periodId: string; userId: string }): Promise<FiscalPeriod> {
    const uow = await this.uow.begin();
    try {
      // Bloqueo exclusivo: ningún asiento puede contabilizarse en este periodo mientras se decide si se cierra.
      const period = await uow.periods.lockPeriodById(input.organizationId, input.periodId);
      if (!period) throw new PeriodNotFoundError('Periodo no encontrado.');
      if (!period.isOpen()) throw new PeriodAlreadyInStateError('El periodo ya está cerrado.');
      if (await uow.periods.hasOpenPeriodBefore(input.organizationId, period.startDate)) throw new PreviousPeriodOpenError();
      if ((await uow.journal.countDraftsInRange(input.organizationId, period.startDate, period.endDate)) > 0) throw new PeriodHasDraftsError();

      period.close(input.userId, this.clock());
      await uow.periods.save(period);
      await uow.outbox.add(periodClosedEvent(period));
      await uow.commit();
      return period;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

export class ReopenPeriodUseCase {
  constructor(private readonly uow: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(input: { organizationId: string; periodId: string }): Promise<FiscalPeriod> {
    const uow = await this.uow.begin();
    try {
      const period = await uow.periods.lockPeriodById(input.organizationId, input.periodId);
      if (!period) throw new PeriodNotFoundError('Periodo no encontrado.');
      if (period.isOpen()) throw new PeriodAlreadyInStateError('El periodo ya está abierto.');
      if (await uow.periods.hasClosedPeriodAfter(input.organizationId, period.endDate)) throw new NextPeriodClosedError();

      period.reopen(this.clock());
      await uow.periods.save(period);
      await uow.outbox.add(periodReopenedEvent(period));
      await uow.commit();
      return period;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}
