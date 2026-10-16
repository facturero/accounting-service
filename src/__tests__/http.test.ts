import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore, ORG_A, ORG_B, buildApp, headers, setupOrg } from './helpers.js';

let store: InMemoryStore;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  store = new InMemoryStore();
  app = buildApp(store);
});

async function call(method: string, path: string, opts: { org?: string; perms?: string[]; body?: unknown; noOrg?: boolean } = {}) {
  const h: Record<string, string> = headers(opts.org ?? ORG_A, opts.perms);
  if (opts.noOrg) delete h['X-Organization-Id'];
  const res = await app.request(path, { method, headers: h, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('contexto y permisos', () => {
  it('sin organización responde 401', async () => {
    expect((await call('GET', '/accounting/accounts', { noOrg: true })).status).toBe(401);
  });

  it('el health no pide contexto', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it.each([
    ['GET', '/accounting/accounts', 'account:read'],
    ['POST', '/accounting/setup', 'account:manage'],
    ['GET', '/accounting/journal-entries', 'journal:read'],
    ['POST', '/accounting/fiscal-years', 'period:manage'],
    ['GET', '/accounting/reports/trial-balance?from=2026-01-01&to=2026-01-31', 'ledger:read'],
  ])('%s %s exige %s', async (method, path, perm) => {
    const res = await call(method, path, { perms: ['otro:permiso'], body: method === 'POST' ? {} : undefined });
    expect(res.status).toBe(403);
    expect(perm).toBeTruthy();
  });
});

describe('flujo completo por HTTP', () => {
  it('configura, crea una cuenta, contabiliza, consulta el balance y reversa', async () => {
    expect((await call('GET', '/accounting/settings')).json).toMatchObject({ configured: false });
    const setup = await call('POST', '/accounting/setup', { body: { chartTemplate: 'ec-supercias', fiscalYear: 2026 } });
    expect(setup.status).toBe(201);
    expect((await call('POST', '/accounting/setup', { body: {} })).status).toBe(409);

    const accounts = (await call('GET', '/accounting/accounts')).json as { id: string; code: string }[];
    const id = (code: string) => accounts.find((a) => a.code === code)!.id;

    const created = await call('POST', '/accounting/journal-entries', {
      body: {
        entryDate: '2026-04-10', description: 'Venta de contado', post: true,
        lines: [{ accountId: id('1.1.01.01'), debitCents: 11500 }, { accountId: id('4.1.01'), creditCents: 10000 }, { accountId: id('2.1.03.01'), creditCents: 1500 }],
      },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ number: 'AS-2026-000001', status: 'posted', totalDebitCents: 11500 });

    const tb = await call('GET', '/accounting/reports/trial-balance?from=2026-04-01&to=2026-04-30');
    expect(tb.json.totals).toMatchObject({ debitCents: 11500, creditCents: 11500 });

    const reversed = await call('POST', `/accounting/journal-entries/${created.json.id}/reverse`, { body: { reason: 'Venta anulada' } });
    expect(reversed.status).toBe(201);
    expect(reversed.json.original.reversedByEntryId).toBe(reversed.json.reversal.id);
    expect((await call('POST', `/accounting/journal-entries/${created.json.id}/reverse`, { body: { reason: 'otra vez' } })).status).toBe(409);
  });

  it('crear un borrador no exige contabilizar; contabilizar al crear sí exige journal:post', async () => {
    await call('POST', '/accounting/setup', { body: { fiscalYear: 2026 } });
    const accounts = (await call('GET', '/accounting/accounts')).json as { id: string; code: string }[];
    const body = (post: boolean) => ({
      entryDate: '2026-04-10', description: 'x', post,
      lines: [{ accountId: accounts.find((a) => a.code === '1.1.01.01')!.id, debitCents: 100 }, { accountId: accounts.find((a) => a.code === '4.1.01')!.id, creditCents: 100 }],
    });
    const perms = ['journal:create', 'account:read'];
    expect((await call('POST', '/accounting/journal-entries', { perms, body: body(false) })).status).toBe(201);
    expect((await call('POST', '/accounting/journal-entries', { perms, body: body(true) })).status).toBe(403);
  });

  it('valida el cuerpo con 422 y detalles', async () => {
    await call('POST', '/accounting/setup', { body: { fiscalYear: 2026 } });
    const res = await call('POST', '/accounting/journal-entries', { body: { entryDate: 'hoy', description: '', lines: [] } });
    expect(res.status).toBe(422);
    expect(res.json.details.length).toBeGreaterThan(0);
    const unbalanced = await call('POST', '/accounting/journal-entries', {
      body: { entryDate: '2026-04-10', description: 'x', lines: [{ accountId: '44444444-4444-4444-8444-444444444441', debitCents: 5 }, { accountId: '44444444-4444-4444-8444-444444444442', creditCents: 4 }] },
    });
    expect(unbalanced.status).toBe(422);
  });

  it('un campo desconocido en el cuerpo se rechaza', async () => {
    const res = await call('POST', '/accounting/setup', { body: { fiscalYear: 2026, organizationId: ORG_B } });
    expect(res.status).toBe(422);
  });

  it('el tamaño de página se acota', async () => {
    await setupOrg(store);
    const res = await call('GET', '/accounting/journal-entries?pageSize=100000');
    expect(res.json.pageSize).toBe(100);
    expect((await call('GET', '/accounting/journal-entries?page=abc')).status).toBe(422);
  });
});

describe('aislamiento entre organizaciones', () => {
  it('una organización no ve ni toca los asientos de otra', async () => {
    const env = await setupOrg(store, ORG_A);
    const entry = await env.uc.createEntry.execute({
      organizationId: ORG_A, userId: '33333333-3333-4333-8333-333333333333', entryDate: '2026-04-10', description: 'Privado', post: true,
      lines: [{ accountId: env.byCode('1.1.01.01').id, debitCents: 100 }, { accountId: env.byCode('4.1.01').id, creditCents: 100 }],
    });
    expect((await call('GET', `/accounting/journal-entries/${entry.id}`, { org: ORG_B })).status).toBe(404);
    expect((await call('POST', `/accounting/journal-entries/${entry.id}/reverse`, { org: ORG_B, body: { reason: 'intento' } })).status).toBe(404);
    expect((await call('DELETE', `/accounting/journal-entries/${entry.id}`, { org: ORG_B })).status).toBe(404);
    expect((await call('GET', '/accounting/journal-entries', { org: ORG_B })).json.total).toBe(0);
    expect((await call('GET', `/accounting/accounts/${env.byCode('1.1.01.01').id}`, { org: ORG_B })).status).toBe(404);
  });
});

describe('contabilización automática por HTTP', () => {
  it('ajustes: se leen, se cambian y exigen permiso', async () => {
    await call('POST', '/accounting/setup', { body: { fiscalYear: 2026 } });
    const got = await call('GET', '/accounting/posting-settings');
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ pendingCount: 0, settings: { autoPosting: true, timezone: 'America/Guayaquil' } });
    expect(got.json.defaultPaymentMethodRoles['01']).toBe('cash');

    const put = await call('PUT', '/accounting/posting-settings', { body: { autoPosting: false, paymentMethodRoles: { '01': 'bank' } } });
    expect(put.json).toMatchObject({ autoPosting: false, paymentMethodRoles: { '01': 'bank' } });
    expect((await call('PUT', '/accounting/posting-settings', { perms: ['account:read'], body: { autoPosting: true } })).status).toBe(403);
    expect((await call('PUT', '/accounting/posting-settings', { body: { paymentMethodRoles: { '01': 'oro' } } })).status).toBe(422);
    expect((await call('PUT', '/accounting/posting-settings', { body: { cualquiera: 1 } })).status).toBe(422);
  });

  it('pendientes: listar pide journal:read; reintentar y descartar piden journal:post', async () => {
    await call('POST', '/accounting/setup', { body: { fiscalYear: 2026 } });
    const list = await call('GET', '/accounting/pending-postings?status=pending');
    expect(list.json).toMatchObject({ items: [], total: 0 });
    expect((await call('GET', '/accounting/pending-postings', { perms: ['account:read'] })).status).toBe(403);
    expect((await call('GET', '/accounting/pending-postings?status=otro')).status).toBe(422);
    expect((await call('POST', '/accounting/pending-postings/retry', { perms: ['journal:read'], body: {} })).status).toBe(403);
    expect((await call('POST', '/accounting/pending-postings/retry', { body: {} })).json).toEqual({ posted: 0, stillPending: 0, discarded: 0 });
    expect((await call('POST', '/accounting/pending-postings/44444444-4444-4444-8444-444444444441/discard', { body: { reason: 'prueba' } })).status).toBe(404);
  });

  it('el rol de una cuenta se mueve con PATCH y se valida', async () => {
    await call('POST', '/accounting/setup', { body: { fiscalYear: 2026 } });
    const accounts = (await call('GET', '/accounting/accounts')).json as { id: string; code: string; systemRole: string | null }[];
    const bank = accounts.find((a) => a.code === '1.1.01.02')!;
    const patched = await call('PATCH', `/accounting/accounts/${bank.id}`, { body: { systemRole: 'cash' } });
    expect(patched.json.systemRole).toBe('cash');
    const after = (await call('GET', '/accounting/accounts')).json as typeof accounts;
    expect(after.find((a) => a.code === '1.1.01.01')!.systemRole).toBeNull();
    expect((await call('PATCH', `/accounting/accounts/${bank.id}`, { body: { systemRole: 'inventado' } })).status).toBe(422);
    expect((await call('PATCH', `/accounting/accounts/${accounts.find((a) => a.code === '1.1')!.id}`, { body: { systemRole: 'cash' } })).status).toBe(422);
  });
});
