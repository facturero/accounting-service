import { type Account, type AccountType, isResultType } from './account.js';
import { compareCodes, type AccountSums } from './reports.js';

/**
 * Estados financieros: balance general y estado de resultados. Funciones PURAS sobre las sumas por cuenta que entrega la base.
 *
 * Convención de signos: cada importe sale en el sentido NATURAL de su cuenta (activos, costos y gastos aumentan por el debe;
 * pasivos, patrimonio e ingresos por el haber), de modo que una cifra positiva es «normal» y una negativa es excepcional (una
 * depreciación acumulada resta de los activos; una devolución resta de los ingresos). Así el balance se lee sin invertir signos.
 */

export interface StatementRow {
  accountId: string | null;
  code: string;
  name: string;
  level: number;
  isPostable: boolean;
  /** Fila calculada que no es una cuenta del plan (resultado del ejercicio, resultados anteriores sin cerrar). */
  synthetic: boolean;
  amountCents: number;
  /** Importe del periodo de comparación; `null` si no se pidió comparar. */
  compareAmountCents: number | null;
}

export type SectionKey = 'assets' | 'liabilities' | 'equity' | 'income' | 'costs' | 'expenses';

export interface StatementSection {
  key: SectionKey;
  rows: StatementRow[];
  totalCents: number;
  compareTotalCents: number | null;
}

export interface BalanceSheet {
  asOf: string;
  compareAsOf: string | null;
  sections: StatementSection[];
  /** Activo, pasivo + patrimonio (con los resultados) y su diferencia: debe ser 0 si los libros cuadran. */
  totals: {
    assetsCents: number;
    liabilitiesAndEquityCents: number;
    differenceCents: number;
    compareAssetsCents: number | null;
    compareLiabilitiesAndEquityCents: number | null;
    compareDifferenceCents: number | null;
  };
}

export interface IncomeStatement {
  from: string;
  to: string;
  compareFrom: string | null;
  compareTo: string | null;
  sections: StatementSection[];
  grossProfitCents: number;
  netResultCents: number;
  compareGrossProfitCents: number | null;
  compareNetResultCents: number | null;
}

/** Suma de cada cuenta de DETALLE en el sentido natural de su tipo; `amountOf` decide qué importe de las sumas se usa. */
type Leaf = Map<string, number>;

function leafAmounts(accounts: Account[], sums: AccountSums[], amountOf: (a: Account, s: AccountSums) => number): Leaf {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out: Leaf = new Map();
  for (const s of sums) {
    const account = byId.get(s.accountId);
    if (!account) continue;
    out.set(account.id, (out.get(account.id) ?? 0) + amountOf(account, s));
  }
  return out;
}

/** Cada cuenta de agrupación suma las de detalle que cuelgan de ella y son del MISMO tipo (la raíz `5` mezcla costos y gastos). */
function rollup(accounts: Account[], leaves: Leaf): Map<string, number> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map<string, number>();
  for (const [id, amount] of leaves) {
    let cursor: Account | undefined = byId.get(id);
    const type = cursor?.type;
    const seen = new Set<string>();
    while (cursor && cursor.type === type && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      out.set(cursor.id, (out.get(cursor.id) ?? 0) + amount);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }
  return out;
}

function totalOf(accounts: Account[], leaves: Leaf, type: AccountType): number {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  let sum = 0;
  for (const [id, amount] of leaves) if (byId.get(id)?.type === type) sum += amount;
  return sum;
}

function sectionRows(params: {
  accounts: Account[];
  type: AccountType;
  main: Map<string, number>;
  compare: Map<string, number> | null;
  includeZero: boolean;
  maxLevel?: number;
}): StatementRow[] {
  const rows: StatementRow[] = [];
  const ordered = params.accounts.filter((a) => a.type === params.type).sort((a, b) => compareCodes(a.code, b.code));
  for (const a of ordered) {
    if (params.maxLevel && a.level > params.maxLevel) continue;
    const amount = params.main.get(a.id) ?? 0;
    const compare = params.compare ? (params.compare.get(a.id) ?? 0) : null;
    if (!params.includeZero && amount === 0 && (compare ?? 0) === 0) continue;
    rows.push({ accountId: a.id, code: a.code, name: a.name, level: a.level, isPostable: a.isPostable, synthetic: false, amountCents: amount, compareAmountCents: compare });
  }
  return rows;
}

// ── Balance general ─────────────────────────────────────────────────────────

interface BalanceFigures {
  /** Neto acumulado (debe - haber) hasta la fecha, por cuenta de balance, y los resultados partidos en anteriores/del ejercicio. */
  leaves: Leaf;
  priorResults: number;
  currentResult: number;
}

/**
 * Cifras del balance a una fecha. `sums` viene de pedir `from = to = asOf`: `netBeforeFrom + debit - credit` es el acumulado de
 * todos los asientos hasta esa fecha; `netBeforeYearStart` es lo anterior al ejercicio, para separar el resultado del ejercicio de
 * los de ejercicios anteriores que todavía no se cerraron contra el patrimonio.
 */
function balanceFigures(accounts: Account[], sums: AccountSums[]): BalanceFigures {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const leaves: Leaf = new Map();
  let prior = 0;
  let current = 0;
  for (const s of sums) {
    const account = byId.get(s.accountId);
    if (!account) continue;
    const cumulative = s.netBeforeFrom + s.debit - s.credit;
    if (isResultType(account.type)) {
      // Un resultado en el haber (utilidad) es un neto negativo: se pasa a positivo = utilidad.
      prior += -s.netBeforeYearStart;
      current += -(cumulative - s.netBeforeYearStart);
    } else {
      // Activo: neto tal cual; pasivo y patrimonio: se invierte para que lo normal sea positivo.
      leaves.set(account.id, (leaves.get(account.id) ?? 0) + (account.type === 'asset' ? cumulative : -cumulative));
    }
  }
  return { leaves, priorResults: prior, currentResult: current };
}

export function buildBalanceSheet(params: {
  accounts: Account[];
  sums: AccountSums[];
  compareSums: AccountSums[] | null;
  asOf: string;
  compareAsOf: string | null;
  includeZero: boolean;
  maxLevel?: number;
}): BalanceSheet {
  const main = balanceFigures(params.accounts, params.sums);
  const cmp = params.compareSums ? balanceFigures(params.accounts, params.compareSums) : null;
  const mainRoll = rollup(params.accounts, main.leaves);
  const cmpRoll = cmp ? rollup(params.accounts, cmp.leaves) : null;

  const section = (key: SectionKey, type: AccountType): StatementSection => ({
    key,
    rows: sectionRows({ accounts: params.accounts, type, main: mainRoll, compare: cmpRoll, includeZero: params.includeZero, maxLevel: params.maxLevel }),
    totalCents: totalOf(params.accounts, main.leaves, type),
    compareTotalCents: cmp ? totalOf(params.accounts, cmp.leaves, type) : null,
  });

  const assets = section('assets', 'asset');
  const liabilities = section('liabilities', 'liability');
  const equity = section('equity', 'equity');

  // Los resultados todavía no cerrados forman parte del patrimonio: sin ellos, el activo no igualaría a pasivo + patrimonio.
  const synthetic = (name: string, code: string, amount: number, compare: number | null): StatementRow => ({
    accountId: null, code, name, level: 1, isPostable: false, synthetic: true, amountCents: amount, compareAmountCents: compare,
  });
  const extras: StatementRow[] = [
    synthetic('Resultados de ejercicios anteriores (sin cerrar)', '', main.priorResults, cmp ? cmp.priorResults : null),
    synthetic('Resultado del ejercicio', '', main.currentResult, cmp ? cmp.currentResult : null),
  ].filter((r) => params.includeZero || r.amountCents !== 0 || (r.compareAmountCents ?? 0) !== 0);
  equity.rows.push(...extras);
  equity.totalCents += main.priorResults + main.currentResult;
  if (cmp && equity.compareTotalCents !== null) equity.compareTotalCents += cmp.priorResults + cmp.currentResult;

  const le = liabilities.totalCents + equity.totalCents;
  const cle = cmp && liabilities.compareTotalCents !== null && equity.compareTotalCents !== null ? liabilities.compareTotalCents + equity.compareTotalCents : null;
  return {
    asOf: params.asOf,
    compareAsOf: params.compareAsOf,
    sections: [assets, liabilities, equity],
    totals: {
      assetsCents: assets.totalCents,
      liabilitiesAndEquityCents: le,
      differenceCents: assets.totalCents - le,
      compareAssetsCents: assets.compareTotalCents,
      compareLiabilitiesAndEquityCents: cle,
      compareDifferenceCents: cle !== null && assets.compareTotalCents !== null ? assets.compareTotalCents - cle : null,
    },
  };
}

// ── Estado de resultados ────────────────────────────────────────────────────

/** Movimiento del rango en el sentido natural: ingresos por el haber; costos y gastos por el debe. */
function resultLeaves(accounts: Account[], sums: AccountSums[]): Leaf {
  return leafAmounts(accounts, sums, (a, s) => {
    if (!isResultType(a.type)) return 0;
    return a.type === 'income' ? s.credit - s.debit : s.debit - s.credit;
  });
}

export function buildIncomeStatement(params: {
  accounts: Account[];
  sums: AccountSums[];
  compareSums: AccountSums[] | null;
  from: string;
  to: string;
  compareFrom: string | null;
  compareTo: string | null;
  includeZero: boolean;
  maxLevel?: number;
}): IncomeStatement {
  const main = resultLeaves(params.accounts, params.sums);
  const cmp = params.compareSums ? resultLeaves(params.accounts, params.compareSums) : null;
  const mainRoll = rollup(params.accounts, main);
  const cmpRoll = cmp ? rollup(params.accounts, cmp) : null;

  const section = (key: SectionKey, type: AccountType): StatementSection => ({
    key,
    rows: sectionRows({ accounts: params.accounts, type, main: mainRoll, compare: cmpRoll, includeZero: params.includeZero, maxLevel: params.maxLevel }),
    totalCents: totalOf(params.accounts, main, type),
    compareTotalCents: cmp ? totalOf(params.accounts, cmp, type) : null,
  });

  const income = section('income', 'income');
  const costs = section('costs', 'cost');
  const expenses = section('expenses', 'expense');

  const gross = income.totalCents - costs.totalCents;
  const net = gross - expenses.totalCents;
  const cGross = income.compareTotalCents !== null && costs.compareTotalCents !== null ? income.compareTotalCents - costs.compareTotalCents : null;
  const cNet = cGross !== null && expenses.compareTotalCents !== null ? cGross - expenses.compareTotalCents : null;
  return {
    from: params.from,
    to: params.to,
    compareFrom: params.compareFrom,
    compareTo: params.compareTo,
    sections: [income, costs, expenses],
    grossProfitCents: gross,
    netResultCents: net,
    compareGrossProfitCents: cGross,
    compareNetResultCents: cNet,
  };
}
