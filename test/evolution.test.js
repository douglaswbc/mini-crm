// test/evolution.test.js — teste do canal WhatsApp (Evolution API) com pg-mem
// Roda sem PostgreSQL real e sem Evolution real: node test/evolution.test.js
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
  process.env.PORT = '3458';
  process.env.CRM_BASE_URL = 'http://localhost:3458';

  require('../server');

  const BASE = 'http://localhost:3458';
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

  // ---- Login admin + criar tenant + usuário cliente ----
  let r = await post('/api/auth/login', { username: 'admin', password: 'senha-admin-teste' });
  assert.strictEqual(r.status, 200, 'login admin');
  const adminToken = (await r.json()).token;

  r = await post('/admin/api/tenants', { negocio_nome: 'Clínica Vitalis', valor_consulta: 200 }, adminToken);
  assert.strictEqual(r.status, 200, 'criar tenant');
  const tenant = (await r.json()).tenant;

  r = await post('/admin/api/users', { username: 'vitalis', password: 'senha123', tenant_id: tenant.id }, adminToken);
  assert.strictEqual(r.status, 200, 'criar usuário cliente');
  r = await post('/api/auth/login', { username: 'vitalis', password: 'senha123' });
  assert.strictEqual(r.status, 200, 'login cliente');
  const cliToken = (await r.json()).token;
  console.log('[ok] setup (admin, tenant, cliente)');

  // ---- Cliente salva a instância manualmente (CRUD local, sem chamar a Evolution) ----
  r = await fetch(`${BASE}/api/whatsapp`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cliToken}` },
    body: JSON.stringify({
      instance_name: 'wa_test',
      instance_id: '11111111-2222-3333-4444-555555555555',
      instance_token: 'token-teste',
      forward_url: 'http://localhost:3458/n8n/qualificador-leads',
    }),
  });
  assert.strictEqual(r.status, 200, 'salvar config whatsapp');
  console.log('[ok] salvar instância (CRUD local)');

  // ---- Status: webhook_url + instância salva ----
  r = await fetch(`${BASE}/api/whatsapp/status`, { headers: { Authorization: `Bearer ${cliToken}` } });
  assert.strictEqual(r.status, 200, 'status whatsapp');
  const st = await r.json();
  assert.ok(st.webhook_url, 'webhook_url presente');
  assert.ok(st.webhook_url.includes('/api/evolution/webhook'), 'caminho do webhook');
  assert.strictEqual(st.instance.instance_name, 'wa_test');
  assert.strictEqual(st.instance.instance_id, '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(st.instance.instance_token, 'token-teste');
  assert.strictEqual(st.instance.forward_url, 'http://localhost:3458/n8n/qualificador-leads');
  console.log('[ok] status + webhook_url');

  const waItem = (over = {}) => ({
    body: {
      event: 'Message',
      instanceName: 'wa_test',
      instanceToken: 'token-teste',
      data: {
        Info: {
          Chat: '551199998888@s.whatsapp.net',
          Sender: '551199998888@s.whatsapp.net',
          PushName: 'Maria',
          IsFromMe: false,
          IsGroup: false,
          MediaType: 'conversation',
          Type: 'chat',
          Timestamp: 1700000000,
          ID: 'MID1',
          ...(over.info || {}),
        },
        Message: { conversation: 'Olá, quero marcar uma consulta' },
        ...(over.data || {}),
      },
    },
  });

  // ---- Texto ----
  r = await post('/api/evolution/webhook', [waItem()]);
  assert.strictEqual(r.status, 200, 'webhook texto');
  assert.strictEqual((await r.json()).ok, true);

  // ---- Áudio (mídia vira descritor + URL, sem base64) ----
  r = await post('/api/evolution/webhook', [waItem({
    info: { ID: 'MID2', MediaType: 'audio' },
    data: { Message: { audioMessage: { mimetype: 'audio/ogg', seconds: 12, URL: 'https://ev.ex/audio.ogg' } } },
  })]);
  assert.strictEqual(r.status, 200, 'webhook áudio');

  // ---- Imagem ----
  r = await post('/api/evolution/webhook', [waItem({
    info: { ID: 'MID3', MediaType: 'image' },
    data: { Message: { imageMessage: { mimetype: 'image/jpeg', URL: 'https://ev.ex/img.jpg' } } },
  })]);
  assert.strictEqual(r.status, 200, 'webhook imagem');

  // ---- Documento (PDF) ----
  r = await post('/api/evolution/webhook', [waItem({
    info: { ID: 'MID4', MediaType: 'document' },
    data: { Message: { documentMessage: { mimetype: 'application/pdf', URL: 'https://ev.ex/ficha.pdf', fileName: 'ficha.pdf' } } },
  })]);
  assert.strictEqual(r.status, 200, 'webhook documento');

  // ---- Dup mesmo mid => ignorado ----
  await post('/api/evolution/webhook', [waItem()]);
  // ---- IsFromMe => ignorado ----
  await post('/api/evolution/webhook', [waItem({ info: { IsFromMe: true } })]);
  // ---- Grupo => ignorado ----
  await post('/api/evolution/webhook', [waItem({ info: { IsGroup: true, ID: 'MID5' } })]);
  // ---- Token desconhecido => ignorado ----
  await post('/api/evolution/webhook', [{ body: { event: 'Message', instanceToken: 'token-desconhecido', data: { Info: { Chat: '551122223333@s.whatsapp.net', ID: 'MIDX' }, Message: { conversation: 'oi' } } } }]);
  console.log('[ok] webhooks enviados (texto, áudio, imagem, documento, dups/ruído)');

  // ---- Lead único por contato + timeline com as 4 mensagens ----
  r = await fetch(`${BASE}/api/tenant/data`, { headers: { Authorization: `Bearer ${cliToken}` } });
  const data = await r.json();
  const waLeads = data.leads.filter((l) => l.origem === 'whatsapp');
  assert.strictEqual(waLeads.length, 1, 'um lead por contato');
  const lead = waLeads[0];
  assert.strictEqual(lead.lead_id, 'wa_551199998888');
  assert.strictEqual(lead.telefone, '551199998888');
  assert.strictEqual(lead.nome, 'Maria');
  assert.strictEqual(lead.status, 'novo');
  assert.strictEqual(lead.timeline.length, 4, '4 eventos na timeline (dedup funciona)');
  assert.strictEqual(lead.timeline[0].tipo, 'texto');
  assert.strictEqual(lead.timeline[0].texto, 'Olá, quero marcar uma consulta');
  assert.strictEqual(lead.timeline[1].tipo, 'audio');
  assert.ok(lead.timeline[1].url.includes('audio.ogg'), 'url do áudio preservada');
  assert.strictEqual(lead.timeline[2].tipo, 'imagem');
  assert.strictEqual(lead.timeline[3].tipo, 'documento');
  assert.strictEqual(lead.timeline[3].texto, '[documento: ficha.pdf]');
  assert.ok(lead.timeline.every((t) => t.mid && t.mid !== 'MID5'), 'mid gravados');
  console.log('[ok] lead único wa_ + timeline com dedup');

  // ---- Admin também gerencia a instância do tenant via escopo ----
  r = await fetch(`${BASE}/api/whatsapp/status?tenant_id=${tenant.id}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.strictEqual(r.status, 200, 'status como admin');
  assert.strictEqual((await r.json()).instance.instance_name, 'wa_test');
  console.log('[ok] admin enxerga instância do tenant');

  // ---- Cliente não acessa instância de outro tenant (tenant_id ignorado) ----
  r = await fetch(`${BASE}/api/whatsapp/status?tenant_id=tenant_outro`, { headers: { Authorization: `Bearer ${cliToken}` } });
  const spoof = await r.json();
  assert.strictEqual(spoof.instance.instance_name, 'wa_test', 'escopo do cliente forçado');
  console.log('[ok] isolamento whatsapp entre tenants');

  console.log('\nTODOS OS TESTES DE WHATSAPP PASSARAM ✅');
  process.exit(0);
})().catch((e) => {
  console.error('FALHA:', e);
  process.exit(1);
});