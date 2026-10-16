#!/usr/bin/env node
/**
 * Verificación contra un accounting-service REAL con MySQL real (lo que las pruebas en memoria no pueden probar):
 *   - numeración sin huecos ni repetidos cuando muchos asientos se contabilizan a la vez;
 *   - cerrar un periodo mientras se contabiliza en él (ningún asiento entra después del cierre);
 *   - 10 reversas simultáneas del mismo asiento: solo una gana;
 *   - balance y mayor (función de ventana) cuadran con lo contabilizado;
 *   - el CHECK de importes y los UNIQUE de la base.
 *
 * Uso:  BASE=http://localhost:3016 node scripts/verify-accounting.mjs
 * Necesita el servicio levantado contra una base vacía (no borra nada: usa una organización nueva).
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

console.log('\n1. Alta');
const setup = await call('POST', '/accounting/setup', { chartTemplate: 'ec-supercias', fiscalYear: 2026 });
check('alta 201', setup.status === 201, `cuentas=${setup.json?.accountCount}`);
check('segunda alta 409', (await call('POST', '/accounting/setup', {})).status === 409);
const accounts = (await call('GET', '/accounting/accounts')).json;
const id = (code) => accounts.find((a) => a.code === code).id;
const cash = id('1.1.01.01');
const sales = id('4.1.01');
const rent = id('5.2.02');
const entry = (date, cents, description = 'Venta', post = true) => ({
  entryDate: date, description, post,
  lines: [{ accountId: cash, debitCents: cents }, { accountId: sales, creditCents: cents }],
});

console.log('\n2. Numeración con 30 asientos contabilizados a la vez');
const results = await Promise.all(Array.from({ length: 30 }, (_, i) => call('POST', '/accounting/journal-entries', entry(`2026-03-${String((i % 28) + 1).padStart(2, '0')}`, 100 + i))));
const okCount = results.filter((r) => r.status === 201).length;
const numbers = results.filter((r) => r.status === 201).map((r) => Number(r.json.number.split('-')[2])).sort((a, b) => a - b);
check('los 30 se contabilizan', okCount === 30, `ok=${okCount} estados=${[...new Set(results.map((r) => r.status))]}`);
check('numeración 1..30 sin huecos ni repetidos', numbers.length === 30 && numbers.every((n, i) => n === i + 1), numbers.join(',').slice(0, 80));

console.log('\n3. Balance y mayor');
const tb = (await call('GET', '/accounting/reports/trial-balance?from=2026-03-01&to=2026-03-31')).json;
const expected = Array.from({ length: 30 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0);
check('debe = haber = suma de los asientos', tb.totals.debitCents === expected && tb.totals.creditCents === expected, `${tb.totals.debitCents}/${tb.totals.creditCents} esperado ${expected}`);
check('saldo final del balance es 0', tb.totals.closingCents === 0);
const ledger = (await call('GET', `/accounting/reports/ledger?accountId=${cash}&from=2026-03-01&to=2026-03-31&pageSize=10&page=2`)).json;
check('mayor: página 2 con saldo acumulado continuo', ledger.lines.length === 10 && ledger.total === 30, `total=${ledger.total}`);
const all = (await call('GET', `/accounting/reports/ledger?accountId=${cash}&from=2026-03-01&to=2026-03-31&pageSize=200`)).json;
check('mayor: el último saldo acumulado = total', all.lines.at(-1).runningCents === expected, `${all.lines.at(-1).runningCents}`);
check('mayor: la página 2 empieza donde terminó la 1', ledger.lines[0].runningCents === all.lines[10].runningCents);

console.log('\n4. Reversas simultáneas');
const target = (await call('POST', '/accounting/journal-entries', entry('2026-04-10', 5000, 'Para reversar'))).json;
const rev = await Promise.all(Array.from({ length: 10 }, () => call('POST', `/accounting/journal-entries/${target.id}/reverse`, { reason: 'prueba de concurrencia' })));
const won = rev.filter((r) => r.status === 201).length;
const lost = rev.filter((r) => r.status === 409).length;
check('exactamente una reversa gana', won === 1 && lost === 9, `ganan=${won} 409=${lost} otros=${rev.filter((r) => ![201, 409].includes(r.status)).map((r) => r.status)}`);
const afterRev = (await call('GET', `/accounting/journal-entries/${target.id}`)).json;
check('el original queda marcado y contabilizado', afterRev.status === 'posted' && !!afterRev.reversedByEntryId);

console.log('\n5. Cerrar un periodo mientras se contabiliza en él');
const years = (await call('GET', '/accounting/fiscal-years')).json;
const periods = years[0].periods;
// Se cierran enero–mayo en orden; en mayo corre la carrera.
for (const p of periods.slice(0, 4)) {
  const r = await call('POST', `/accounting/periods/${p.id}/close`);
  check(`cerrar periodo ${p.number}`, r.status === 200, `status=${r.status} ${r.json?.code ?? ''}`);
}
const may = periods[4];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Las peticiones salen escalonadas y el cierre llega a mitad del flujo: así hay asientos que entran antes y otros que chocan con él.
const race = await Promise.all([
  ...Array.from({ length: 20 }, async (_, i) => {
    await wait(i * 15);
    return call('POST', '/accounting/journal-entries', entry(`2026-05-${String(i + 1).padStart(2, '0')}`, 700 + i, 'Carrera con el cierre'));
  }),
  wait(150).then(() => call('POST', `/accounting/periods/${may.id}/close`)),
]);
const closeRes = race[race.length - 1];
const posted = race.slice(0, 20).filter((r) => r.status === 201).length;
const rejected = race.slice(0, 20).filter((r) => r.status === 409 && r.json?.code === 'PERIOD_CLOSED').length;
console.log(`     cierre=${closeRes.status}${closeRes.json?.code ? ' ' + closeRes.json.code : ''} contabilizados=${posted} rechazados por cierre=${rejected}`);
check('todo asiento fue contabilizado o rechazado por el cierre', posted + rejected === 20);
if (closeRes.status === 200) {
  // El cierre ganó: ningún asiento de mayo puede haber entrado DESPUÉS. Se comprueba contando el balance de mayo contra lo contabilizado.
  const may2 = (await call('GET', '/accounting/reports/trial-balance?from=2026-05-01&to=2026-05-31')).json;
  const postedSum = race.slice(0, 20).filter((r) => r.status === 201).reduce((a, r) => a + r.json.totalDebitCents, 0);
  check('el balance de mayo = lo contabilizado antes del cierre', may2.totals.debitCents === postedSum, `${may2.totals.debitCents} vs ${postedSum}`);
  const late = await call('POST', '/accounting/journal-entries', entry('2026-05-25', 1));
  check('después del cierre, mayo rechaza asientos', late.status === 409 && late.json.code === 'PERIOD_CLOSED');
} else {
  check('si el cierre no ganó fue por borradores/orden, no por un error', [409].includes(closeRes.status), JSON.stringify(closeRes.json));
}

console.log('\n6. Reglas de la base');
const bad = await call('POST', '/accounting/journal-entries', { entryDate: '2026-08-01', description: 'x', lines: [{ accountId: cash, debitCents: 1 }, { accountId: sales, creditCents: 2 }] });
check('asiento descuadrado 422', bad.status === 422);
const grp = await call('POST', '/accounting/journal-entries', { entryDate: '2026-08-01', description: 'x', lines: [{ accountId: id('1.1'), debitCents: 1 }, { accountId: sales, creditCents: 1 }] });
check('cuenta de agrupación 422', grp.status === 422 && grp.json.code === 'ACCOUNT_NOT_POSTABLE');
const dup = await call('POST', '/accounting/accounts', { code: '1.1.01.01', name: 'Repetida', parentId: id('1.1.01') });
check('código repetido 409', dup.status === 409);
const cc = await call('POST', '/accounting/cost-centers', { code: 'norte', name: 'Norte' });
check('centro de costo', cc.status === 201 && cc.json.code === 'NORTE');
const withCc = await call('POST', '/accounting/journal-entries', { entryDate: '2026-08-02', description: 'con centro', post: true, lines: [{ accountId: rent, debitCents: 900, costCenterId: cc.json.id }, { accountId: cash, creditCents: 900, costCenterId: cc.json.id }] });
check('asiento con centro de costo', withCc.status === 201);
const tbCc = (await call('GET', `/accounting/reports/trial-balance?from=2026-08-01&to=2026-08-31&costCenterId=${cc.json.id}`)).json;
check('balance por centro de costo', tbCc.totals.debitCents === 900);

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} comprobación(es) fallaron`);
process.exit(failures === 0 ? 0 : 1);
