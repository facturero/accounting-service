import { beforeEach, describe, expect, it } from 'vitest';
import { IncomeStatementUseCase } from '../application/use-cases/report-use-cases.js';
import { buildEventHandlers, CONSUMED_BINDINGS } from '../infrastructure/messaging/consumer.js';
import { InMemoryStore, ORG_A, ORG_B, buildPluginToggle, buildPosting, setupOrg } from './helpers.js';

// Dimensión «proyecto»: una factura creada desde un proyecto (projects-service publica `projects.invoice.linked`) se contabiliza con
// ese proyecto en todas sus líneas, y el estado de resultados se puede filtrar por proyecto.

const PROJECT = '88888888-8888-4888-8888-888888888888';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
let n = 0;
const uuid = () => `77777777-7777-4777-8777-${String((n += 1)).padStart(12, '0')}`;

const invoiceEvent = (invoiceId: string, subtotalCents: number) => ({
  organizationId: ORG_A,
  invoiceId,
  number: `001-001-${String(n).padStart(9, '0')}`,
  issueDate: '2026-10-20T15:00:00.000Z',
  documentTypeCode: '01',
  totalCents: Math.round(subtotalCents * 1.15),
  currencyCode: 'USD',
  lines: [{ subtotalCents, taxes: [{ kind: 'vat', amountCents: Math.round(subtotalCents * 0.15) }] }],
});
const linked = (invoiceId: string, projectId = PROJECT, organizationId = ORG_A) => ({ organizationId, projectId, invoiceId, billingId: uuid(), status: 'linked' });

let store: InMemoryStore;
let posting: ReturnType<typeof buildPosting>;

beforeEach(async () => {
  store = new InMemoryStore();
  await setupOrg(store);
  posting = buildPosting(store);
  n = 0;
});

const entryOf = (invoiceId: string) => [...store.entryMap.values()].find((e) => e.sourceType === 'invoice' && e.sourceId === invoiceId)!;
const income = (projectId?: string) =>
  new IncomeStatementUseCase(store.repos)
    .execute({ organizationId: ORG_A, from: '2026-01-01', to: '2026-12-31', projectId })
    .then((is) => is.sections.find((s) => s.key === 'income')!.totalCents);

describe('dimensión «proyecto» en lo que se contabiliza solo', () => {
  it('la factura de un proyecto sale con el proyecto en TODAS las líneas del asiento', async () => {
    const invoiceId = uuid();
    expect(await posting.tagSourceProject(linked(invoiceId))).toBe(true);
    await posting.handle('billing.invoice.issued', invoiceEvent(invoiceId, 10_000));
    const lines = entryOf(invoiceId).lines;
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.projectId === PROJECT)).toBe(true);
  });

  it('una factura que no viene de un proyecto queda sin proyecto', async () => {
    const invoiceId = uuid();
    await posting.handle('billing.invoice.issued', invoiceEvent(invoiceId, 10_000));
    expect(entryOf(invoiceId).lines.every((l) => l.projectId === null)).toBe(true);
  });

  it('la anulación reversa con el mismo proyecto: el proyecto queda en cero', async () => {
    const invoiceId = uuid();
    await posting.tagSourceProject(linked(invoiceId));
    await posting.handle('billing.invoice.issued', invoiceEvent(invoiceId, 10_000));
    await posting.handle('billing.invoice.voided', { organizationId: ORG_A, invoiceId, voidedAt: '2026-10-21T15:00:00.000Z', reason: 'error' });
    expect(await income(PROJECT)).toBe(0);
  });

  it('el estado de resultados filtrado por proyecto muestra solo lo facturado por ese proyecto', async () => {
    const a = uuid();
    const b = uuid();
    const sueltas = uuid();
    await posting.tagSourceProject(linked(a));
    await posting.tagSourceProject(linked(b, OTHER_PROJECT));
    await posting.handle('billing.invoice.issued', invoiceEvent(a, 10_000));
    await posting.handle('billing.invoice.issued', invoiceEvent(b, 3_000));
    await posting.handle('billing.invoice.issued', invoiceEvent(sueltas, 500));

    expect(await income(PROJECT)).toBe(10_000);
    expect(await income(OTHER_PROJECT)).toBe(3_000);
    expect(await income()).toBe(13_500);
  });

  it('el costo de ventas de esa factura también va al proyecto', async () => {
    const invoiceId = uuid();
    await posting.tagSourceProject(linked(invoiceId));
    await posting.handle('inventory.stock.consumed', {
      organizationId: ORG_A,
      movementId: uuid(),
      type: 'sale_out',
      accountingNature: 'cogs',
      totalCostCents: 6000,
      currencyCode: 'USD',
      occurredAt: '2026-10-20T15:00:00.000Z',
      referenceType: 'invoice',
      referenceId: invoiceId,
    });
    const cogs = [...store.entryMap.values()].find((e) => e.sourceType === 'stock_movement')!;
    expect(cogs.lines.every((l) => l.projectId === PROJECT)).toBe(true);
  });

  it('la anotación es por organización: el proyecto de otra empresa no se cuela', async () => {
    const invoiceId = uuid();
    await posting.tagSourceProject(linked(invoiceId, PROJECT, ORG_B));
    await posting.handle('billing.invoice.issued', invoiceEvent(invoiceId, 10_000));
    expect(entryOf(invoiceId).lines.every((l) => l.projectId === null)).toBe(true);
  });

  it('un evento sin factura o sin proyecto se ignora sin fallar', async () => {
    expect(await posting.tagSourceProject({ organizationId: ORG_A, projectId: PROJECT, invoiceId: null })).toBe(false);
    expect(await posting.tagSourceProject({ organizationId: ORG_A, invoiceId: uuid() })).toBe(false);
  });

  it('el consumidor escucha `projects.invoice.linked` e `issued` y ambos anotan', async () => {
    expect(CONSUMED_BINDINGS).toEqual(expect.arrayContaining(['projects.invoice.linked', 'projects.invoice.issued']));
    const handlers = buildEventHandlers({ posting, pluginToggle: buildPluginToggle(store) });
    const invoiceId = uuid();
    await handlers.find((h) => h.eventType === 'projects.invoice.issued')!.handle(linked(invoiceId), {} as never);
    expect(await store.repos.sourceProjects.find(ORG_A, 'invoice', invoiceId)).toBe(PROJECT);
  });
});
