#!/usr/bin/env node
/**
 * Publica eventos de ejemplo (como los de billing e inventory) para una organización, para ver la contabilización automática en el
 * CRM de desarrollo.   ORG=<uuid> AMQP=amqp://localhost:5672 node scripts/publish-sample-events.mjs
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const amqp = createRequire(new URL('../node_modules/@facturero/outbox-relay/package.json', import.meta.url))('amqplib');
const ORG = process.env.ORG;
if (!ORG) throw new Error('Falta ORG');
const conn = await amqp.connect(process.env.AMQP ?? 'amqp://localhost:5672');
const ch = await conn.createChannel();
await ch.assertExchange('crm.events', 'topic', { durable: true });
const publish = (type, payload) => ch.publish('crm.events', type, Buffer.from(JSON.stringify(payload)), { persistent: true, headers: { eventId: randomUUID() } });

const now = new Date().toISOString();
const invoice = (n, over = {}) => ({
  organizationId: ORG,
  invoiceId: randomUUID(),
  number: `001-001-${String(n).padStart(9, '0')}`,
  issueDate: now,
  documentTypeCode: '01',
  establishmentId: randomUUID(),
  customerSnapshot: { id: randomUUID(), businessName: ['Ana Pérez', 'Comercial Andina', 'María Torres', 'Pedro Salazar'][n % 4] },
  totalCents: 11500,
  currencyCode: 'USD',
  lines: [{ subtotalCents: 10000, taxes: [{ kind: 'vat', amountCents: 1500 }] }],
  ...over,
});

const a = invoice(101);
const b = invoice(102, { paymentMethodCode: '01', totalCents: 23000, lines: [{ subtotalCents: 20000, taxes: [{ kind: 'vat', amountCents: 3000 }] }] });
const c = invoice(103, { paymentMethodCode: '19' });
const credit = invoice(104, { documentTypeCode: '04', totalCents: 5750, lines: [{ subtotalCents: 5000, taxes: [{ kind: 'vat', amountCents: 750 }] }] });
const ice = invoice(105, { lines: [{ subtotalCents: 10000, taxes: [{ kind: 'special', amountCents: 1500 }] }] });
for (const inv of [a, b, c, credit, ice]) publish('billing.invoice.issued', inv);
for (const [i, cost] of [[0, 6000], [1, 12000], [2, 6000]]) {
  publish('inventory.stock.consumed', { organizationId: ORG, movementId: randomUUID(), type: 'sale_out', accountingNature: 'cogs', totalCostCents: cost, currencyCode: 'USD', referenceType: 'invoice', referenceId: [a, b, c][i].invoiceId, occurredAt: now });
}
publish('inventory.stock.adjusted', { organizationId: ORG, movementId: randomUUID(), type: 'adjustment_out', accountingNature: 'shrinkage', reasonCode: 'damage', totalCostCents: 1800, currencyCode: 'USD', occurredAt: now });
publish('billing.invoice.voided', { organizationId: ORG, invoiceId: c.invoiceId, number: c.number, voidedAt: now, reason: 'Error de digitación' });

await new Promise((r) => setTimeout(r, 500));
await ch.close();
await conn.close();
console.log('eventos publicados');
