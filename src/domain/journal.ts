import { randomUUID } from 'node:crypto';
import {
  type ErrorDetail,
  JournalEntryAlreadyReversedError,
  JournalEntryNotDraftError,
  JournalEntryNotPostedError,
  JournalEntryNotReversibleError,
  UnbalancedEntryError,
  ValidationError,
} from './errors.js';
import { isLocalDate, type LocalDate } from './period.js';

export type EntryStatus = 'draft' | 'posted';
/** manual: lo escribe una persona · automatic: lo genera una regla a partir de un evento · reversal: anula a otro · opening: saldos iniciales. */
export type EntryKind = 'manual' | 'automatic' | 'reversal' | 'opening';
export const ENTRY_KINDS: readonly EntryKind[] = ['manual', 'automatic', 'reversal', 'opening'];
export type PartyType = 'customer' | 'supplier' | 'employee';
export const PARTY_TYPES: readonly PartyType[] = ['customer', 'supplier', 'employee'];

export const MAX_LINES = 500;

/** Número visible del asiento: `AS-2026-000123`. Se asigna al contabilizar, nunca en el borrador, para que no queden huecos. */
export function formatEntryNumber(fiscalYear: number, number: number): string {
  return `AS-${fiscalYear}-${String(number).padStart(6, '0')}`;
}

export interface JournalLineProps {
  id: string;
  lineNo: number;
  accountId: string;
  /** Importes en la MONEDA BASE de la organización, en centavos. */
  debitCents: number;
  creditCents: number;
  description: string | null;
  costCenterId: string | null;
  projectId: string | null;
  establishmentId: string | null;
  partyType: PartyType | null;
  partyId: string | null;
  /** Solo si el movimiento se originó en otra moneda: importe original, moneda y tipo de cambio usado. */
  currencyCode: string | null;
  amountFcCents: number | null;
  exchangeRate: number | null;
}

export interface JournalLineInput {
  accountId: string;
  debitCents?: number;
  creditCents?: number;
  description?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
  establishmentId?: string | null;
  partyType?: PartyType | null;
  partyId?: string | null;
  currencyCode?: string | null;
  amountFcCents?: number | null;
  exchangeRate?: number | null;
}

function isCents(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

export function buildLines(inputs: JournalLineInput[]): JournalLineProps[] {
  const details: ErrorDetail[] = [];
  if (inputs.length < 2) {
    throw new ValidationError([{ field: 'lines', message: 'Un asiento necesita al menos dos líneas.' }]);
  }
  if (inputs.length > MAX_LINES) {
    throw new ValidationError([{ field: 'lines', message: `Un asiento admite hasta ${MAX_LINES} líneas.` }]);
  }
  const lines = inputs.map((input, i): JournalLineProps => {
    const debit = input.debitCents ?? 0;
    const credit = input.creditCents ?? 0;
    const at = `lines.${i}`;
    if (!isCents(debit) || !isCents(credit)) {
      details.push({ field: `${at}.amount`, message: 'Los importes van en centavos enteros y no pueden ser negativos.' });
    } else if ((debit > 0) === (credit > 0)) {
      details.push({ field: `${at}.amount`, message: 'Cada línea lleva un importe en el debe o en el haber, no en ambos ni en ninguno.' });
    }
    const description = input.description?.trim() || null;
    if (description && description.length > 255) {
      details.push({ field: `${at}.description`, message: 'La descripción admite hasta 255 caracteres.' });
    }
    const hasFc = input.currencyCode != null || input.amountFcCents != null || input.exchangeRate != null;
    if (hasFc) {
      if (!input.currencyCode || !/^[A-Z]{3}$/.test(input.currencyCode) || !isCents(input.amountFcCents) || !(input.amountFcCents > 0) ||
        !(typeof input.exchangeRate === 'number' && input.exchangeRate > 0)) {
        details.push({ field: `${at}.currencyCode`, message: 'Una línea en otra moneda necesita la moneda, el importe original y el tipo de cambio.' });
      } else {
        const expected = Math.round(input.amountFcCents * input.exchangeRate);
        if (Math.abs(expected - (debit || credit)) > 1) {
          details.push({ field: `${at}.exchangeRate`, message: 'El importe en moneda base no coincide con el original por el tipo de cambio.' });
        }
      }
    }
    if ((input.partyType == null) !== (input.partyId == null)) {
      details.push({ field: `${at}.partyId`, message: 'El tercero necesita su tipo y su identificador.' });
    }
    return {
      id: randomUUID(),
      lineNo: i + 1,
      accountId: input.accountId,
      debitCents: debit,
      creditCents: credit,
      description,
      costCenterId: input.costCenterId ?? null,
      projectId: input.projectId ?? null,
      establishmentId: input.establishmentId ?? null,
      partyType: input.partyType ?? null,
      partyId: input.partyId ?? null,
      currencyCode: hasFc ? (input.currencyCode ?? null) : null,
      amountFcCents: hasFc ? (input.amountFcCents ?? null) : null,
      exchangeRate: hasFc ? (input.exchangeRate ?? null) : null,
    };
  });
  if (details.length > 0) throw new ValidationError(details);
  const { debit, credit } = totals(lines);
  if (debit !== credit) throw new UnbalancedEntryError(debit, credit);
  if (debit === 0) {
    throw new ValidationError([{ field: 'lines', message: 'El asiento no puede ser de importe cero.' }]);
  }
  return lines;
}

export function totals(lines: { debitCents: number; creditCents: number }[]): { debit: number; credit: number } {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += l.debitCents;
    credit += l.creditCents;
  }
  return { debit, credit };
}

export interface JournalEntryProps {
  id: string;
  organizationId: string;
  number: number | null;
  fiscalYear: number | null;
  entryDate: LocalDate;
  periodId: string | null;
  description: string;
  reference: string | null;
  status: EntryStatus;
  kind: EntryKind;
  sourceType: string | null;
  sourceId: string | null;
  currencyCode: string;
  totalDebitCents: number;
  totalCreditCents: number;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  reversalReason: string | null;
  createdBy: string;
  postedBy: string | null;
  postedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lines: JournalLineProps[];
}

export class JournalEntry {
  private constructor(private props: JournalEntryProps) {}

  static create(params: {
    id?: string;
    organizationId: string;
    entryDate: LocalDate;
    description: string;
    reference?: string | null;
    kind?: EntryKind;
    sourceType?: string | null;
    sourceId?: string | null;
    currencyCode: string;
    lines: JournalLineInput[];
    createdBy: string;
    reversesEntryId?: string | null;
    reversalReason?: string | null;
  }): JournalEntry {
    const now = new Date();
    const entry = new JournalEntry({
      id: params.id ?? randomUUID(),
      organizationId: params.organizationId,
      number: null,
      fiscalYear: null,
      entryDate: params.entryDate,
      periodId: null,
      description: params.description.trim().replace(/\s+/g, ' '),
      reference: params.reference?.trim() || null,
      status: 'draft',
      kind: params.kind ?? 'manual',
      sourceType: params.sourceType ?? null,
      sourceId: params.sourceId ?? null,
      currencyCode: params.currencyCode,
      totalDebitCents: 0,
      totalCreditCents: 0,
      reversesEntryId: params.reversesEntryId ?? null,
      reversedByEntryId: null,
      reversalReason: params.reversalReason ?? null,
      createdBy: params.createdBy,
      postedBy: null,
      postedAt: null,
      createdAt: now,
      updatedAt: now,
      lines: [],
    });
    entry.validateHeader();
    entry.setLines(params.lines);
    return entry;
  }

  static fromPersistence(props: JournalEntryProps): JournalEntry {
    return new JournalEntry({ ...props, lines: props.lines.map((l) => ({ ...l })) });
  }

  /** Asiento que anula a `original`: mismas cuentas y dimensiones con el debe y el haber cambiados. */
  static reversalOf(
    original: JournalEntry,
    params: { entryDate: LocalDate; reason: string; createdBy: string; sourceType?: string | null; sourceId?: string | null },
  ): JournalEntry {
    if (original.status !== 'posted') throw new JournalEntryNotPostedError();
    if (original.kind === 'reversal') throw new JournalEntryNotReversibleError();
    if (original.reversedByEntryId) throw new JournalEntryAlreadyReversedError();
    return JournalEntry.create({
      organizationId: original.organizationId,
      entryDate: params.entryDate,
      description: `Reversa del asiento ${original.displayNumber()}: ${params.reason.trim()}`.slice(0, 255),
      reference: original.displayNumber(),
      kind: 'reversal',
      currencyCode: original.currencyCode,
      createdBy: params.createdBy,
      sourceType: params.sourceType ?? null,
      sourceId: params.sourceId ?? null,
      reversesEntryId: original.id,
      reversalReason: params.reason.trim(),
      lines: original.lines.map((l) => ({
        accountId: l.accountId,
        debitCents: l.creditCents,
        creditCents: l.debitCents,
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
    });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get number(): number | null { return this.props.number; }
  get fiscalYear(): number | null { return this.props.fiscalYear; }
  get entryDate(): LocalDate { return this.props.entryDate; }
  get periodId(): string | null { return this.props.periodId; }
  get description(): string { return this.props.description; }
  get reference(): string | null { return this.props.reference; }
  get status(): EntryStatus { return this.props.status; }
  get kind(): EntryKind { return this.props.kind; }
  get sourceType(): string | null { return this.props.sourceType; }
  get sourceId(): string | null { return this.props.sourceId; }
  get currencyCode(): string { return this.props.currencyCode; }
  get totalDebitCents(): number { return this.props.totalDebitCents; }
  get totalCreditCents(): number { return this.props.totalCreditCents; }
  get reversesEntryId(): string | null { return this.props.reversesEntryId; }
  get reversedByEntryId(): string | null { return this.props.reversedByEntryId; }
  get reversalReason(): string | null { return this.props.reversalReason; }
  get createdBy(): string { return this.props.createdBy; }
  get postedBy(): string | null { return this.props.postedBy; }
  get postedAt(): Date | null { return this.props.postedAt; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }
  get lines(): readonly JournalLineProps[] { return this.props.lines; }

  displayNumber(): string | null {
    return this.props.number != null && this.props.fiscalYear != null ? formatEntryNumber(this.props.fiscalYear, this.props.number) : null;
  }

  /** Cambia el contenido de un borrador. Uno contabilizado es inmutable. */
  replaceDraft(params: { entryDate: LocalDate; description: string; reference?: string | null; lines: JournalLineInput[] }): void {
    if (this.props.status !== 'draft') throw new JournalEntryNotDraftError();
    this.props.entryDate = params.entryDate;
    this.props.description = params.description.trim().replace(/\s+/g, ' ');
    this.props.reference = params.reference?.trim() || null;
    this.validateHeader();
    this.setLines(params.lines);
    this.props.updatedAt = new Date();
  }

  assertDraft(): void {
    if (this.props.status !== 'draft') throw new JournalEntryNotDraftError();
  }

  post(params: { number: number; fiscalYear: number; periodId: string; userId: string; now: Date }): void {
    this.assertDraft();
    this.props.status = 'posted';
    this.props.number = params.number;
    this.props.fiscalYear = params.fiscalYear;
    this.props.periodId = params.periodId;
    this.props.postedBy = params.userId;
    this.props.postedAt = params.now;
    this.props.updatedAt = params.now;
  }

  markReversed(byEntryId: string): void {
    if (this.props.status !== 'posted') throw new JournalEntryNotPostedError();
    if (this.props.reversedByEntryId) throw new JournalEntryAlreadyReversedError();
    this.props.reversedByEntryId = byEntryId;
    this.props.updatedAt = new Date();
  }

  toPersistence(): JournalEntryProps {
    return { ...this.props, lines: this.props.lines.map((l) => ({ ...l })) };
  }

  private setLines(inputs: JournalLineInput[]): void {
    const lines = buildLines(inputs);
    const { debit, credit } = totals(lines);
    this.props.lines = lines;
    this.props.totalDebitCents = debit;
    this.props.totalCreditCents = credit;
  }

  private validateHeader(): void {
    const details: ErrorDetail[] = [];
    if (!isLocalDate(this.props.entryDate)) {
      details.push({ field: 'entryDate', message: 'La fecha contable debe tener el formato YYYY-MM-DD.' });
    }
    if (this.props.description.length < 1 || this.props.description.length > 255) {
      details.push({ field: 'description', message: 'La descripción debe tener entre 1 y 255 caracteres.' });
    }
    if (this.props.reference && this.props.reference.length > 60) {
      details.push({ field: 'reference', message: 'La referencia admite hasta 60 caracteres.' });
    }
    if (!/^[A-Z]{3}$/.test(this.props.currencyCode)) {
      details.push({ field: 'currencyCode', message: 'La moneda debe ser un código de tres letras (USD).' });
    }
    if ((this.props.sourceType == null) !== (this.props.sourceId == null)) {
      details.push({ field: 'sourceId', message: 'El documento de origen necesita su tipo y su identificador.' });
    }
    if (details.length > 0) throw new ValidationError(details);
  }
}
