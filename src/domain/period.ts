import { randomUUID } from 'node:crypto';
import { ValidationError } from './errors.js';

/** Fechas contables sin hora: `YYYY-MM-DD`. Comparar como texto es comparar fechas. */
export type LocalDate = string;

export const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function pad(n: number, size = 2): string {
  return String(n).padStart(size, '0');
}

export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface PeriodRange {
  number: number;
  startDate: LocalDate;
  endDate: LocalDate;
}

/**
 * Doce periodos mensuales consecutivos a partir de `startMonth` del año `year`. El ejercicio se nombra por el año en que empieza
 * (uno de julio a junio que empieza en 2026 es el ejercicio 2026). Los cierres especiales de fin de año se harán con el cierre
 * de ejercicio (Fase 7), no con un periodo 13.
 */
export function generatePeriods(year: number, startMonth = 1): PeriodRange[] {
  const out: PeriodRange[] = [];
  for (let i = 0; i < 12; i += 1) {
    const monthIndex = startMonth - 1 + i;
    const y = year + Math.floor(monthIndex / 12);
    const m = (monthIndex % 12) + 1;
    out.push({
      number: i + 1,
      startDate: `${y}-${pad(m)}-01`,
      endDate: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`,
    });
  }
  return out;
}

export type PeriodStatus = 'open' | 'closed';

export interface FiscalYearProps {
  id: string;
  organizationId: string;
  year: number;
  startDate: LocalDate;
  endDate: LocalDate;
  createdAt: Date;
}

export class FiscalYear {
  private constructor(private props: FiscalYearProps) {}

  static create(params: { id?: string; organizationId: string; year: number; startMonth?: number }): FiscalYear {
    if (!Number.isInteger(params.year) || params.year < 1990 || params.year > 2200) {
      throw new ValidationError([{ field: 'year', message: 'El año del ejercicio no es válido.' }]);
    }
    const ranges = generatePeriods(params.year, params.startMonth ?? 1);
    return new FiscalYear({
      id: params.id ?? randomUUID(),
      organizationId: params.organizationId,
      year: params.year,
      startDate: ranges[0]!.startDate,
      endDate: ranges[11]!.endDate,
      createdAt: new Date(),
    });
  }

  static fromPersistence(props: FiscalYearProps): FiscalYear {
    return new FiscalYear({ ...props });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get year(): number { return this.props.year; }
  get startDate(): LocalDate { return this.props.startDate; }
  get endDate(): LocalDate { return this.props.endDate; }
  get createdAt(): Date { return this.props.createdAt; }

  toPersistence(): FiscalYearProps {
    return { ...this.props };
  }
}

export interface FiscalPeriodProps {
  id: string;
  organizationId: string;
  fiscalYearId: string;
  number: number;
  startDate: LocalDate;
  endDate: LocalDate;
  status: PeriodStatus;
  closedAt: Date | null;
  closedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class FiscalPeriod {
  private constructor(private props: FiscalPeriodProps) {}

  static create(params: { organizationId: string; fiscalYearId: string; range: PeriodRange }): FiscalPeriod {
    const now = new Date();
    return new FiscalPeriod({
      id: randomUUID(),
      organizationId: params.organizationId,
      fiscalYearId: params.fiscalYearId,
      number: params.range.number,
      startDate: params.range.startDate,
      endDate: params.range.endDate,
      status: 'open',
      closedAt: null,
      closedBy: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static fromPersistence(props: FiscalPeriodProps): FiscalPeriod {
    return new FiscalPeriod({ ...props });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get fiscalYearId(): string { return this.props.fiscalYearId; }
  get number(): number { return this.props.number; }
  get startDate(): LocalDate { return this.props.startDate; }
  get endDate(): LocalDate { return this.props.endDate; }
  get status(): PeriodStatus { return this.props.status; }
  get closedAt(): Date | null { return this.props.closedAt; }
  get closedBy(): string | null { return this.props.closedBy; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  isOpen(): boolean {
    return this.props.status === 'open';
  }

  contains(date: LocalDate): boolean {
    return date >= this.props.startDate && date <= this.props.endDate;
  }

  close(userId: string, now: Date): void {
    this.props.status = 'closed';
    this.props.closedAt = now;
    this.props.closedBy = userId;
    this.props.updatedAt = now;
  }

  reopen(now: Date): void {
    this.props.status = 'open';
    this.props.closedAt = null;
    this.props.closedBy = null;
    this.props.updatedAt = now;
  }

  toPersistence(): FiscalPeriodProps {
    return { ...this.props };
  }
}
