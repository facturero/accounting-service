#!/usr/bin/env node
/**
 * Verificación de los estados financieros contra un accounting-service REAL con MySQL real:
 *   - un escenario con cifras conocidas (dos ejercicios) da exactamente el balance y el estado de resultados esperados;
 *   - propiedad: tras 300 asientos aleatorios en tres ejercicios, en CADA fecha de corte activo = pasivo + patrimonio
 *     (con el resultado dentro), el resultado de los tres años suma el resultado acumulado, y comparar no cambia las cifras.
 *
 * Uso:  BASE=http://localhost:3016 node scripts/verify-statements.mjs
 */
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:3016';
const ORG = randomUUID();
const USER = randomUUID();
const PERMS = 'account:read,account:manage,journal:read,journal:create,journal:post,journal:reverse,period:manage,ledger:read';

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ORG, 'X-User-Id': USER, 'X-Permissions': PERMS },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

console.log(`Organización de prueba: ${ORG}`);
await call('POST', '/accounting/setup', { chartTemplate: 'ec-supercias', fiscalYear: 2025 });
await call('POST', '/accounting/fiscal-years', { year: 2026 });
await call('POST', '/accounting/fiscal-years', { year: 2027 });
const accounts = (await call('GET', '/accounting/accounts')).json;
const id = (code) => accounts.find((a) => a.code === code).id;
const post = async (date, debit, credit, cents) => {
  const r = await call('POST', '/accounting/journal-entries', {
    entryDate: date, description: `${debit}/${credit}`, post: true,
    lines: [{ accountId: id(debit), debitCents: cents }, { accountId: id(credit), creditCents: cents }],
  });
  if (r.status !== 201) throw new Error(`no se pudo contabilizar: ${JSON.stringify(r.json)}`);
};

console.log('\n1. Escenario con cifras conocidas');
await post('2026-01-05', '1.1.01.02', '3.1.01', 100_000);
await post('2026-02-01', '1.1.03.01', '1.1.01.02', 20_000);
await call('POST', '/accounting/journal-entries', {
  entryDate: '2026-03-10', description: 'Venta con IVA', post: true,
  lines: [{ accountId: id('1.1.01.01'), debitCents: 11_500 }, { accountId: id('4.1.01'), creditCents: 10_000 }, { accountId: id('2.1.03.01'), creditCents: 1_500 }],
});
await post('2026-03-10', '5.1.01', '1.1.03.01', 6_000);
await post('2026-04-01', '5.2.02', '1.1.01.01', 2_000);
await post('2027-02-15', '1.1.01.01', '4.1.01', 5_000);

const bs26 = (await call('GET', '/accounting/reports/balance-sheet?asOf=2026-12-31')).json;
check('balance 2026: activo 103.500 = pasivo + patrimonio', bs26.totals.assetsCents === 103_500 && bs26.totals.liabilitiesAndEquityCents === 103_500 && bs26.totals.differenceCents === 0, JSON.stringify(bs26.totals));
const bs27 = (await call('GET', '/accounting/reports/balance-sheet?asOf=2027-12-31&compareAsOf=2026-12-31')).json;
const eq27 = bs27.sections.find((s) => s.key === 'equity').rows;
check('balance 2027 separa resultados anteriores (2.000) del ejercicio (5.000)', eq27.find((r) => r.name.startsWith('Resultados de ejercicios anteriores'))?.amountCents === 2_000 && eq27.find((r) => r.name === 'Resultado del ejercicio')?.amountCents === 5_000);
check('balance 2027 cuadra y su comparación (2026) también', bs27.totals.differenceCents === 0 && bs27.totals.compareDifferenceCents === 0 && bs27.totals.compareAssetsCents === 103_500);
const is26 = (await call('GET', '/accounting/reports/income-statement?from=2026-01-01&to=2026-12-31&compareFrom=2025-01-01&compareTo=2025-12-31')).json;
check('estado de resultados 2026: bruta 4.000, neto 2.000, comparativo 2025 en cero', is26.grossProfitCents === 4_000 && is26.netResultCents === 2_000 && is26.compareNetResultCents === 0);
check('costos y gastos no se mezclan', is26.sections.find((s) => s.key === 'costs').totalCents === 6_000 && is26.sections.find((s) => s.key === 'expenses').totalCents === 2_000);

console.log('\n2. Propiedad: 300 asientos aleatorios en tres ejercicios');
const detail = accounts.filter((a) => a.isPostable && a.status === 'active');
const pick = () => detail[Math.floor(Math.random() * detail.length)];
const rnd = (n) => Math.floor(Math.random() * n);
const batch = [];
for (let i = 0; i < 300; i += 1) {
  const year = 2025 + rnd(3);
  const date = `${year}-${String(1 + rnd(12)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')}`;
  let a = pick();
  let b = pick();
  while (b.id === a.id) b = pick();
  const cents = 100 + rnd(500_000);
  batch.push(call('POST', '/accounting/journal-entries', {
    entryDate: date, description: `aleatorio ${i}`, post: true,
    lines: [{ accountId: a.id, debitCents: cents }, { accountId: b.id, creditCents: cents }],
  }));
}
const results = await Promise.all(batch);
check('los 300 asientos se contabilizan', results.every((r) => r.status === 201), `fallaron=${results.filter((r) => r.status !== 201).length}`);

const cuts = ['2025-03-31', '2025-12-31', '2026-06-30', '2026-12-31', '2027-02-14', '2027-12-31'];
let allBalanced = true;
const resultsByYear = {};
for (const d of cuts) {
  const bs = (await call('GET', `/accounting/reports/balance-sheet?asOf=${d}&includeZero=true`)).json;
  if (bs.totals.differenceCents !== 0) {
    allBalanced = false;
    console.log(`     descuadre al ${d}: ${bs.totals.differenceCents}`);
  }
}
check('en las 6 fechas de corte, activo = pasivo + patrimonio', allBalanced);

for (const y of [2025, 2026, 2027]) {
  resultsByYear[y] = (await call('GET', `/accounting/reports/income-statement?from=${y}-01-01&to=${y}-12-31`)).json.netResultCents;
}
const bsEnd = (await call('GET', '/accounting/reports/balance-sheet?asOf=2027-12-31')).json;
const eq = bsEnd.sections.find((s) => s.key === 'equity').rows;
const prior = eq.find((r) => r.name.startsWith('Resultados de ejercicios anteriores'))?.amountCents ?? 0;
const current = eq.find((r) => r.name === 'Resultado del ejercicio')?.amountCents ?? 0;
check('resultados anteriores = suma de 2025 y 2026; del ejercicio = 2027', prior === resultsByYear[2025] + resultsByYear[2026] && current === resultsByYear[2027], `${prior} vs ${resultsByYear[2025] + resultsByYear[2026]}; ${current} vs ${resultsByYear[2027]}`);

const tb = (await call('GET', '/accounting/reports/trial-balance?from=2025-01-01&to=2027-12-31')).json;
const sumNet = (key) => bsEnd.sections.find((s) => s.key === key).totalCents;
check('el balance general coincide con el de comprobación (activo)', sumNet('assets') === tb.rows.find((r) => r.code === '1').closingCents);
check('comparar no cambia las cifras del periodo principal', (await call('GET', '/accounting/reports/income-statement?from=2027-01-01&to=2027-12-31&compareFrom=2026-01-01&compareTo=2026-12-31')).json.netResultCents === resultsByYear[2027]);

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} comprobación(es) fallaron`);
process.exit(failures === 0 ? 0 : 1);
