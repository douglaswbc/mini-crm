// test/http.test.js — teste HTTP end-to-end com pg-mem
// Roda sem PostgreSQL real: node test/http.test.js
const assert = require('assert');
const { newDb } = require('pg-mem');

(async () => {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const pg = mem.adapters.createPg();
  const Module = require('module');
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (req) {
    if (req === 'pg') return pg;
    return origRequire.apply(this, arguments);
  };

  process.env.DATABASE_URL = 'postgres://user:pass@localhost/x';
  process.env.ENCRYPTION_KEY = 'integration-test-key-000000000000';
  process.env.ADMIN_PASSWORD = 'senha-admin-teste';
  process.env.IMPORT_LEGACY = 'false';
  process.env.PORT = '3457';
  process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3457/api/google/oauth/callback';

  require('../server');

  const BASE = 'http://localhost:3457';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch (e) {}
    await wait(200);
  }

  const post = (p, body, token) => fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });

  // ---- Login admin ----
  let r = await post('/api/auth/login', { username: 'admin', password: 'senha-admin-teste' });
  assert.strictEqual(r.status, 200, 'login admin');
  const login = await r.json();
  assert.strictEqual(login.user.role, 'admin');
  const adminToken = login.token;
  console.log('[ok] login admin');

  // ---- Criar tenant ----
  r = await post('/admin/api/tenants', { negocio_nome: 'Clínica Vitalis', valor_consulta: 200 }, adminToken);
  assert.strictEqual(r.status, 200, 'criar tenant');
  const tenant = (await r.json()).tenant;
  assert.ok(tenant.api_key, 'api key gerada');
  console.log('[ok] criar tenant + api key');

  // ---- Criar usuário do cliente ----
  r = await post('/admin/api/users', { username: 'vitalis', password: 'senha123', tenant_id: tenant.id }, adminToken);
  assert.strictEqual(r.status, 200, 'criar usuário cliente');
  console.log('[ok] criar usuário do cliente');

  // ---- Login do cliente ----
  r = await post('/api/auth/login', { username: 'vitalis', password: 'senha123' });
  assert.strictEqual(r.status, 200, 'login cliente');
  const cliLogin = await r.json();
  assert.strictEqual(cliLogin.user.role, 'client');
  assert.strictEqual(cliLogin.user.tenant_id, tenant.id);
  const cliToken = cliLogin.token;
  console.log('[ok] login do cliente (escopo correto)');

  // ---- Workflow API key: criar lead ----
  r = await post('/api/leads', { nome: 'João', email: 'joao@x.com', telefone: '1199999999', origem: 'instagram' }, null, tenant.api_key);
  assert.strictEqual(r.status, 401, 'sem header => 401');
  r = await fetch(`${BASE}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.api_key}` },
    body: JSON.stringify({ nome: 'João', email: 'joao@x.com', origem: 'instagram' }),
  });
  assert.strictEqual(r.status, 200, 'criar lead via api key');
  const leadRes = await r.json();
  assert.strictEqual(leadRes.lead.nome, 'João');
  const leadId = leadRes.lead.lead_id;

  // follow-up event na timeline
  await fetch(`${BASE}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.api_key}` },
    body: JSON.stringify({ lead_id: leadId, evento: 'followup_48h_enviado', enviado_em: new Date().toISOString() }),
  });
  console.log('[ok] webhook leads (criar + evento timeline)');

  // ---- Cliente vê só os dados dele ----
  r = await fetch(`${BASE}/api/tenant/data`, { headers: { Authorization: `Bearer ${cliToken}` } });
  assert.strictEqual(r.status, 200, 'dados do cliente');
  const data = await r.json();
  assert.strictEqual(data.tenant.id, tenant.id);
  assert.strictEqual(data.leads.length, 1);
  assert.strictEqual(data.leads[0].timeline.length, 1, 'timeline mesclada');
  console.log('[ok] cliente enxerga apenas o próprio tenant');

  // ---- Cliente NÃO acessa dados de outro tenant (parâmetro ignorado, escopo forçado) ----
  r = await fetch(`${BASE}/api/tenant/data?tenant_id=tenant_outro`, { headers: { Authorization: `Bearer ${cliToken}` } });
  assert.strictEqual(r.status, 200, 'cliente acessa endpoint');
  const spoof = await r.json();
  assert.strictEqual(spoof.tenant.id, tenant.id, 'tenant_id externo é ignorado');
  console.log('[ok] isolamento entre tenants (param tenant_id ignorado para cliente)');

  // ---- Métricas ----
  r = await fetch(`${BASE}/api/tenant/metrics?from=2020-01-01&to=2030-01-01`, { headers: { Authorization: `Bearer ${cliToken}` } });
  assert.strictEqual(r.status, 200, 'métricas cliente');
  const metrics = await r.json();
  assert.strictEqual(metrics.leads_entrantes, 1);
  assert.strictEqual(metrics.followups_enviados, 1);
  assert.strictEqual(metrics.receita_estimada, 0);
  console.log('[ok] métricas semanais');

  // ---- Google OAuth start ----
  r = await fetch(`${BASE}/api/google/status`, { headers: { Authorization: `Bearer ${cliToken}` } });
  assert.strictEqual(r.status, 200, 'google status');
  const gs = await r.json();
  assert.strictEqual(gs.configured, true);
  assert.strictEqual(gs.connected, false);
  r = await post('/api/google/oauth/start', {}, cliToken);
  assert.strictEqual(r.status, 200, 'google oauth start');
  const start = await r.json();
  assert.ok(start.url.includes('accounts.google.com'), 'url do google');
  assert.ok(start.url.includes('tenantId'), 'state com tenantId');
  console.log('[ok] google oauth start (url gerada)');

  // ---- Admin vê tudo, cliente não ajusta override ----
  r = await post('/api/tenant/metrics/override', { tenant_id: tenant.id, from: '2020-01-01', to: '2030-01-01', faltas: 2, receita_estimada: 500 }, adminToken);
  assert.strictEqual(r.status, 200, 'admin override ok');
  r = await post('/api/tenant/metrics/override', { tenant_id: tenant.id, from: '2020-01-01', to: '2030-01-01', faltas: 2 }, cliToken);
  assert.strictEqual(r.status, 403, 'cliente não pode override');
  console.log('[ok] overrides (admin ok, cliente bloqueado)');

  console.log('\nTODOS OS TESTES HTTP PASSARAM ✅');
  process.exit(0);
})().catch((e) => {
  console.error('FALHA:', e);
  process.exit(1);
});