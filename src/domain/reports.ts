import { type Account, isResultType } from './account.js';

/** Sumas crudas por cuenta que entrega la base. Todo en centavos, con el debe positivo y el haber en `credit`. */
export interface AccountSums {
  accountId: string;
  /** Neto (debe - haber) de todos los asientos contabilizados ANTES de `from`. */
  netBeforeFrom: number;
  /** Neto (debe - haber) antes del inicio del ejercicio que contiene `from`. */
  netBeforeYearStart: number;
  debit: number;
  credit: number;
}

export interface TrialBalanceRow {
  accountId: string | null;
  code: string;
  name: string;
  type: string;
  level: number;
  isPostable: boolean;
  /** Fila calculada que no es una cuenta del plan (resultado de ejercicios anteriores sin cerrar). */
  synthetic: boolean;
  /** Saldos netos: positivo = deudor, negativo = acreedor. */
  openingCents: number;
  debitCents: number;
  creditCents: number;
  closingCents: number;
}

export interface TrialBalance {
  from: string;
  to: string;
  rows: TrialBalanceRow[];
  totals: { debitCents: number; creditCents: number; openingCents: number; closingCents: number };
}

/**
 * Balance de comprobación con saldo inicial, movimiento del rango y saldo final por cuenta, sumando las cuentas de detalle a sus
 * cuentas de agrupación.
 *
 * Las cuentas de resultados (ingresos, costos y gastos) empiezan en cero cada ejercicio: su saldo inicial solo cuenta lo
 * movido desde el inicio del ejercicio. Como todavía no existe el asiento de cierre que traslada ese resultado al patrimonio, lo
 * de ejercicios anteriores se muestra en una fila aparte; así el saldo inicial y el final siguen sumando cero.
 */
export function buildTrialBalance(params: {
  accounts: Account[];
  sums: AccountSums[];
  from: string;
  to: string;
  includeZero: boolean;
  maxLevel?: number;
}): TrialBalance {
  const byId = new Map(params.accounts.map((a) => [a.id, a]));
  const acc = new Map<string, { opening: number; debit: number; credit: number }>();
  const bucket = (id: string) => {
    let b = acc.get(id);
    if (!b) {
      b = { opening: 0, debit: 0, credit: 0 };
      acc.set(id, b);
    }
    return b;
  };

  let previousResults = 0;
  for (const s of params.sums) {
    const account = byId.get(s.accountId);
    if (!account) continue;
    let opening = s.netBeforeFrom;
    if (isResultType(account.type)) {
      previousResults += s.netBeforeYearStart;
      opening = s.netBeforeFrom - s.netBeforeYearStart;
    }
    // Sube por la cadena de padres: cada cuenta de agrupación acumula a sus hijas.
    let cursor: Account | undefined = account;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const b = bucket(cursor.id);
      b.opening += opening;
      b.debit += s.debit;
      b.credit += s.credit;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }

  const rows: TrialBalanceRow[] = [];
  const ordered = [...params.accounts].sort((a, b) => compareCodes(a.code, b.code));
  for (const account of ordered) {
    if (params.maxLevel && account.level > params.maxLevel) continue;
    const b = acc.get(account.id) ?? { opening: 0, debit: 0, credit: 0 };
    const closing = b.opening + b.debit - b.credit;
    if (!params.includeZero && b.opening === 0 && b.debit === 0 && b.credit === 0 && closing === 0) continue;
    rows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      level: account.level,
      isPostable: account.isPostable,
      synthetic: false,
      openingCents: b.opening,
      debitCents: b.debit,
      creditCents: b.credit,
      closingCents: closing,
    });
  }

  // Los totales se toman de las cuentas de detalle (si no, las de agrupación contarían doble).
  let debit = 0;
  let credit = 0;
  let opening = 0;
  for (const account of params.accounts) {
    if (!account.isPostable) continue;
    const b = acc.get(account.id);
    if (!b) continue;
    debit += b.debit;
    credit += b.credit;
    opening += b.opening;
  }
  if (previousResults !== 0) {
    rows.push({
      accountId: null,
      code: '',
      name: 'Resultados de ejercicios anteriores (sin cerrar)',
      type: 'equity',
      level: 1,
      isPostable: false,
      synthetic: true,
      openingCents: previousResults,
      debitCents: 0,
      creditCents: 0,
      closingCents: previousResults,
    });
    opening += previousResults;
  }
  return {
    from: params.from,
    to: params.to,
    rows,
    totals: { debitCents: debit, creditCents: credit, openingCents: opening, closingCents: opening + debit - credit },
  };
}

/** Orden natural de códigos con puntos: 1.2 antes que 1.10. */
export function compareCodes(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? -1;
    const y = pb[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

export interface LedgerLine {
  entryId: string;
  entryNumber: string | null;
  entryDate: string;
  description: string;
  lineDescription: string | null;
  reference: string | null;
  debitCents: number;
  creditCents: number;
  /** Saldo acumulado de la cuenta (debe - haber) después de esta línea, incluido el saldo inicial. */
  runningCents: number;
  costCenterId: string | null;
  sourceType: string | null;
  sourceId: string | null;
}

export interface Ledger {
  accountId: string;
  from: string;
  to: string;
  openingCents: number;
  lines: LedgerLine[];
  total: number;
  page: number;
  pageSize: number;
}
