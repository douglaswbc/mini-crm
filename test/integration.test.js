// test/integration.test.js — smoke test do schema e dos fluxos usando pg-mem
// Roda sem precisar de um PostgreSQL real: node test/integration.test.js
const assert = require('assert');
const { newDb } = require('pg-mem');

(async () => {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const pg = mem.adapters.createPg();
  const Module = require('module');
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (req) {
    if (req === 'pg') return pg;
    return originalRequire.apply(this, arguments);
  };

  process.env.DATABASE_URL = 'postgres://user:pass@localhost/x';
  process.env.ENCRYPTION_KEY = 'integration-test-key-000000000000';
  process.env.ADMIN_PASSWORD = 'senha-admin-teste';
  process.env.IMPORT_LEGACY = 'false';

  const db = require('../db');
  const crypto = require('crypto');

  await db.init();
  console.log('[ok] schema criado');

  // ---- Criptografia ----
  const token = 'ya29.secret-token-123';
  const enc = db.encrypt(token);
  assert.notStrictEqual(enc, token);
  assert.strictEqual(db.decrypt(enc), token);
  console.log('[ok] encrypt/decrypt AES-GCM');

  // ---- Tenant + lead upsert ----
  const tenant = await db.createTenant({
    id: 'tenant_t1', negocio_nome: 'Clínica Teste', valor_consulta: 200,
    api_key: crypto.randomBytes(20).toString('hex'),
  });
  const lead = await db.upsertLead(tenant.id, {
    id: 'lead_l1', lead_id: 'lead_abc', nome: 'Maria', email: 'maria@x.com',
    status: 'novo', timeline: [], recebido_em: new Date().toISOString(), negocio: tenant.negocio_nome,
  });
  assert.strictEqual(lead.nome, 'Maria');
  await db.upsertLead(tenant.id, { ...lead, nome: 'Maria Souza', timeline: [{ evento: 'followup_48h_enviado', em: new Date().toISOString() }] });
  const leads = await db.listLeads(tenant.id);
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(leads[0].nome, 'Maria Souza');
  assert.strictEqual(leads[0].timeline.length, 1);
  console.log('[ok] upsert lead (update + timeline jsonb)');

  // ---- Agenda + tickets ----
  await db.addAgendaEvent(tenant.id, { id: 'evt1', event_id: 'evt_g1', acao: 'confirmar', status: 'confirmado', em: new Date().toISOString() });
  await db.addTicket(tenant.id, { id: 'tkt1', de: 'joao@x.com', assunto: 'Orçamento', setor: 'vendas', prioridade: 'alta', resumo: 'pediu proposta', data: new Date().toISOString(), log_em: new Date().toISOString(), negocio: tenant.negocio_nome });
  const agenda = await db.listAgenda(tenant.id);
  const tickets = await db.listTickets(tenant.id);
  assert.strictEqual(agenda.length, 1);
  assert.strictEqual(tickets.length, 1);
  console.log('[ok] agenda events + tickets');

  // ---- Users / sessões ----
  const bcrypt = require('bcryptjs');
  const admin = await db.createUser({ id: 'usr_admin', tenant_id: null, username: 'admin', password_hash: await bcrypt.hash('s3nh@', 4), role: 'admin' });
  const client = await db.createUser({ id: 'usr_cli', tenant_id: tenant.id, username: 'cliente1', password_hash: await bcrypt.hash('senha1', 4), role: 'client' });
  await db.createSession({ id: 'sess_admin', user_id: admin.id, expires_at: new Date(Date.now() + 3600000).toISOString() });
  await db.createSession({ id: 'sess_cli', user_id: client.id, expires_at: new Date(Date.now() + 3600000).toISOString() });
  const sAdmin = await db.getSession('sess_admin');
  const sCli = await db.getSession('sess_cli');
  assert.strictEqual(sAdmin.role, 'admin');
  assert.strictEqual(sCli.tenant_id, tenant.id);
  assert.strictEqual(sCli.negocio_nome, 'Clínica Teste');
  console.log('[ok] users + sessões + join tenant');

  // ---- Google account (criptografado) ----
  await db.saveGoogleAccount(tenant.id, {
    google_email: 'clinica@gmail.com', access_token: 'at', refresh_token: 'rt-secret', token_expiry: new Date().toISOString(), scope: 'calendar',
  });
  const acc = await db.getGoogleAccount(tenant.id);
  assert.strictEqual(acc.refresh_token, 'rt-secret');
  await db.replaceCalendars(tenant.id, [
    { id: 'g1', calendar_id: 'clinica@gmail.com', summary: 'Agenda Principal', selected: true },
    { id: 'g2', calendar_id: 'agenda2@group.calendar.google.com', summary: 'Agenda Sala 2', selected: false },
  ]);
  const cals = await db.listCalendars(tenant.id);
  assert.strictEqual(cals.length, 2);
  await db.setCalendarSelected(tenant.id, 'agenda2@group.calendar.google.com', true);
  const cals2 = await db.listCalendars(tenant.id);
  assert.strictEqual(cals2.find((c) => c.calendar_id === 'agenda2@group.calendar.google.com').selected, true);
  console.log('[ok] google account + calendars (seleção)');

  // ---- Overrides ----
  await db.setOverride(tenant.id, '2026-01-01', '2026-01-07', 3, 1500);
  const ov = await db.getOverride(tenant.id, '2026-01-01', '2026-01-07');
  assert.strictEqual(ov.faltas, 3);
  assert.strictEqual(Number(ov.receita_estimada), 1500);
  console.log('[ok] overrides');

  console.log('\nTODOS OS TESTES PASSARAM ✅');
  process.exit(0);
})().catch((e) => {
  console.error('FALHA:', e);
  process.exit(1);
});