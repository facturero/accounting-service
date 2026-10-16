#!/usr/bin/env node
/**
 * Verificación de la contabilización automática contra un accounting-service REAL: MySQL real y RabbitMQ real. Publica los eventos
 * como lo hace el outbox-relay (exchange `crm.events`, routing key = tipo, cabecera `eventId`) y mira el resultado por la API.
 *
 *   - una factura genera su asiento; el mismo evento dos veces, o el mismo documento con otro eventId, no duplica;
 *   - 40 facturas + 40 costos de venta simultáneos: 80 asientos, numeración sin huecos, el balance cuadra;
 *   - 10 entregas simultáneas del MISMO documento: un solo asiento;
 *   - sin la cuenta de un rol: queda pendiente; al asignarlo y reintentar, se contabiliza;
 *   - anulación de factura: reversa; un mensaje basura no tumba al consumidor.
 *
 * Uso:  BASE=http://localhost:3016 AMQP=amqp://localhost:5672 node scripts/verify-automatic-posting.mjs
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// amqplib llega anidado dentro de @facturero/outbox-relay: se resuelve desde ahí.
const amqp = createRequire(new URL('../node_modules/@facturero/outbox-relay/package.json', import.meta.url))('amqplib');

const BASE = process.env.BASE ?? 'http://localhost:3016';
const AMQP = process.env.AMQP ?? 'amqp://localhost:5672';
const ORG = randomUUID();
const USER = randomUUID();
const PERMS = 'account:read,account:manage,journal:read,journal:create,journal:post,journal:reverse,period:manage,ledger:read';
const YEAR = new Date().getUTCFullYear();

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Organization-Id': ORG, 'X-User-Id': USER, 'X-Permissions': PERMS },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const conn = await amqp.connect(AMQP);
const ch = await conn.createChannel();
await ch.assertExchange('crm.events', 'topic', { durable: true });
function publish(type, payload, eventId = randomUUID()) {
  ch.publish('crm.events', type, Buffer.from(JSON.stringify(payload)), { persistent: true, headers: { eventId } });
}

async function entries(params = '') {
  const r = await call('GET', `/accounting/journal-entries?pageSize=100&${params}`);
  return r.json;
}
async function waitFor(fn, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  return null;
}

const invoice = (over = {}) => ({
  organizationId: ORG,
  invoiceId: randomUUID(),
  number: '001-001-000000001',
  issueDate: new Date().toISOString(),
  documentTypeCode: '01',
  establishmentId: randomUUID(),
  customerSnapshot: { id: randomUUID(), businessName: 'Cliente de prueba' },
  totalCents: 11500,
  currencyCode: 'USD',
  lines: [{ subtotalCents: 10000, taxes: [{ kind: 'vat', amountCents: 1500 }] }],
  ...over,
});
const movement = (over = {}) => ({
  organizationId: ORG,
  movementId: randomUUID(),
  type: 'sale_out',
  accountingNature: 'cogs',
  totalCostCents: 6000,
  currencyCode: 'USD',
  occurredAt: new Date().toISOString(),
  ...over,
});

console.log(`Organización de prueba: ${ORG}`);

console.log('\n1. Alta y primera factura');
check('alta 201', (await call('POST', '/accounting/setup', { chartTemplate: 'ec-supercias', fiscalYear: YEAR })).status === 201);
const accounts = (await call('GET', '/accounting/accounts')).json;
const acc = (code) => accounts.find((a) => a.code === code);
const first = invoice();
publish('billing.invoice.issued', first);
const got = await waitFor(async () => {
  const r = await entries('kind=automatic');
  return r.total >= 1 ? r : null;
});
check('la factura generó un asiento automático', !!got, `total=${got?.total}`);
if (got) {
  const detail = (await call('GET', `/accounting/journal-entries/${got.items[0].id}`)).json;
  check('contabilizado, de origen factura, cuadrado', detail.status === 'posted' && detail.sourceType === 'invoice' && detail.sourceId === first.invoiceId && detail.totalDebitCents === 11500);
  check('Clientes al debe, ventas e IVA al haber', detail.lines[0].accountId === acc('1.1.02.01').id && detail.lines[0].debitCents === 11500
    && detail.lines[1].accountId === acc('4.1.01').id && detail.lines[1].creditCents === 10000
    && detail.lines[2].accountId === acc('2.1.03.01').id && detail.lines[2].creditCents === 1500);
}

console.log('\n2. Idempotencia');
const eid = randomUUID();
const dup = invoice();
publish('billing.invoice.issued', dup, eid);
publish('billing.invoice.issued', dup, eid); // mismo mensaje (reentrega)
publish('billing.invoice.issued', dup, randomUUID()); // mismo documento, otro mensaje
await waitFor(async () => (await entries('kind=automatic')).total >= 2);
await sleep(1500);
const afterDup = await entries('kind=automatic');
check('el mismo documento (3 mensajes) genera UN asiento', afterDup.total === 2, `total=${afterDup.total}`);

console.log('\n3. Diez entregas simultáneas del mismo documento');
const same = invoice();
for (let i = 0; i < 10; i += 1) publish('billing.invoice.issued', same, randomUUID());
await sleep(3000);
const afterSame = await entries('kind=automatic');
check('un solo asiento', afterSame.total === 3, `total=${afterSame.total}`);

console.log('\n4. 40 facturas + 40 costos de venta a la vez');
const invs = Array.from({ length: 40 }, () => invoice());
const movs = Array.from({ length: 40 }, () => movement());
for (let i = 0; i < 40; i += 1) {
  publish('billing.invoice.issued', invs[i]);
  publish('inventory.stock.consumed', movs[i]);
}
const all = await waitFor(async () => {
  const r = await entries('kind=automatic');
  return r.total >= 83 ? r : null;
}, 60000);
const total = (await entries('kind=automatic')).total;
check('83 asientos automáticos (3 + 80)', total === 83, `total=${total}`);
const posted = [];
for (let page = 1; page <= 2; page += 1) {
  const r = await call('GET', `/accounting/journal-entries?kind=automatic&status=posted&pageSize=100&page=${page}`);
  posted.push(...r.json.items);
}
const numbers = posted.map((e) => Number(e.number.split('-')[2])).sort((a, b) => a - b);
check('numeración 1..83 sin huecos ni repetidos', numbers.length === 83 && numbers.every((n, i) => n === i + 1), `n=${numbers.length}`);
const tb = (await call('GET', `/accounting/reports/trial-balance?from=${YEAR}-01-01&to=${YEAR}-12-31`)).json;
const totalSales = 43 * 10000; // 3 + 40 facturas
const totalCogs = 40 * 6000;
check('el balance cuadra', tb.totals.debitCents === tb.totals.creditCents && tb.totals.closingCents === 0, `${tb.totals.debitCents}/${tb.totals.creditCents}`);
check('ventas y costo de ventas correctos', tb.rows.find((r) => r.code === '4.1.01')?.closingCents === -totalSales && tb.rows.find((r) => r.code === '5.1.01')?.closingCents === totalCogs);

console.log('\n5. Sin el rol de una cuenta: pendiente → asignar → reintentar');
const salesAcc = acc('4.1.01');
check('quitar el rol de ventas', (await call('PATCH', `/accounting/accounts/${salesAcc.id}`, { systemRole: null })).status === 200);
const lost = invoice();
publish('billing.invoice.issued', lost);
const pend = await waitFor(async () => {
  const r = await call('GET', '/accounting/pending-postings?status=pending');
  return r.json.total >= 1 ? r.json : null;
});
check('queda pendiente por falta de rol', !!pend && pend.items[0].reasonCode === 'MISSING_ROLE' && pend.items[0].sourceId === lost.invoiceId, pend?.items[0]?.reasonMessage);
check('no se creó ningún asiento', (await entries('kind=automatic')).total === 83);
check('reintentar sin arreglar lo deja pendiente', (await call('POST', '/accounting/pending-postings/retry', {})).json.stillPending === 1);
check('devolver el rol', (await call('PATCH', `/accounting/accounts/${salesAcc.id}`, { systemRole: 'sales_revenue' })).status === 200);
const retry = (await call('POST', '/accounting/pending-postings/retry', {})).json;
check('el reintento lo contabiliza', retry.posted === 1 && retry.stillPending === 0, JSON.stringify(retry));
check('ahora hay 84 asientos y 0 pendientes', (await entries('kind=automatic')).total === 84 && (await call('GET', '/accounting/posting-settings')).json.pendingCount === 0);

console.log('\n6. Anulación de factura');
publish('billing.invoice.voided', { organizationId: ORG, invoiceId: first.invoiceId, number: first.number, voidedAt: new Date().toISOString(), reason: 'prueba' });
const rev = await waitFor(async () => {
  const r = await entries('kind=reversal');
  return r.total >= 1 ? r : null;
});
check('se creó la reversa', !!rev);
const origin = (await call('GET', `/accounting/journal-entries?sourceType=invoice&kind=automatic&pageSize=100`)).json.items.find((e) => e.sourceId === first.invoiceId);
check('el original queda marcado como reversado', !!origin?.reversedByEntryId);

console.log('\n6b. Anulaciones que se adelantan a la emisión (RabbitMQ no garantiza el orden)');
const racers = Array.from({ length: 20 }, () => invoice());
for (const inv of racers) {
  // La anulación sale PRIMERO; a veces gana la emisión y a veces no: el resultado final debe ser el mismo.
  publish('billing.invoice.voided', { organizationId: ORG, invoiceId: inv.invoiceId, number: inv.number, issueDate: inv.issueDate, voidedAt: new Date().toISOString() });
  publish('billing.invoice.issued', inv);
}
await waitFor(async () => (await entries('kind=reversal')).total >= 21, 60000);
const revTotal = (await entries('kind=reversal')).total;
check('las 20 anulaciones terminan reversadas (1 + 20)', revTotal === 21, `reversas=${revTotal}`);
const pendNow = (await call('GET', '/accounting/pending-postings?status=pending')).json;
check('no queda ninguna anulación esperando', pendNow.total === 0, `pendientes=${pendNow.total}`);
const tb2 = (await call('GET', `/accounting/reports/trial-balance?from=${YEAR}-01-01&to=${YEAR}-12-31`)).json;
check('el balance sigue cuadrado', tb2.totals.debitCents === tb2.totals.creditCents);

console.log('\n7. Un mensaje basura no tumba al consumidor');
ch.publish('crm.events', 'billing.invoice.issued', Buffer.from('esto no es json'), { persistent: true, headers: { eventId: randomUUID() } });
publish('billing.invoice.issued', { organizationId: ORG });
const afterJunk = invoice();
publish('billing.invoice.issued', afterJunk);
const ok = await waitFor(async () => (await entries('kind=automatic')).total >= 105, 60000);
check('el consumidor sigue contabilizando después', !!ok);

await ch.close();
await conn.close();
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} comprobación(es) fallaron`);
process.exit(failures === 0 ? 0 : 1);
