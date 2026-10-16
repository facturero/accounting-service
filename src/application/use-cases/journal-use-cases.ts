import {
  AccountNotFoundError,
  AccountNotPostableError,
  CostCenterNotFoundError,
  JournalEntryNotFoundError,
  NotSetUpError,
  PeriodClosedError,
  PeriodNotFoundError,
  ValidationError,
} from '../../domain/errors.js';
import { JournalEntry, type JournalLineInput } from '../../domain/journal.js';
import { isLocalDate, type LocalDate } from '../../domain/period.js';
import type { JournalListFilters, JournalRepository, UnitOfWork } from '../../domain/repositories.js';
import {
  journalEntryDeletedEvent,
  journalEntryPostedEvent,
  journalEntryReversedEvent,
  journalEntrySavedEvent,
} from '../events.js';
import type { Clock, UnitOfWorkGateway } from '../ports.js';

/** Las cuentas y centros de costo de las líneas existen, son de la organización y aceptan movimientos. */
async function assertLinesUsable(uow: UnitOfWork, organizationId: string, lines: readonly JournalLineInput[]): Promise<void> {
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const accounts = await uow.accounts.findByIds(organizationId, accountIds);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const id of accountIds) {
    const account = byId.get(id);
    if (!account) throw new AccountNotFoundError(`La cuenta ${id} no existe.`);
    if (!account.canReceiveMovements()) {
      throw new AccountNotPostableError(`La cuenta ${account.code} ${account.name} no admite movimientos (es de agrupación o está inactiva).`);
    }
  }
  const costCenterIds = [...new Set(lines.map((l) => l.costCenterId).filter((x): x is string => !!x))];
  if (costCenterIds.length > 0) {
    const found = await uow.costCenters.findByIds(organizationId, costCenterIds);
    const foundById = new Map(found.map((c) => [c.id, c]));
    for (const id of costCenterIds) {
      const cc = foundById.get(id);
      if (!cc) throw new CostCenterNotFoundError();
      if (cc.status !== 'active') throw new ValidationError([{ field: 'costCenterId', message: `El centro de costo ${cc.code} está inactivo.` }]);
    }
  }
}

/**
 * Contabiliza un borrador dentro de la transacción de quien llama. Orden de bloqueos (siempre el mismo, para no provocar
 * interbloqueos): periodo (compartido) → contador del ejercicio (exclusivo). El periodo se lee con bloqueo porque bajo REPEATABLE
 * READ una lectura normal vería el estado anterior a un cierre que otra petición acaba de confirmar.
 */
export async function postEntryInTransaction(uow: UnitOfWork, entry: JournalEntry, userId: string, now: Date): Promise<void> {
  const period = await uow.periods.lockPeriodForDate(entry.organizationId, entry.entryDate);
  if (!period) throw new PeriodNotFoundError();
  if (!period.isOpen()) throw new PeriodClosedError(`El periodo ${period.startDate} – ${period.endDate} está cerrado.`);
  const year = await uow.periods.findYearById(entry.organizationId, period.fiscalYearId);
  if (!year) throw new PeriodNotFoundError();

  await assertLinesUsable(uow, entry.organizationId, entry.lines);

  const number = await uow.journal.nextNumber(entry.organizationId, year.year);
  entry.post({ number, fiscalYear: year.year, periodId: period.id, userId, now });
  await uow.journal.save(entry);
  await uow.outbox.add(journalEntryPostedEvent(entry));
}

export interface EntryInput {
  entryDate: LocalDate;
  description: string;
  reference?: string | null;
  lines: JournalLineInput[];
}

export class CreateJournalEntryUseCase {
  constructor(private readonly uow: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(input: EntryInput & { organizationId: string; userId: string; post: boolean }): Promise<JournalEntry> {
    const uow = await this.uow.begin();
    try {
      const settings = await uow.settings.find(input.organizationId);
      if (!settings) throw new NotSetUpError();
      const entry = JournalEntry.create({
        organizationId: input.organizationId,
        entryDate: input.entryDate,
        description: input.description,
        reference: input.reference,
        currencyCode: settings.baseCurrency,
        lines: input.lines,
        createdBy: input.userId,
      });
      await assertLinesUsable(uow, input.organizationId, entry.lines);
      await uow.journal.save(entry);
      if (input.post) {
        await postEntryInTransaction(uow, entry, input.userId, this.clock());
      } else {
        await uow.outbox.add(journalEntrySavedEvent(entry));
      }
      await uow.commit();
      return entry;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

export class UpdateJournalEntryUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: EntryInput & { organizationId: string; entryId: string }): Promise<JournalEntry> {
    const uow = await this.uow.begin();
    try {
      const entry = await uow.journal.lockById(input.organizationId, input.entryId);
      if (!entry) throw new JournalEntryNotFoundError();
      entry.replaceDraft(input);
      await assertLinesUsable(uow, input.organizationId, entry.lines);
      await uow.journal.save(entry);
      await uow.outbox.add(journalEntrySavedEvent(entry));
      await uow.commit();
      return entry;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

export class DeleteJournalEntryUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: { organizationId: string; entryId: string }): Promise<void> {
    const uow = await this.uow.begin();
    try {
      const entry = await uow.journal.lockById(input.organizationId, input.entryId);
      if (!entry) throw new JournalEntryNotFoundError();
      entry.assertDraft();
      await uow.journal.delete(input.organizationId, input.entryId);
      await uow.outbox.add(journalEntryDeletedEvent(entry));
      await uow.commit();
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

export class PostJournalEntryUseCase {
  constructor(private readonly uow: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(input: { organizationId: string; entryId: string; userId: string }): Promise<JournalEntry> {
    const uow = await this.uow.begin();
    try {
      const entry = await uow.journal.lockById(input.organizationId, input.entryId);
      if (!entry) throw new JournalEntryNotFoundError();
      entry.assertDraft();
      await postEntryInTransaction(uow, entry, input.userId, this.clock());
      await uow.commit();
      return entry;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

/**
 * Anula un asiento contabilizado con otro de signo contrario. El original queda como estaba (con la marca de «reversado»); la
 * contabilidad nunca se edita ni se borra. La fecha de la reversa es la del original salvo que se indique otra (necesario si el
 * periodo del original ya está cerrado).
 */
export class ReverseJournalEntryUseCase {
  constructor(private readonly uow: UnitOfWorkGateway, private readonly clock: Clock) {}

  async execute(input: { organizationId: string; entryId: string; userId: string; reason: string; entryDate?: LocalDate }): Promise<{ original: JournalEntry; reversal: JournalEntry }> {
    const uow = await this.uow.begin();
    try {
      const original = await uow.journal.lockById(input.organizationId, input.entryId);
      if (!original) throw new JournalEntryNotFoundError();
      if (input.entryDate !== undefined && !isLocalDate(input.entryDate)) {
        throw new ValidationError([{ field: 'entryDate', message: 'La fecha debe tener el formato YYYY-MM-DD.' }]);
      }
      const reversal = JournalEntry.reversalOf(original, {
        entryDate: input.entryDate ?? original.entryDate,
        reason: input.reason,
        createdBy: input.userId,
      });
      await uow.journal.save(reversal);
      await postEntryInTransaction(uow, reversal, input.userId, this.clock());
      original.markReversed(reversal.id);
      await uow.journal.save(original);
      await uow.outbox.add(journalEntryReversedEvent(original, reversal));
      await uow.commit();
      return { original, reversal };
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

export class GetJournalEntryUseCase {
  constructor(private readonly repos: { journal: Pick<JournalRepository, 'findById'> }) {}

  async execute(organizationId: string, entryId: string): Promise<JournalEntry> {
    const entry = await this.repos.journal.findById(organizationId, entryId);
    if (!entry) throw new JournalEntryNotFoundError();
    return entry;
  }
}

export class ListJournalEntriesUseCase {
  constructor(private readonly repos: { journal: Pick<JournalRepository, 'list'> }) {}

  async execute(organizationId: string, filters: JournalListFilters): Promise<{ items: JournalEntry[]; total: number }> {
    return this.repos.journal.list(organizationId, filters);
  }
}
