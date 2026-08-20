// server.js
//
// Mini-CRM para o playbook "Automação Rentável" — agora sobre PostgreSQL.
//
// Três superfícies:
//  1. API pública (workflows n8n): header "Authorization: Bearer <api_key>" do cliente.
//  2. API do painel (admin + cliente): login por usuário/senha -> token de sessão.
//  3. OAuth2 do Google Calendar: cliente conecta a conta e seleciona as agendas.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { google } = require('googleapis');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(require('path').join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

// Credenciais do "projeto Google Cloud" (uma por instalação; cada cliente
// autoriza a PRÓPRIA conta Google via OAuth2).
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI
  || `http://localhost:${PORT}/api/google/oauth/callback`;
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function googleOAuthClient(redirectUri = GOOGLE_REDIRECT_URI) {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
}

function oauthConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

// Evolution API (WhatsApp) — servidor onde as instâncias são criadas
// EVOLUTION_BASE_URL: ex "https://evogo.autofunil.com.br" (sem barra final)
// EVOLUTION_GLOBAL_API_KEY: o "GLOBAL_API_KEY" da stack da Evolution
// CRM_BASE_URL: domínio público do painel (usado como webhook da instância)
const EVOLUTION_BASE_URL = (process.env.EVOLUTION_BASE_URL || '').replace(/\/+$/, '');
const EVOLUTION_GLOBAL_API_KEY = process.env.EVOLUTION_GLOBAL_API_KEY || '';
const CRM_BASE_URL = (process.env.CRM_BASE_URL || 'https://crm.autofunil.com.br').replace(/\/+$/, '');
const EVOLUTION_WEBHOOK_PATH = '/api/evolution/webhook';

function evolutionConfigured() {
  return Boolean(EVOLUTION_BASE_URL && EVOLUTION_GLOBAL_API_KEY);
}

function evolutionWebhookUrl() {
  // URL que a instância usa para mandar eventos -> aponta para o próprio CRM.
  return `${CRM_BASE_URL}${EVOLUTION_WEBHOOK_PATH}`;
}

// Chama a API da Evolution (criação/status/qr/logout de instâncias).
// "admin" usa a GLOBAL_API_KEY; "instance" usa o token da instância.
async function callEvolution(method, path, { token, body } = {}) {
  const apiKey = token || EVOLUTION_GLOBAL_API_KEY;
  const res = await fetch(`${EVOLUTION_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* não-JSON */ }
  if (!res.ok) {
    const msg = json && (json.response?.message || json.message || json.error) || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Guarda os tokens com vencimento de 55 min (Google dá ~1h por padrão)
function computeExpiry() {
  return new Date(Date.now() + 55 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Autenticação do painel (sessão)
// ---------------------------------------------------------------------------

async function requireSession(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  const session = await db.getSession(token);
  if (!session) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  req.session = session;
  req.user = session;
  req.token = token;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  }
  next();
}

function requireClientScope(req, res, next) {
  // Admin pode agir sobre qualquer tenant (via ?tenant_id); cliente só sobre o dele.
  if (!req.user) return res.status(401).json({ error: 'Não autenticado.' });
  if (req.user.role === 'admin') return next();
  if (req.user.role === 'client' && req.user.tenant_id) return next();
  res.status(403).json({ error: 'Conta sem tenant vinculado.' });
}

function effectiveTenantId(req) {
  if (req.user.role === 'admin') {
    const t = req.query.tenant_id || req.body.tenant_id;
    return t || null;
  }
  return req.user.tenant_id;
}

function scopedTenantId(req) {
  const tid = effectiveTenantId(req);
  if (!tid) return null;
  if (req.user.role === 'admin') return tid;
  return tid === req.user.tenant_id ? tid : null;
}

// ---------------------------------------------------------------------------
// API pública — chamada pelos workflows n8n (API key do cliente)
// ---------------------------------------------------------------------------

async function requireTenant(req, res, next) {
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const tenant = key ? await db.getTenantByApiKey(key) : null;
  if (!tenant) {
    return res.status(401).json({ error: 'API key inválida ou ausente. Envie "Authorization: Bearer <crm_api_key>".' });
  }
  req.tenant = tenant;
  next();
}

app.post('/api/leads', requireTenant, async (req, res) => {
  const body = req.body || {};
  const tenant = req.tenant;
  const fallbackPhone = body.telefone ? 'wa_' + String(body.telefone).replace(/[^0-9]/g, '') : null;
  const leadId = String(body.lead_id || fallbackPhone || newId('lead'));
  const existing = await db.getLead(tenant.id, leadId);

  const base = existing || {
    id: newId('lead'),
    lead_id: leadId,
    nome: '', email: '', telefone: '', empresa: '', origem: '',
    mensagem: '', classificacao: '', score: 0, motivo: '', proxima_acao: '',
    status: 'novo', negocio: tenant.negocio_nome,
    recebido_em: new Date().toISOString(),
    timeline: [],
  };

  const camposLead = ['nome', 'email', 'telefone', 'empresa', 'origem', 'mensagem',
    'classificacao', 'score', 'motivo', 'proxima_acao', 'status', 'negocio'];
  for (const campo of camposLead) {
    if (body[campo] !== undefined) base[campo] = body[campo];
  }

  if (body.evento) {
    base.timeline.push({
      evento: body.evento,
      classificacao: body.classificacao,
      em: body.enviado_em || new Date().toISOString(),
    });
  }

  const saved = await db.upsertLead(tenant.id, {
    ...base,
    recebido_em: base.recebido_em || new Date().toISOString(),
    timeline: base.timeline,
  });
  res.json({ ok: true, lead: saved });
});

app.get('/api/leads', requireTenant, async (req, res) => {
  const all = await db.listLeads(req.tenant.id);
  const dias = Number(req.query.dias || 0);
  const status = req.query.status;

  const daysBetween = (iso) => {
    if (!iso) return 999999;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return 999999;
    return (Date.now() - then) / (1000 * 60 * 60 * 24);
  };

  let list = all;
  if (status === 'sem_resposta') {
    list = list.filter((l) => !['respondido', 'convertido', 'followup_enviado'].includes(l.status)
      && daysBetween(l.recebido_em) >= dias);
  } else if (status) {
    list = list.filter((l) => l.status === status);
  }
  list = list.sort((a, b) => new Date(a.recebido_em) - new Date(b.recebido_em));

  res.json({
    leads: list.map((l) => ({
      id: l.lead_id, lead_id: l.lead_id, nome: l.nome, email: l.email,
      telefone: l.telefone, empresa: l.empresa, origem: l.origem,
      mensagem: l.mensagem, ultimo_contato_em: l.updated_at || l.recebido_em,
      contexto: l.motivo || '',
    })),
  });
});

app.post('/api/leads/update', requireTenant, async (req, res) => {
  const body = req.body || {};
  const leadId = String(body.lead_id || '');
  const lead = await db.getLead(req.tenant.id, leadId);
  if (!lead) return res.status(404).json({ error: `lead_id ${leadId} não encontrado` });

  const fields = {};
  if (body.status !== undefined) fields.status = body.status;
  fields.timeline = [{
    evento: 'followup_esfriado_enviado',
    assunto: body.assunto || '',
    em: body.followup_enviado_em || new Date().toISOString(),
  }];
  const saved = await db.updateLeadFields(req.tenant.id, leadId, fields);
  res.json({ ok: true, lead: saved });
});

// ---------------------------------------------------------------------------
// WhatsApp (Evolution API) — canal de entrada
// ---------------------------------------------------------------------------

function waPhoneFromJid(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].replace(/[^0-9]/g, '');
}

// Normaliza um item do webhook da Evolution API (v2) para o modelo de lead.
// Estrutura recebida: [ { body: { data: { Info, Message }, event, instanceToken, ... } } ]
function parseEvolutionMessage(item) {
  const body = (item && item.body) || {};
  const data = body.data || {};
  const info = data.Info || {};

  const event = body.event || '';
  if (!['Message', 'Messages.Upsert'].includes(event)) return null;
  if (info.IsFromMe || data.IsFromMe) return null;
  if (info.IsGroup || data.IsGroup) return null;

  const phone = waPhoneFromJid(info.Chat || info.Sender);
  if (!phone) return null;

  const msg = data.Message || {};
  const mediaType = info.MediaType || '';
  const timestamp = info.Timestamp || new Date().toISOString();

  let tipo = 'texto';
  let texto = '';
  let url = null;
  let mimetype = null;

  if (typeof msg.conversation === 'string') {
    texto = msg.conversation;
  } else if (msg.audioMessage) {
    tipo = 'audio';
    mimetype = msg.audioMessage.mimetype || null;
    url = msg.audioMessage.URL || null;
    const secs = msg.audioMessage.seconds ? `${msg.audioMessage.seconds}s` : '';
    texto = `[áudio${secs ? ' ' + secs : ''}]`;
  } else if (msg.imageMessage) {
    tipo = 'imagem';
    mimetype = msg.imageMessage.mimetype || null;
    url = msg.imageMessage.URL || null;
    texto = '[imagem]';
  } else if (msg.videoMessage) {
    tipo = 'video';
    mimetype = msg.videoMessage.mimetype || null;
    url = msg.videoMessage.URL || null;
    texto = '[vídeo]';
  } else if (msg.documentMessage) {
    tipo = 'documento';
    mimetype = msg.documentMessage.mimetype || null;
    url = msg.documentMessage.URL || null;
    const nome = msg.documentMessage.fileName || '';
    texto = `[documento${nome ? ': ' + nome : ''}]`;
  } else if (msg.stickerMessage) {
    tipo = 'figurinha';
    url = msg.stickerMessage.URL || null;
    texto = '[figurinha]';
  } else {
    tipo = mediaType || 'desconhecido';
    texto = `[${tipo}]`;
  }

  return {
    event,
    mid: info.ID || null,
    phone,
    nome: info.PushName || '',
    timestamp,
    tipo,
    texto,
    url,
    mimetype,
  };
}

app.post(EVOLUTION_WEBHOOK_PATH, async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  for (const item of items) {
    const body = (item && item.body) || {};
    const instToken = body.instanceToken || '';
    if (!instToken) continue;
    const inst = await db.getWhatsappInstanceByToken(instToken);
    if (!inst) continue;

    const parsed = parseEvolutionMessage(item);
    if (!parsed) continue;

    const tenantId = inst.tenant_id;
    const leadId = 'wa_' + parsed.phone;
    const existing = await db.getLead(tenantId, leadId);

    if (existing && (existing.timeline || []).some((t) => t.mid === parsed.mid)) continue;

    const evento = {
      evento: 'mensagem_recebida',
      tipo: parsed.tipo,
      texto: parsed.texto,
      mid: parsed.mid,
      ...(parsed.url ? { url: parsed.url } : {}),
      em: parsed.timestamp,
    };

    let lead;
    if (existing) {
      existing.nome = parsed.nome || existing.nome;
      existing.telefone = parsed.phone;
      existing.origem = 'whatsapp';
      existing.mensagem = parsed.texto;
      lead = { ...existing, timeline: [evento] };
    } else {
      const tenant = await db.getTenantById(tenantId);
      lead = {
        id: newId('lead'),
        lead_id: leadId,
        nome: parsed.nome,
        email: '', telefone: parsed.phone, empresa: '', origem: 'whatsapp',
        mensagem: parsed.texto, classificacao: '', score: 0, motivo: '', proxima_acao: '',
        status: 'novo', negocio: tenant ? tenant.negocio_nome : '',
        recebido_em: new Date().toISOString(),
        timeline: [evento],
      };
    }
    // upsertLead concatena a timeline existente no banco com lead.timeline,
    // então aqui só passamos o novo evento.
    await db.upsertLead(tenantId, lead);

    if (inst.forward_url) {
      fetch(inst.forward_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      }).catch(() => { /* fire-and-forget */ });
    }
  }
  res.json({ ok: true });
});

app.post('/api/agenda/events', requireTenant, async (req, res) => {
  const body = req.body || {};
  const entry = {
    id: newId('evt'),
    event_id: body.event_id || null,
    acao: body.acao || null,
    status: body.status || null,
    em: body.em || new Date().toISOString(),
  };
  const saved = await db.addAgendaEvent(req.tenant.id, entry);
  res.json({ ok: true, evento: saved });
});

app.post('/api/tickets', requireTenant, async (req, res) => {
  const body = req.body || {};
  const entry = {
    id: newId('tkt'),
    message_id: body.message_id || null,
    de: body.de || '',
    assunto: body.assunto || '',
    setor: body.setor || 'geral',
    prioridade: body.prioridade || 'normal',
    resumo: body.resumo || '',
    data: body.data || new Date().toISOString(),
    negocio: body.negocio || req.tenant.negocio_nome,
    log_em: body.log_em || new Date().toISOString(),
  };
  const saved = await db.addTicket(req.tenant.id, entry);
  res.json({ ok: true, ticket: saved });
});

app.get('/api/metrics/weekly', requireTenant, async (req, res) => {
  const tenant = req.tenant;
  const from = req.query.from;
  const to = req.query.to;
  const leads = await db.listLeads(tenant.id);
  const agenda = await db.listAgenda(tenant.id);
  const tickets = await db.listTickets(tenant.id);
  const override = await db.getOverride(tenant.id, from || '', to || '');
  const m = computeMetrics(tenant, leads, agenda, tickets, from, to, override);
  res.json(m);
});

function computeMetrics(tenant, leads, agenda, tickets, from, to, override) {
  const fromDate = from ? new Date(from) : new Date(Date.now() - 7 * 86400000);
  const toDate = to ? new Date(to + 'T23:59:59') : new Date();
  const inRange = (iso) => {
    const d = new Date(iso);
    return !Number.isNaN(d.getTime()) && d >= fromDate && d <= toDate;
  };

  const inRangeLeads = leads.filter((l) => inRange(l.recebido_em));
  const inRangeAgenda = agenda.filter((e) => inRange(e.em));
  const inRangeTickets = tickets.filter((t) => inRange(t.log_em));

  const leads_quentes = inRangeLeads.filter((l) => l.classificacao === 'quente').length;
  const leads_mornos = inRangeLeads.filter((l) => l.classificacao === 'morno').length;
  const leads_frios = inRangeLeads.filter((l) => l.classificacao === 'frio').length;
  const followups_enviados = inRangeLeads.filter((l) => (l.timeline || []).some((t) =>
    ['followup_48h_enviado', 'followup_esfriado_enviado'].includes(t.evento))).length;
  const respostas = inRangeLeads.filter((l) => ['respondido', 'convertido'].includes(l.status)).length;

  const eventIds = new Set(inRangeAgenda.map((e) => e.event_id).filter(Boolean));
  const agendamentos = eventIds.size || inRangeAgenda.length;
  const confirmados = inRangeAgenda.filter((e) => /confirma/i.test(e.acao || e.status || '')).length;

  const valorConsulta = Number(tenant.valor_consulta || 0);
  const receita_estimada = Number((confirmados * valorConsulta).toFixed(2));
  const faltas = inRangeAgenda.filter((e) => /falta|no.?show|cancel/i.test(e.acao || e.status || '')).length;
  let faltas_final = faltas;
  let receita_final = receita_estimada;
  if (override) {
    if (override.faltas !== null) faltas_final = override.faltas;
    if (override.receita_estimada !== null) receita_final = Number(override.receita_estimada);
  }
  const faltas_percentual = agendamentos > 0 ? Number(((faltas_final / agendamentos) * 100).toFixed(1)) : 0;

  return {
    leads_entrantes: inRangeLeads.length,
    leads_quentes,
    leads_mornos,
    leads_frios,
    followups_enviados,
    respostas,
    agendamentos,
    confirmados,
    faltas: faltas_final,
    faltas_percentual,
    emails_triagem: inRangeTickets.length,
    receita_estimada: receita_final,
    ticket_medio: valorConsulta,
    observacoes: inRangeLeads.length === 0 && inRangeAgenda.length === 0 && inRangeTickets.length === 0
      ? 'Sem dados no período — nenhum evento registrado ainda pelos workflows.'
      : '',
  };
}

// ---------------------------------------------------------------------------
// Autenticação do painel (login, sessão, usuários)
// ---------------------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha.' });
  const user = await db.getUserByUsername(String(username).toLowerCase());
  if (!user) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });

  const token = newToken();
  await db.createSession({ id: token, user_id: user.id, expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() });

  const tenant = user.tenant_id ? await db.getTenantById(user.tenant_id) : null;
  res.json({
    ok: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      tenant_id: user.tenant_id || null,
      tenant_nome: tenant ? tenant.negocio_nome : null,
    },
  });
});

app.post('/api/auth/logout', requireSession, async (req, res) => {
  await db.deleteSession(req.token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireSession, async (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      tenant_id: req.user.tenant_id || null,
      tenant_nome: req.user.negocio_nome || null,
    },
  });
});

// Usuários (somente admin)
app.get('/admin/api/users', requireSession, requireAdmin, async (req, res) => {
  res.json({ users: await db.listUsers() });
});

app.post('/admin/api/users', requireSession, requireAdmin, async (req, res) => {
  const { username, password, tenant_id, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha.' });
  const userRole = role === 'admin' ? 'admin' : 'client';
  if (userRole === 'client' && !tenant_id) {
    return res.status(400).json({ error: 'Para um usuário cliente é obrigatório informar o tenant.' });
  }
  const exists = await db.getUserByUsername(String(username).toLowerCase());
  if (exists) return res.status(409).json({ error: 'Já existe um usuário com esse nome.' });

  const hash = await bcrypt.hash(password, 10);
  const user = await db.createUser({
    id: newId('usr'),
    tenant_id: userRole === 'client' ? tenant_id : null,
    username: String(username).toLowerCase(),
    password_hash: hash,
    role: userRole,
  });
  res.json({ ok: true, user });
});

app.post('/admin/api/users/:id/password', requireSession, requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Informe a nova senha.' });
  const hash = await bcrypt.hash(password, 10);
  await db.updateUserPassword(req.params.id, hash);
  await db.deleteUserSessions(req.params.id);
  res.json({ ok: true });
});

app.delete('/admin/api/users/:id', requireSession, requireAdmin, async (req, res) => {
  await db.deleteUserSessions(req.params.id);
  await db.deleteUser(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Dados por tenant (admin e cliente, sempre escopado)
// ---------------------------------------------------------------------------

app.get('/api/tenant/data', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  const tenant = await db.getTenantById(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado.' });

  const [leads, agenda, tickets] = await Promise.all([
    db.listLeads(tenantId),
    db.listAgenda(tenantId),
    db.listTickets(tenantId),
  ]);

  const leadsSorted = [...leads].sort((a, b) => new Date(b.recebido_em) - new Date(a.recebido_em));
  const agendaSorted = [...agenda].sort((a, b) => new Date(b.em) - new Date(a.em));
  const ticketsSorted = [...tickets].sort((a, b) => new Date(b.log_em) - new Date(a.log_em));

  res.json({ tenant, leads: leadsSorted, agenda: agendaSorted, tickets: ticketsSorted });
});

app.get('/api/tenant/metrics', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  const tenant = await db.getTenantById(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado.' });

  const from = req.query.from;
  const to = req.query.to;
  const [leads, agenda, tickets] = await Promise.all([
    db.listLeads(tenantId),
    db.listAgenda(tenantId),
    db.listTickets(tenantId),
  ]);
  const override = await db.getOverride(tenantId, from || '', to || '');
  const m = computeMetrics(tenant, leads, agenda, tickets, from, to, override);
  res.json(m);
});

app.post('/api/tenant/metrics/override', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  const { from, to, faltas, receita_estimada } = req.body || {};
  if (req.user.role === 'client') {
    return res.status(403).json({ error: 'Ajuste manual de métricas é exclusivo do administrador.' });
  }
  await db.setOverride(tenantId, from || '', to || '', faltas, receita_estimada);
  res.json({ ok: true });
});

// Gestão de tenants (somente admin)
app.get('/admin/api/tenants', requireSession, requireAdmin, async (req, res) => {
  res.json({ tenants: await db.listTenants() });
});

app.post('/admin/api/tenants', requireSession, requireAdmin, async (req, res) => {
  const { negocio_nome, valor_consulta } = req.body || {};
  if (!negocio_nome) return res.status(400).json({ error: 'negocio_nome é obrigatório' });
  const tenant = await db.createTenant({
    id: newId('tenant'),
    negocio_nome,
    valor_consulta: Number(valor_consulta || 0),
    api_key: crypto.randomBytes(20).toString('hex'),
  });
  res.json({ ok: true, tenant });
});

app.patch('/admin/api/tenants/:id', requireSession, requireAdmin, async (req, res) => {
  const tenant = await db.updateTenant(req.params.id, {
    negocio_nome: req.body.negocio_nome,
    valor_consulta: req.body.valor_consulta,
  });
  if (!tenant) return res.status(404).json({ error: 'Tenant não encontrado.' });
  res.json({ ok: true, tenant });
});

app.delete('/admin/api/tenants/:id', requireSession, requireAdmin, async (req, res) => {
  await db.deleteTenant(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WhatsApp — configuração e gerenciamento de instância (Evolution API)
// Escopo: admin age em qualquer tenant (?tenant_id); cliente apenas no dele.
// ---------------------------------------------------------------------------

app.get('/api/whatsapp/status', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  const inst = await db.getWhatsappInstanceByTenant(tenantId);
  let live = null;
  if (inst && inst.instance_token && inst.instance_name && evolutionConfigured()) {
    try {
      live = await callEvolution('GET', `/instance/status/${inst.instance_name}`, { token: inst.instance_token });
      if (live && live.instance) {
        await db.setWhatsappConnected(tenantId, live.instance.status === 'open', live.instance.ownerJid || null);
      }
    } catch (e) { live = { error: e.message }; }
  }
  const current = await db.getWhatsappInstanceByTenant(tenantId);
  res.json({ configured: evolutionConfigured(), webhook_url: evolutionWebhookUrl(), instance: current, live });
});

app.put('/api/whatsapp', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  const body = req.body || {};
  const saved = await db.upsertWhatsappInstance({
    tenantId,
    instanceName: body.instance_name || null,
    instanceToken: body.instance_token || null,
    instanceId: body.instance_id || null,
    forwardUrl: body.forward_url || null,
  });
  res.json({ ok: true, instance: saved });
});

// Cria a instância na Evolution e salva o token no tenant
app.post('/api/whatsapp/instance', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  if (!evolutionConfigured()) {
    return res.status(500).json({ error: 'Evolution API não configurada no servidor. Preencha EVOLUTION_BASE_URL e EVOLUTION_GLOBAL_API_KEY no .env.' });
  }
  const body = req.body || {};
  const instanceName = (body.instance_name || 'wa_' + tenantId.replace(/[^a-z0-9]/gi, '').slice(0, 24)).toLowerCase();
  const instanceToken = body.instance_token || crypto.randomBytes(16).toString('hex');

  const result = await callEvolution('POST', '/instance/create', {
    body: { instanceId: instanceName, name: instanceName, token: instanceToken },
  });

  const instanceId = (result && (result.instance?.instanceName || result.hash?.instanceName)) || instanceName;
  await db.upsertWhatsappInstance({ tenantId, instanceName, instanceToken, instanceId, forwardUrl: body.forward_url || null });
  res.json({ ok: true, instance: await db.getWhatsappInstanceByTenant(tenantId), evolution: result });
});

// Conecta a instância e aponta o webhook para o CRM
app.post('/api/whatsapp/connect', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  const inst = await db.getWhatsappInstanceByTenant(tenantId);
  if (!inst || !inst.instance_token || !inst.instance_name) {
    return res.status(400).json({ error: 'Instância ainda não criada. Crie antes de conectar.' });
  }
  const result = await callEvolution('POST', `/instance/connect/${inst.instance_name}`, {
    token: inst.instance_token,
    body: { subscribe: ['ALL'], webhookUrl: evolutionWebhookUrl() },
  });
  res.json({ ok: true, result });
});

app.get('/api/whatsapp/qr', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  const inst = await db.getWhatsappInstanceByTenant(tenantId);
  if (!inst || !inst.instance_token || !inst.instance_name) {
    return res.status(400).json({ error: 'Instância ainda não criada.' });
  }
  const result = await callEvolution('GET', `/instance/qr/${inst.instance_name}`, { token: inst.instance_token });
  res.json(result);
});

app.post('/api/whatsapp/logout', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  const inst = await db.getWhatsappInstanceByTenant(tenantId);
  if (!inst || !inst.instance_token || !inst.instance_name) {
    return res.status(400).json({ error: 'Instância ainda não criada.' });
  }
  await callEvolution('DELETE', `/instance/logout/${inst.instance_name}`, { token: inst.instance_token });
  await db.setWhatsappConnected(tenantId, false, null);
  res.json({ ok: true });
});

app.delete('/api/whatsapp/instance', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  const inst = await db.getWhatsappInstanceByTenant(tenantId);
  if (inst && inst.instance_name && evolutionConfigured()) {
    try {
      await callEvolution('DELETE', `/instance/delete/${inst.instance_name}`, { token: EVOLUTION_GLOBAL_API_KEY });
    } catch (e) { /* segue mesmo se a instância já não existir */ }
  }
  await db.deleteWhatsappInstance(tenantId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Google Calendar — OAuth2 por cliente
// ---------------------------------------------------------------------------

// Retorna a URL de autorização (o cliente redireciona o navegador para lá)
app.post('/api/google/oauth/start', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  if (!oauthConfigured()) {
    return res.status(500).json({ error: 'Google Calendar não configurado no servidor. Peça ao administrador para preencher GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env.' });
  }
  const oauth = googleOAuthClient();
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state: JSON.stringify({ tenantId, token: req.token }),
    include_granted_scopes: true,
  });
  res.json({ ok: true, url });
});

app.get('/api/google/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    let tenantId = null;
    let token = null;
    if (state) {
      try {
        const parsed = JSON.parse(state);
        tenantId = parsed.tenantId;
        token = parsed.token;
      } catch (e) { /* ignore */ }
    }
    if (!tenantId) {
      return res.send('<html><body><h3>Erro: sessão de conexão do Google inválida. Feche e tente novamente pelo painel.</h3></body></html>');
    }
    void token;

    const oauth = googleOAuthClient();
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);

    const oauth2 = google.oauth2({ auth: oauth, version: 'v2' });
    const { data: profile } = await oauth2.userinfo.get().catch(() => ({ data: {} }));

    const account = {
      google_email: profile.email || 'conta vinculada',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : new Date().toISOString(),
      scope: Array.isArray(tokens.scope) ? tokens.scope.join(' ') : (tokens.scope || ''),
    };
    await db.saveGoogleAccount(tenantId, account);

    const cal = google.calendar({ version: 'v3', auth: oauth });
    const { data: listRes } = await cal.calendarList.list();
    const calendars = (listRes.items || []).map((c) => ({
      id: newId('gcal'),
      calendar_id: c.id,
      summary: c.summary || c.id,
      selected: false,
    }));
    await db.replaceCalendars(tenantId, calendars);

    res.redirect('/#/google-connected?tenant=' + encodeURIComponent(tenantId));
  } catch (e) {
    console.error('[google] Falha no callback:', e.message);
    res.send(`<html><body><h3>Falha ao conectar o Google: ${e.message}</h3></body></html>`);
  }
});

app.get('/api/google/status', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  const account = await db.getGoogleAccount(tenantId);
  const calendars = await db.listCalendars(tenantId);
  res.json({
    configured: oauthConfigured(),
    connected: Boolean(account && account.refresh_token),
    google_email: account ? account.google_email : null,
    connected_at: account ? account.connected_at : null,
    calendars,
  });
});

app.post('/api/google/disconnect', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  await db.disconnectGoogle(tenantId);
  res.json({ ok: true });
});

app.post('/api/google/calendars/:calendarId/select', requireSession, requireClientScope, async (req, res) => {
  const tenantId = scopedTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'Tenant não informado ou sem acesso.' });
  await db.setCalendarSelected(tenantId, req.params.calendarId, Boolean(req.body.selected));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Health & import legado
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/admin/api/import-legacy', requireSession, requireAdmin, async (req, res) => {
  const jsonPath = req.body.path || require('path').join(__dirname, 'data', 'db.json');
  try {
    const result = await db.importLegacyJson(jsonPath);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

async function start() {
  await db.init();
  console.log('[db] PostgreSQL conectado e schema pronto.');

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.warn('[auth] Aviso: ADMIN_PASSWORD não definido no .env. Crie o usuário admin com uma senha forte.');
  } else {
    const existing = await db.getUserByUsername('admin');
    if (!existing) {
      const hash = await bcrypt.hash(adminPassword, 10);
      await db.createUser({
        id: newId('usr'),
        tenant_id: null,
        username: 'admin',
        password_hash: hash,
        role: 'admin',
      });
      console.log('[auth] Usuário admin criado (senha vinda de ADMIN_PASSWORD).');
    }
  }

  const legacyPath = process.env.DB_PATH || require('path').join(__dirname, 'data', 'db.json');
  const fs = require('fs');
  if (fs.existsSync(legacyPath) && process.env.IMPORT_LEGACY !== 'false') {
    try {
      const result = await db.importLegacyJson(legacyPath);
      if (result.imported) {
        console.log(`[db] Importados ${result.imported} tenants do arquivo JSON legado.`);
      }
    } catch (e) {
      console.error('[db] Falha ao importar JSON legado (pode ignorar):', e.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`Mini-CRM rodando em http://localhost:${PORT}`);
    console.log(`Dashboard em http://localhost:${PORT}/`);
  });
}

start().catch((e) => {
  console.error('Falha ao iniciar:', e);
  process.exit(1);
});