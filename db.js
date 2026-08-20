// db.js
// Camada de dados sobre PostgreSQL (pacote "pg").
// Responsável por: pool de conexões, criação de schema (migrations),
// CRUD dos domínios do mini-CRM e criptografia dos tokens do Google.

const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL
  || `postgres://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || ''}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || 5432}/${process.env.POSTGRES_DB || 'mini_crm'}`;

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

const ENCRYPTION_KEY = (process.env.ENCRYPTION_KEY || 'mini-crm-default-key-00000000000000').slice(0, 32);

// ---------------------------------------------------------------------------
// Criptografia simétrica (AES-256-GCM) para tokens do Google Calendar
// ---------------------------------------------------------------------------

function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(payload) {
  if (!payload) return null;
  try {
    const [ivHex, tagHex, dataHex] = payload.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'utf8'), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[db] Falha ao descriptografar payload:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Migrations (criação do schema)
// ---------------------------------------------------------------------------

const MIGRATIONS = [
  // tenants: negócios/clientes + API key usada pelos workflows n8n
  `CREATE TABLE IF NOT EXISTS tenants (
     id TEXT PRIMARY KEY,
     negocio_nome TEXT NOT NULL,
     valor_consulta NUMERIC DEFAULT 0,
     api_key TEXT NOT NULL UNIQUE,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,

  // users: logins do painel (role 'admin' ou 'client')
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
     username TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('admin', 'client')),
     created_at TIMESTAMPTZ DEFAULT now()
   )`,

  // sessions: tokens de sessão do painel
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ DEFAULT now(),
     expires_at TIMESTAMPTZ NOT NULL
   )`,

  // leads: leads + timeline (jsonb) por tenant
  `CREATE TABLE IF NOT EXISTS leads (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     lead_id TEXT,
     nome TEXT DEFAULT '',
     email TEXT DEFAULT '',
     telefone TEXT DEFAULT '',
     empresa TEXT DEFAULT '',
     origem TEXT DEFAULT '',
     mensagem TEXT DEFAULT '',
     classificacao TEXT DEFAULT '',
     score NUMERIC DEFAULT 0,
     motivo TEXT DEFAULT '',
     proxima_acao TEXT DEFAULT '',
     status TEXT DEFAULT 'novo',
     negocio TEXT DEFAULT '',
     recebido_em TIMESTAMPTZ DEFAULT now(),
     updated_at TIMESTAMPTZ DEFAULT now(),
     timeline JSONB DEFAULT '[]',
     UNIQUE (tenant_id, lead_id)
   )`,

  // agenda_events: respostas de confirmação/remarcação da agenda
  `CREATE TABLE IF NOT EXISTS agenda_events (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     event_id TEXT,
     acao TEXT,
     status TEXT,
     em TIMESTAMPTZ DEFAULT now()
   )`,

  // tickets: atendimentos triados pelo workflow 04
  `CREATE TABLE IF NOT EXISTS tickets (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     message_id TEXT,
     de TEXT DEFAULT '',
     assunto TEXT DEFAULT '',
     setor TEXT DEFAULT 'geral',
     prioridade TEXT DEFAULT 'normal',
     resumo TEXT DEFAULT '',
     data TIMESTAMPTZ DEFAULT now(),
     negocio TEXT DEFAULT '',
     log_em TIMESTAMPTZ DEFAULT now()
   )`,

  // metrics_overrides: ajustes manuais de faltas/receita por período
  `CREATE TABLE IF NOT EXISTS metrics_overrides (
     id SERIAL PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     period_from TEXT,
     period_to TEXT,
     faltas INTEGER,
     receita_estimada NUMERIC,
     UNIQUE (tenant_id, period_from, period_to)
   )`,

  // google_accounts: tokens OAuth2 do Google Calendar por tenant (criptografados)
  `CREATE TABLE IF NOT EXISTS google_accounts (
     tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
     google_email TEXT,
     access_token_enc TEXT,
     refresh_token_enc TEXT,
     token_expiry TIMESTAMPTZ,
     scope TEXT,
     connected_at TIMESTAMPTZ DEFAULT now(),
     updated_at TIMESTAMPTZ DEFAULT now()
   )`,

  // google_calendars: agendas do Google do tenant + seleção das usadas nos workflows
  `CREATE TABLE IF NOT EXISTS google_calendars (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     calendar_id TEXT NOT NULL,
     summary TEXT,
     selected BOOLEAN DEFAULT false,
     created_at TIMESTAMPTZ DEFAULT now(),
     UNIQUE (tenant_id, calendar_id)
   )`,

  // Índices para consultas por tenant
  `CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agenda_tenant ON agenda_events(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_tenant ON tickets(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
];

async function init() {
  for (const sql of MIGRATIONS) {
    await pool.query(sql);
  }
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

async function listTenants() {
  const { rows } = await pool.query('SELECT id, negocio_nome, valor_consulta, api_key, created_at FROM tenants ORDER BY created_at ASC');
  return rows;
}

async function getTenantByApiKey(apiKey) {
  const { rows } = await pool.query('SELECT id, negocio_nome, valor_consulta, api_key, created_at FROM tenants WHERE api_key = $1', [apiKey]);
  return rows[0] || null;
}

async function getTenantById(id) {
  const { rows } = await pool.query('SELECT id, negocio_nome, valor_consulta, api_key, created_at FROM tenants WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createTenant({ id, negocio_nome, valor_consulta, api_key }) {
  const { rows } = await pool.query(
    `INSERT INTO tenants (id, negocio_nome, valor_consulta, api_key)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, negocio_nome, valor_consulta, api_key]
  );
  return rows[0];
}

async function updateTenant(id, fields) {
  const set = [];
  const values = [];
  let i = 1;
  for (const key of ['negocio_nome', 'valor_consulta']) {
    if (fields[key] !== undefined) {
      set.push(`${key} = $${i++}`);
      values.push(fields[key]);
    }
  }
  if (!set.length) return getTenantById(id);
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE tenants SET ${set.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function deleteTenant(id) {
  await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------------
// Users / sessões
// ---------------------------------------------------------------------------

async function getUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createUser({ id, tenant_id, username, password_hash, role }) {
  const { rows } = await pool.query(
    `INSERT INTO users (id, tenant_id, username, password_hash, role)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [id, tenant_id, username, password_hash, role]
  );
  return rows[0];
}

async function listUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.tenant_id, u.created_at,
            t.negocio_nome AS tenant_nome
     FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
     ORDER BY u.created_at ASC`
  );
  return rows;
}

async function updateUserPassword(userId, passwordHash) {
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

async function createSession({ id, user_id, expires_at }) {
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [id, user_id, expires_at]
  );
}

async function getSession(token) {
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.expires_at, u.username, u.role, u.tenant_id, u.tenant_id IS NOT NULL AS has_tenant,
            t.negocio_nome, t.api_key
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE s.id = $1`,
    [token]
  );
  const s = rows[0];
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    await pool.query('DELETE FROM sessions WHERE id = $1', [token]);
    return null;
  }
  return s;
}

async function deleteSession(token) {
  await pool.query('DELETE FROM sessions WHERE id = $1', [token]);
}

async function deleteUserSessions(userId) {
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

async function upsertLead(tenantId, lead) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT * FROM leads WHERE tenant_id = $1 AND lead_id = $2 FOR UPDATE',
      [tenantId, lead.lead_id]
    );
    const prevTimeline = existing.rows[0] ? (existing.rows[0].timeline || []) : [];
    const timeline = prevTimeline.concat(lead.timeline || []);

    const now = new Date().toISOString();
    const { rows } = await client.query(
      `INSERT INTO leads
         (id, tenant_id, lead_id, nome, email, telefone, empresa, origem, mensagem,
          classificacao, score, motivo, proxima_acao, status, negocio, recebido_em, updated_at, timeline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (tenant_id, lead_id) DO UPDATE SET
         nome = EXCLUDED.nome, email = EXCLUDED.email, telefone = EXCLUDED.telefone,
         empresa = EXCLUDED.empresa, origem = EXCLUDED.origem, mensagem = EXCLUDED.mensagem,
         classificacao = EXCLUDED.classificacao, score = EXCLUDED.score, motivo = EXCLUDED.motivo,
         proxima_acao = EXCLUDED.proxima_acao, status = EXCLUDED.status, negocio = EXCLUDED.negocio,
         updated_at = EXCLUDED.updated_at,
         timeline = $18
       RETURNING *`,
      [
        lead.id, tenantId, lead.lead_id, lead.nome || '', lead.email || '', lead.telefone || '',
        lead.empresa || '', lead.origem || '', lead.mensagem || '', lead.classificacao || '',
        lead.score || 0, lead.motivo || '', lead.proxima_acao || '', lead.status || 'novo',
        lead.negocio || '', lead.recebido_em || now, now, JSON.stringify(timeline),
      ]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listLeads(tenantId) {
  const { rows } = await pool.query(
    `SELECT * FROM leads WHERE tenant_id = $1 ORDER BY recebido_em ASC`,
    [tenantId]
  );
  return rows;
}

async function getLead(tenantId, leadId) {
  const { rows } = await pool.query(
    'SELECT * FROM leads WHERE tenant_id = $1 AND lead_id = $2',
    [tenantId, leadId]
  );
  return rows[0] || null;
}

async function updateLeadFields(tenantId, leadId, fields) {
  const set = ['updated_at = now()'];
  const values = [];
  let i = 1;
  const cols = ['status', 'classificacao', 'score', 'motivo', 'proxima_acao', 'nome', 'email', 'telefone', 'empresa', 'origem', 'mensagem', 'negocio'];
  for (const col of cols) {
    if (fields[col] !== undefined) {
      set.push(`${col} = $${i++}`);
      values.push(fields[col]);
    }
  }
  if (fields.timeline) {
    set.push(`timeline = timeline || $${i++}::jsonb`);
    values.push(JSON.stringify(fields.timeline));
  }
  values.push(tenantId, leadId);
  const { rows } = await pool.query(
    `UPDATE leads SET ${set.join(', ')} WHERE tenant_id = $${i} AND lead_id = $${i + 1} RETURNING *`,
    values
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Agenda / tickets / overrides
// ---------------------------------------------------------------------------

async function addAgendaEvent(tenantId, entry) {
  const { rows } = await pool.query(
    `INSERT INTO agenda_events (id, tenant_id, event_id, acao, status, em)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [entry.id, tenantId, entry.event_id, entry.acao, entry.status, entry.em]
  );
  return rows[0];
}

async function listAgenda(tenantId) {
  const { rows } = await pool.query(
    'SELECT * FROM agenda_events WHERE tenant_id = $1 ORDER BY em DESC',
    [tenantId]
  );
  return rows;
}

async function addTicket(tenantId, entry) {
  const { rows } = await pool.query(
    `INSERT INTO tickets (id, tenant_id, message_id, de, assunto, setor, prioridade, resumo, data, negocio, log_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [entry.id, tenantId, entry.message_id, entry.de, entry.assunto, entry.setor, entry.prioridade, entry.resumo, entry.data, entry.negocio, entry.log_em]
  );
  return rows[0];
}

async function listTickets(tenantId) {
  const { rows } = await pool.query(
    'SELECT * FROM tickets WHERE tenant_id = $1 ORDER BY log_em DESC',
    [tenantId]
  );
  return rows;
}

async function getOverride(tenantId, from, to) {
  const { rows } = await pool.query(
    'SELECT faltas, receita_estimada FROM metrics_overrides WHERE tenant_id = $1 AND period_from = $2 AND period_to = $3',
    [tenantId, from, to]
  );
  return rows[0] || null;
}

async function setOverride(tenantId, from, to, faltas, receita_estimada) {
  await pool.query(
    `INSERT INTO metrics_overrides (tenant_id, period_from, period_to, faltas, receita_estimada)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, period_from, period_to) DO UPDATE SET
       faltas = EXCLUDED.faltas, receita_estimada = EXCLUDED.receita_estimada`,
    [tenantId, from, to, faltas, receita_estimada]
  );
}

// ---------------------------------------------------------------------------
// Google Calendar (OAuth2) por tenant
// ---------------------------------------------------------------------------

async function saveGoogleAccount(tenantId, account) {
  const { rows } = await pool.query(
    `INSERT INTO google_accounts (tenant_id, google_email, access_token_enc, refresh_token_enc, token_expiry, scope, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       google_email = EXCLUDED.google_email,
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       token_expiry = EXCLUDED.token_expiry,
       scope = EXCLUDED.scope,
       updated_at = now()`,
    [tenantId, account.google_email, encrypt(account.access_token), encrypt(account.refresh_token), account.token_expiry, account.scope, new Date().toISOString()]
  );
  return rows[0];
}

async function getGoogleAccount(tenantId) {
  const { rows } = await pool.query(
    'SELECT * FROM google_accounts WHERE tenant_id = $1',
    [tenantId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    google_email: row.google_email,
    access_token: decrypt(row.access_token_enc),
    refresh_token: decrypt(row.refresh_token_enc),
    token_expiry: row.token_expiry,
    scope: row.scope,
    connected_at: row.connected_at,
    updated_at: row.updated_at,
  };
}

async function disconnectGoogle(tenantId) {
  await pool.query('DELETE FROM google_accounts WHERE tenant_id = $1', [tenantId]);
  await pool.query('DELETE FROM google_calendars WHERE tenant_id = $1', [tenantId]);
}

async function replaceCalendars(tenantId, calendars) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM google_calendars WHERE tenant_id = $1', [tenantId]);
    for (const c of calendars) {
      await client.query(
        `INSERT INTO google_calendars (id, tenant_id, calendar_id, summary, selected, created_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [c.id, tenantId, c.calendar_id, c.summary, c.selected || false]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listCalendars(tenantId) {
  const { rows } = await pool.query(
    'SELECT * FROM google_calendars WHERE tenant_id = $1 ORDER BY summary ASC',
    [tenantId]
  );
  return rows;
}

async function setCalendarSelected(tenantId, calendarId, selected) {
  await pool.query(
    'UPDATE google_calendars SET selected = $3 WHERE tenant_id = $1 AND calendar_id = $2',
    [tenantId, calendarId, selected]
  );
}

// ---------------------------------------------------------------------------
// Import de dados do db.json antigo (opcional)
// ---------------------------------------------------------------------------

async function importLegacyJson(jsonPath) {
  if (!fs.existsSync(jsonPath)) return { imported: false, reason: 'arquivo não existe' };
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  let imported = 0;
  for (const [apiKey, t] of Object.entries(data.tenants || {})) {
    const exists = await getTenantById(t.id);
    if (exists) continue;
    const tenant = await createTenant({ ...t, api_key: t.api_key || apiKey });
    imported++;
    for (const [leadId, lead] of Object.entries((data.leads || {})[t.id] || {})) {
      await upsertLead(t.id, { ...lead, id: `lead_${crypto.randomBytes(6).toString('hex')}`, lead_id: leadId });
    }
    for (const evt of (data.agenda || {})[t.id] || []) {
      await addAgendaEvent(t.id, evt);
    }
    for (const tkt of (data.tickets || {})[t.id] || []) {
      await addTicket(t.id, tkt);
    }
    for (const [key, ov] of Object.entries((data.overrides || {})[t.id] || {})) {
      const [from, to] = key.split('_');
      await setOverride(t.id, from, to, ov.faltas, ov.receita_estimada);
    }
  }
  return { imported, tenants: imported, reason: null };
}

module.exports = {
  pool,
  init,
  encrypt,
  decrypt,
  listTenants,
  getTenantByApiKey,
  getTenantById,
  createTenant,
  updateTenant,
  deleteTenant,
  getUserByUsername,
  getUserById,
  createUser,
  listUsers,
  updateUserPassword,
  deleteUser,
  createSession,
  getSession,
  deleteSession,
  deleteUserSessions,
  upsertLead,
  listLeads,
  getLead,
  updateLeadFields,
  addAgendaEvent,
  listAgenda,
  addTicket,
  listTickets,
  getOverride,
  setOverride,
  saveGoogleAccount,
  getGoogleAccount,
  disconnectGoogle,
  replaceCalendars,
  listCalendars,
  setCalendarSelected,
  importLegacyJson,
};