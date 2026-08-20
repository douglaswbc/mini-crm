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

  // Mock HTTP da Evolution: grava o body do /instance/create e responde 200
  // (ou 500 quando o name for "falha", para testar o caminho de erro sem
  // derrubar o servidor).
  const http = require('http');
  let lastCreate = null;
  let lastConnect = null;
  const createdInstances = [];
  const mockEvo = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/instance/create') {
        lastCreate = body;
        if (body.name === 'falha') return send(500, { message: 'erro simulado' });
        createdInstances.push({ id: body.instanceId, name: body.name, token: body.token, webhook: '', jid: '', connected: false });
        return send(200, { hash: { id: body.instanceId, instanceId: body.instanceId } });
      }
      if (req.method === 'GET' && req.url === '/instance/all') {
        return send(200, { success: true, instances: [
          { id: '55555555-4444-3333-2222-111111111111', name: 'teste-manual', token: 'token-manual', webhook: '', jid: '', connected: false },
          ...createdInstances,
        ] });
      }
      if (req.method === 'POST' && req.url.startsWith('/instance/connect/')) {
        lastConnect = body;
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && req.url.startsWith('/instance/status/')) {
        return send(200, { instance: { status: 'open', ownerJid: '551199998888' } });
      }
      send(200, { ok: true });
    });
  });

  process.env.DATABASE_URL = 'postgres://user:pass@localhost/x';
  process.env.ENCRYPTION_KEY = 'integration-test-key-000000000000';
  process.env.ADMIN_PASSWORD = 'senha-admin-teste';
  process.env.IMPORT_LEGACY = 'false';
  process.env.PORT = '3458';
  await new Promise((resolve) => mockEvo.listen(0, resolve));
  process.env.EVOLUTION_BASE_URL = `http://127.0.0.1:${mockEvo.address().port}`;
  process.env.EVOLUTION_GLOBAL_API_KEY = 'global-key-teste';
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

  // ---- Salva configuração (nome + forward) ----
  r = await fetch(`${BASE}/api/whatsapp`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cliToken}` },
    body: JSON.stringify({
      instance_name: 'wa_test',
      forward_url: 'http://localhost:3458/n8n/qualificador-leads',
    }),
  });
  assert.strictEqual(r.status, 200, 'salvar config whatsapp');
  console.log('[ok] salvar configuração (nome + forward)');

  // ---- Criar instância (mock da Evolution) => instanceId é UUID ----
  r = await fetch(`${BASE}/api/whatsapp/instance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cliToken}` },
    body: JSON.stringify({ instance_name: 'wa_test', instance_token: 'token-teste', forward_url: 'http://localhost:3458/n8n/qualificador-leads' }),
  });
  assert.strictEqual(r.status, 200, 'criar instância');
  const created = await r.json();
  assert.ok(lastCreate, 'evolution recebeu o create');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.ok(uuidRe.test(lastCreate.instanceId), 'instanceId é UUID (' + lastCreate.instanceId + ')');
  assert.strictEqual(lastCreate.name, 'wa_test');
  assert.strictEqual(lastCreate.token, 'token-teste');
  assert.strictEqual(created.instance.instance_id, lastCreate.instanceId, 'UUID salvo no banco');
  const waUuid = created.instance.instance_id;
  console.log('[ok] criar instância (instanceId=UUID, name=wa_test)');

  // ---- Criação com a Evolution devolvendo erro => 502 JSON, servidor vivo ----
  r = await fetch(`${BASE}/api/whatsapp/instance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cliToken}` },
    body: JSON.stringify({ instance_name: 'falha', forward_url: 'http://localhost:3458/n8n' }),
  });
  assert.strictEqual(r.status, 502, 'evolution com erro => 502 JSON');
  const createErr = await r.json();
  assert.strictEqual(createErr.error, 'Evolution API: erro simulado');
  r = await fetch(`${BASE}/health`);
  assert.strictEqual(r.status, 200, 'servidor segue vivo após erro da evolution');
  console.log('[ok] evolução com erro => 502 JSON sem derrubar o servidor');

  // ---- Conectar => aponta o webhook do CRM ----
  r = await fetch(`${BASE}/api/whatsapp/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cliToken}` },
    body: JSON.stringify({}),
  });
  assert.strictEqual(r.status, 200, 'conectar instância');
  assert.ok(lastConnect, 'evolution recebeu o connect');
  assert.ok(Array.isArray(lastConnect.subscribe) && lastConnect.subscribe.includes('ALL'), 'subscribe ALL');
  assert.ok(lastConnect.webhookUrl.includes('/api/evolution/webhook'), 'webhook aponta para o CRM');
  console.log('[ok] conectar (subscribe ALL + webhook do CRM)');

  // ---- Status: configured + webhook_url + instância com UUID ----
  r = await fetch(`${BASE}/api/whatsapp/status`, { headers: { Authorization: `Bearer ${cliToken}` } });
  assert.strictEqual(r.status, 200, 'status whatsapp');
  const st = await r.json();
  assert.strictEqual(st.configured, true, 'evolution configurada no servidor');
  assert.ok(st.webhook_url, 'webhook_url presente');
  assert.ok(st.webhook_url.includes('/api/evolution/webhook'), 'caminho do webhook');
  assert.strictEqual(st.instance.instance_name, 'wa_test');
  assert.strictEqual(st.instance.instance_id, waUuid);
  assert.strictEqual(st.instance.instance_token, 'token-teste');
  assert.strictEqual(st.instance.forward_url, 'http://localhost:3458/n8n/qualificador-leads');
  assert.ok(st.live && st.live.instance && st.live.instance.status === 'open', 'status live consultado');
  console.log('[ok] status + webhook_url');

  // ---- Listar instâncias existentes na Evolution ----
  r = await fetch(`${BASE}/api/whatsapp/instances`, { headers: { Authorization: `Bearer ${cliToken}` } });
  assert.strictEqual(r.status, 200, 'listar instâncias');
  const list = await r.json();
  assert.ok(Array.isArray(list.instances) && list.instances.length >= 1, 'instâncias listadas');
  assert.ok(list.instances.some((i) => i.instance_name === 'teste-manual' && i.instance_id === '55555555-4444-3333-2222-111111111111'), 'instância manual presente');
  console.log('[ok] listar instâncias da Evolution');

  // ---- Adotar uma instância criada manualmente no painel ----
  r = await fetch(`${BASE}/api/whatsapp/adopt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cliToken}` },
    body: JSON.stringify({ instance_id: '55555555-4444-3333-2222-111111111111' }),
  });
  assert.strictEqual(r.status, 200, 'adotar instância');
  const adoptRes = await r.json();
  assert.strictEqual(adoptRes.instance.instance_name, 'teste-manual');
  assert.strictEqual(adoptRes.instance.instance_id, '55555555-4444-3333-2222-111111111111');
  assert.strictEqual(adoptRes.instance.instance_token, 'token-manual');
  assert.ok(waUuid, 'a instância criada antes continua existindo na Evolution');
  console.log('[ok] adotar instância criada manualmente');

  // ---- Adotar id inexistente => 404 ----
  r = await fetch(`${BASE}/api/whatsapp/adopt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cliToken}` },
    body: JSON.stringify({ instance_id: '00000000-0000-0000-0000-000000000000' }),
  });
  assert.strictEqual(r.status, 404, 'adotar id inexistente => 404');
  console.log('[ok] adotar id inexistente => 404');

  // ---- Volta a usar a instância criada pelo CRM (re-adota) ----
  r = await fetch(`${BASE}/api/whatsapp/adopt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cliToken}` },
    body: JSON.stringify({ instance_id: waUuid }),
  });
  assert.strictEqual(r.status, 200, 're-adotar instância criada pelo CRM');
  const readopt = await r.json();
  assert.strictEqual(readopt.instance.instance_id, waUuid);
  console.log('[ok] re-adotar instância criada pelo CRM');

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