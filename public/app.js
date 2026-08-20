// app.js — lógica do painel (vanilla JS, sem build step)

let token = sessionStorage.getItem('token') || '';
let user = null;
let tenants = [];
let activeTenant = null;
let activeTab = 'metrics';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  children.forEach((c) => {
    if (c instanceof Node) node.appendChild(c);
    else if (c !== null && c !== undefined) node.appendChild(document.createTextNode(c));
  });
  return node;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : '',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    logout(true);
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erro ${res.status}`);
  }
  return res.json();
}

// ---------- Auth ----------
async function tryLogin(username, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('#loginError').textContent = body.error || 'Falha ao entrar.';
    return;
  }
  token = body.token;
  user = body.user;
  sessionStorage.setItem('token', token);
  sessionStorage.setItem('user', JSON.stringify(user));
  boot();
}

function logout(expired) {
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('user');
  token = '';
  user = null;
  $('#loginError').textContent = expired ? 'Sessão expirada. Entre novamente.' : '';
  $('#loginScreen').style.display = 'flex';
  $('#app').classList.remove('visible');
}

$('#loginBtn').addEventListener('click', () => tryLogin($('#loginUser').value.trim(), $('#loginPassword').value));
$('#loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin($('#loginUser').value.trim(), $('#loginPassword').value); });
$('#loginUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin($('#loginUser').value.trim(), $('#loginPassword').value); });
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  logout();
});

// ---------- Boot ----------
async function boot() {
  $('#loginScreen').style.display = 'none';
  $('#app').classList.add('visible');
  try {
    const me = await api('/api/auth/me');
    user = me.user;
    sessionStorage.setItem('user', JSON.stringify(user));
  } catch (e) { return; }
  $('#whoami').textContent = `${user.username} · ${user.role === 'admin' ? 'Administrador' : (user.tenant_nome || 'Cliente')}`;
  if (user.role === 'admin') {
    await loadTenants();
  } else {
    try {
      const d = await api('/api/tenant/data');
      activeTenant = d.tenant;
      tenants = [d.tenant];
    } catch (e) {}
  }
  renderNav();
  let googleConnected = false;
  let googleTenantId = null;
  if (location.hash.startsWith('#/google-connected')) {
    googleConnected = true;
    const qs = new URLSearchParams((location.hash.split('?')[1] || ''));
    googleTenantId = qs.get('tenant');
  }
  if (googleConnected) {
    location.hash = '';
    if (!activeTenant) {
      if (user.role === 'admin') {
        if (googleTenantId) activeTenant = tenants.find((t) => t.id === googleTenantId) || null;
        if (!activeTenant) {
          showView('tenants');
          return;
        }
      } else {
        showView('overview');
        return;
      }
    }
    showView('google', 'connected');
  } else {
    showView(user.role === 'admin' ? 'tenants' : 'overview');
  }
}

function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  if (user.role === 'admin') {
    nav.appendChild(el('div', { className: 'nav-item' + (activeView === 'tenants' ? ' active' : ''), textContent: 'Clientes', onclick: () => showView('tenants') }));
    nav.appendChild(el('div', { className: 'nav-item' + (activeView === 'users' ? ' active' : ''), textContent: 'Usuários', onclick: () => showView('users') }));
  } else {
    nav.appendChild(el('div', { className: 'nav-item' + (activeView === 'overview' ? ' active' : ''), textContent: 'Meu painel', onclick: () => showView('overview') }));
    nav.appendChild(el('div', { className: 'nav-item' + (activeView === 'google' ? ' active' : ''), textContent: 'Google Calendar', onclick: () => showView('google') }));
  }
}

let activeView = 'tenants';

// ---------- Admin: tenants ----------
async function loadTenants() {
  const r = await api('/admin/api/tenants');
  tenants = r.tenants;
}

function renderTenantsView() {
  activeView = 'tenants';
  renderNav();
  $('#pageTitle').textContent = 'Clientes';
  $('#pageSub').textContent = 'Cada cliente é um tenant isolado, com API key própria para os workflows n8n.';
  $('#pageActions').innerHTML = '';
  const addBtn = el('button', { className: 'primary', textContent: '+ Novo cliente', onclick: () => openTenantModal() });
  $('#pageActions').appendChild(addBtn);

  const content = $('#content');
  content.innerHTML = '';
  if (!tenants.length) {
    content.appendChild(el('div', { className: 'panel' }, [
      el('div', { className: 'empty-state', textContent: 'Nenhum cliente ainda. Clique em "+ Novo cliente" para começar.' }),
    ]));
    return;
  }

  const panel = el('div', { className: 'panel' });
  const table = buildTable(
    ['Cliente', 'API key (workflows)', 'Valor médio', 'Desde', ''],
    tenants.map((t) => {
      const rowActions = el('div', { className: 'row-actions' }, [
        el('button', { className: 'link-btn', textContent: 'Abrir', onclick: () => openTenant(t) }),
        el('button', { className: 'link-btn', textContent: 'Usuário', onclick: () => openUserModal(t) }),
        el('button', { className: 'link-btn danger', textContent: 'Excluir', onclick: () => deleteTenantFlow(t) }),
      ]);
      return [
        el('b', { textContent: t.negocio_nome }),
        el('span', { className: 'mono', textContent: t.api_key }),
        'R$ ' + Number(t.valor_consulta || 0).toLocaleString('pt-BR'),
        new Date(t.created_at).toLocaleDateString('pt-BR'),
        rowActions,
      ];
    })
  );
  panel.appendChild(table);
  content.appendChild(panel);
}

function openTenant(t) {
  activeTenant = t;
  activeTab = 'metrics';
  showView('tenant');
}

function deleteTenantFlow(t) {
  if (!confirm(`Excluir o cliente "${t.negocio_nome}"? Isso apaga leads, agenda, tickets e conexões Google. Essa ação não pode ser desfeita.`)) return;
  api(`/admin/api/tenants/${t.id}`, { method: 'DELETE' })
    .then(async () => { await loadTenants(); renderTenantsView(); })
    .catch((e) => alert(e.message));
}

function openTenantModal(editTenant) {
  $('#tenantModalTitle').textContent = editTenant ? 'Editar cliente' : 'Novo cliente';
  $('#tenantFormNome').value = editTenant ? editTenant.negocio_nome : '';
  $('#tenantFormValor').value = editTenant ? editTenant.valor_consulta : '';
  $('#tenantResult').innerHTML = '';
  $('#tenantModal').dataset.id = editTenant ? editTenant.id : '';
  $('#tenantModal').classList.add('visible');
  $('#tenantFormNome').focus();
}

$('#cancelTenant').addEventListener('click', () => $('#tenantModal').classList.remove('visible'));
$('#saveTenant').addEventListener('click', async () => {
  const id = $('#tenantModal').dataset.id;
  const negocio_nome = $('#tenantFormNome').value.trim();
  const valor_consulta = $('#tenantFormValor').value;
  if (!negocio_nome) return;
  try {
    const body = { negocio_nome, valor_consulta };
    if (id) {
      await api(`/admin/api/tenants/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      $('#tenantResult').innerHTML = '<div class="ok-msg">Cliente atualizado.</div>';
    } else {
      const { tenant } = await api('/admin/api/tenants', { method: 'POST', body: JSON.stringify(body) });
      $('#tenantResult').innerHTML = `<div class="apikey-box">API key criada — use em <code>crm_api_key</code> nos workflows n8n: <br/>${tenant.api_key}</div>`;
      const userBtn = el('button', { className: 'primary', style: 'width:100%;margin-top:10px', textContent: 'Criar login do cliente', onclick: () => { $('#tenantModal').classList.remove('visible'); openUserModal(tenant); } });
      $('#tenantResult').appendChild(userBtn);
    }
    await loadTenants();
  } catch (e) {
    $('#tenantResult').innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
});

// ---------- Admin: users ----------
async function renderUsersView() {
  activeView = 'users';
  renderNav();
  $('#pageTitle').textContent = 'Usuários';
  $('#pageSub').textContent = 'Crie logins para as empresas acessarem o próprio painel (visão restrita aos dados delas).';
  $('#pageActions').innerHTML = '';
  const addBtn = el('button', { className: 'primary', textContent: '+ Novo usuário', onclick: () => openUserModal() });
  $('#pageActions').appendChild(addBtn);

  const content = $('#content');
  content.innerHTML = '<div class="empty-state">Carregando…</div>';
  const r = await api('/admin/api/users');
  const users = r.users;

  content.innerHTML = '';
  const panel = el('div', { className: 'panel' });
  const table = buildTable(
    ['Usuário', 'Papel', 'Cliente', 'Criado em', ''],
    users.map((u) => {
      const rowActions = el('div', { className: 'row-actions' }, [
        el('button', { className: 'link-btn', textContent: 'Redefinir senha', onclick: () => resetPasswordFlow(u) }),
        u.username !== 'admin' ? el('button', { className: 'link-btn danger', textContent: 'Excluir', onclick: () => deleteUserFlow(u) }) : null,
      ]);
      return [
        u.username,
        u.role === 'admin' ? 'Administrador' : 'Cliente',
        u.tenant_nome || '—',
        new Date(u.created_at).toLocaleDateString('pt-BR'),
        rowActions,
      ];
    })
  );
  panel.appendChild(table);
  content.appendChild(panel);
}

function openUserModal(tenant) {
  $('#userModalTitle').textContent = 'Novo usuário';
  $('#userFormUsername').value = tenant ? defaultUsername(tenant.negocio_nome) : '';
  $('#userFormPassword').value = randomPassword();
  $('#userResult').innerHTML = '';
  $('#userModal').dataset.tenant = tenant ? tenant.id : '';
  $('#userModal').classList.add('visible');
  $('#userFormUsername').focus();
}

function defaultUsername(nome) {
  return nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30);
}

function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

$('#cancelUser').addEventListener('click', () => $('#userModal').classList.remove('visible'));
$('#saveUser').addEventListener('click', async () => {
  const username = $('#userFormUsername').value.trim();
  const password = $('#userFormPassword').value;
  const tenantId = $('#userModal').dataset.tenant;
  if (!username || !password) { $('#userResult').innerHTML = '<div class="error-msg">Informe usuário e senha.</div>'; return; }
  try {
    await api('/admin/api/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, tenant_id: tenantId || undefined, role: tenantId ? 'client' : 'admin' }),
    });
    $('#userModal').classList.remove('visible');
    renderUsersView();
  } catch (e) {
    $('#userResult').innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
});

function resetPasswordFlow(u) {
  const pass = prompt(`Nova senha para "${u.username}":`);
  if (!pass) return;
  api(`/admin/api/users/${u.id}/password`, { method: 'POST', body: JSON.stringify({ password: pass }) })
    .then(() => alert('Senha redefinida. As sessões antigas do usuário foram encerradas.'))
    .catch((e) => alert(e.message));
}

function deleteUserFlow(u) {
  if (!confirm(`Excluir o usuário "${u.username}"?`)) return;
  api(`/admin/api/users/${u.id}`, { method: 'DELETE' })
    .then(() => renderUsersView())
    .catch((e) => alert(e.message));
}

// ---------- Tenant detail (admin) / Overview (client) ----------
const TABS = [
  { id: 'metrics', label: 'Métricas' },
  { id: 'leads', label: 'Leads' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'tickets', label: 'Atendimento' },
  { id: 'config', label: 'Configurar workflows' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'google', label: 'Google Calendar' },
];

function showView(view, googleMsg) {
  if (view === 'tenants') return renderTenantsView();
  if (view === 'users') return renderUsersView();
  if (view === 'overview') {
    activeTenant = tenants.find((t) => t.id === user.tenant_id) || null;
    if (!activeTenant) {
      $('#pageTitle').textContent = 'Sem dados';
      $('#content').innerHTML = '<div class="panel"><div class="empty-state">Sua conta ainda não tem um cliente vinculado. Fale com o administrador.</div></div>';
      return;
    }
    activeTab = 'metrics';
    activeView = 'overview';
    renderNav();
    renderTenantShell(activeTenant, googleMsg);
    return;
  }
  if (view === 'tenant') {
    activeView = 'tenant';
    renderNav();
    renderTenantShell(activeTenant, googleMsg);
    return;
  }
  if (view === 'google') {
    if (user.role === 'admin') {
      if (!activeTenant) {
        $('#pageTitle').textContent = 'Sem dados';
        $('#content').innerHTML = '<div class="panel"><div class="empty-state">Selecione um cliente para configurar o Google Calendar.</div></div>';
        return;
      }
      activeTab = 'google';
      renderTenantShell(activeTenant, googleMsg);
      return;
    }
    activeTenant = tenants.find((t) => t.id === user.tenant_id) || null;
    if (!activeTenant) {
      $('#pageTitle').textContent = 'Sem dados';
      $('#content').innerHTML = '<div class="panel"><div class="empty-state">Sua conta ainda não tem um cliente vinculado.</div></div>';
      return;
    }
    activeTab = 'google';
    activeView = 'overview';
    renderNav();
    renderTenantShell(activeTenant, googleMsg);
    return;
  }
}

function tenantQuery(extra = '') {
  return user.role === 'admin' ? `?tenant_id=${encodeURIComponent(activeTenant.id)}${extra}` : (extra ? `?${extra.replace(/^\?/, '')}` : '');
}

function renderTenantShell(tenant, googleMsg) {
  $('#pageTitle').textContent = tenant.negocio_nome;
  $('#pageSub').textContent = `Cliente desde ${new Date(tenant.created_at).toLocaleDateString('pt-BR')}`;
  $('#pageActions').innerHTML = '';
  if (user.role === 'admin') {
    const editBtn = el('button', { className: 'ghost', textContent: 'Editar', onclick: () => openTenantModal(tenant) });
    const userBtn = el('button', { className: 'ghost', textContent: 'Criar login', onclick: () => openUserModal(tenant) });
    $('#pageActions').appendChild(editBtn, userBtn);
  }

  const content = $('#content');
  content.innerHTML = '';
  const tabBar = el('div', { className: 'tabs' });
  TABS.forEach((tab) => {
    if (user.role === 'client' && tab.id === 'config') return;
    const t = el('div', {
      className: 'tab' + (activeTab === tab.id ? ' active' : ''),
      textContent: tab.label,
      onclick: () => { activeTab = tab.id; renderTenantShell(tenant); },
    });
    tabBar.appendChild(t);
  });
  content.appendChild(tabBar);

  const body = el('div', { id: 'tabBody' });
  content.appendChild(body);

  if (activeTab === 'metrics') renderMetrics(body, tenant, googleMsg);
  else if (activeTab === 'leads') renderLeads(body, tenant);
  else if (activeTab === 'agenda') renderAgenda(body, tenant);
  else if (activeTab === 'tickets') renderTickets(body, tenant);
  else if (activeTab === 'config') renderConfig(body, tenant);
  else if (activeTab === 'whatsapp') renderWhatsApp(body, tenant);
  else if (activeTab === 'google') renderGoogle(body, tenant, googleMsg);
}

// ---------- Metrics ----------
async function renderMetrics(body, tenant, googleMsg) {
  body.innerHTML = '<div class="empty-state">Carregando…</div>';
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const params = new URLSearchParams();
  if (user.role === 'admin') params.set('tenant_id', tenant.id);
  params.set('from', from);
  params.set('to', to);
  const m = await api(`/api/tenant/metrics?${params}`);

  const cards = [
    ['Leads recebidos', m.leads_entrantes],
    ['Quentes', m.leads_quentes],
    ['Mornos', m.leads_mornos],
    ['Frios', m.leads_frios],
    ['Follow-ups enviados', m.followups_enviados],
    ['Respostas', m.respostas],
    ['Agendamentos', m.agendamentos],
    ['Confirmados', m.confirmados],
    ['Faltas', m.faltas],
    ['% Faltas', m.faltas_percentual + '%'],
    ['Tickets de atendimento', m.emails_triagem],
    ['Receita estimada', 'R$ ' + Number(m.receita_estimada).toLocaleString('pt-BR')],
  ];

  const grid = el('div', { className: 'metrics-grid' });
  cards.forEach(([label, value], i) => {
    grid.appendChild(el('div', { className: 'metric-card' + (i === cards.length - 1 ? ' accent' : '') }, [
      el('div', { className: 'value', textContent: String(value) }),
      el('div', { className: 'label', textContent: label }),
    ]));
  });

  body.innerHTML = '';
  body.appendChild(el('div', { className: 'setup-hint' }, [
    document.createTextNode(`Período: ${from} até ${to} · Mesmas métricas que o workflow "Relatório Semanal Automático" envia por e-mail.`),
  ]));
  body.appendChild(grid);

  if (m.observacoes) {
    body.appendChild(el('div', { className: 'setup-hint', textContent: m.observacoes }));
  }

  if (user.role === 'admin') {
    body.appendChild(el('button', { className: 'ghost', textContent: 'Ajustar métricas manualmente', onclick: () => openOverrideModal(tenant, from, to) }));
  }
}

function openOverrideModal(tenant, from, to) {
  $('#overrideFaltas').value = '';
  $('#overrideReceita').value = '';
  $('#overrideResult').innerHTML = '';
  $('#overrideModal').dataset.tenant = tenant.id;
  $('#overrideModal').dataset.from = from;
  $('#overrideModal').dataset.to = to;
  $('#overrideModal').classList.add('visible');
}
$('#cancelOverride').addEventListener('click', () => $('#overrideModal').classList.remove('visible'));
$('#saveOverride').addEventListener('click', async () => {
  const m = $('#overrideModal').dataset;
  try {
    await api('/api/tenant/metrics/override', {
      method: 'POST',
      body: JSON.stringify({
        tenant_id: m.tenant,
        from: m.from,
        to: m.to,
        faltas: $('#overrideFaltas').value === '' ? null : Number($('#overrideFaltas').value),
        receita_estimada: $('#overrideReceita').value === '' ? null : Number($('#overrideReceita').value),
      }),
    });
    $('#overrideModal').classList.remove('visible');
    renderTenantShell(activeTenant);
  } catch (e) {
    $('#overrideResult').innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
});

// ---------- Leads ----------
async function renderLeads(body, tenant) {
  body.innerHTML = '<div class="empty-state">Carregando…</div>';
  const { leads } = await api(`/api/tenant/data${tenantQuery()}`);
  if (!leads.length) {
    body.innerHTML = '<div class="panel"><div class="empty-state">Nenhum lead recebido ainda. Assim que o webhook do Qualificador de Leads receber um contato, ele aparece aqui.</div></div>';
    return;
  }
  const table = buildTable(
    ['Nome', 'Contato', 'Origem', 'Classificação', 'Score', 'Status', 'Recebido em'],
    leads.map((l) => [
      l.nome || '—',
      [l.email, l.telefone].filter(Boolean).join(' · ') || '—',
      l.origem ? '<span class="badge ' + (l.origem === 'whatsapp' ? 'quente' : 'default') + '">' + l.origem + '</span>' : '—',
      classBadge(l.classificacao),
      String(l.score ?? '—'),
      l.status || '—',
      new Date(l.recebido_em).toLocaleString('pt-BR'),
    ])
  );
  body.innerHTML = '';
  body.appendChild(table);
}

function classBadge(c) {
  const cls = ['quente', 'morno', 'frio'].includes(c) ? c : 'default';
  const span = document.createElement('span');
  span.className = 'badge ' + cls;
  span.textContent = c || '—';
  return span.outerHTML;
}

// ---------- Agenda ----------
async function renderAgenda(body, tenant) {
  body.innerHTML = '<div class="empty-state">Carregando…</div>';
  const { agenda } = await api(`/api/tenant/data${tenantQuery()}`);
  const eventos = agenda || [];
  if (!eventos.length) {
    body.innerHTML = '<div class="panel"><div class="empty-state">Nenhuma resposta de confirmação registrada ainda.</div></div>';
    return;
  }
  const table = buildTable(
    ['Evento', 'Ação', 'Status', 'Quando'],
    eventos.map((e) => [e.event_id || '—', e.acao || '—', e.status || '—', new Date(e.em).toLocaleString('pt-BR')])
  );
  body.innerHTML = '';
  body.appendChild(table);
}

// ---------- Tickets ----------
async function renderTickets(body, tenant) {
  body.innerHTML = '<div class="empty-state">Carregando…</div>';
  const { tickets } = await api(`/api/tenant/data${tenantQuery()}`);
  if (!tickets.length) {
    body.innerHTML = '<div class="panel"><div class="empty-state">Nenhum atendimento triado ainda.</div></div>';
    return;
  }
  const table = buildTable(
    ['De', 'Assunto', 'Setor', 'Prioridade', 'Resumo', 'Quando'],
    tickets.map((t) => [t.de || '—', t.assunto || '—', t.setor || '—', t.prioridade || '—', t.resumo || '—', new Date(t.log_em).toLocaleString('pt-BR')])
  );
  body.innerHTML = '';
  body.appendChild(table);
}

// ---------- Config (admin) ----------
function renderConfig(body, tenant) {
  const base = location.origin;
  body.innerHTML = `
    <div class="apikey-box" style="margin-bottom:16px">
      <div style="color:var(--muted);margin-bottom:6px">API key deste cliente (usar em <code>crm_api_key</code> nos workflows):</div>
      ${tenant.api_key}
    </div>
    <div class="setup-hint">
      Em cada workflow n8n deste cliente, abra o node <code>Edit Fields — Variáveis do Fluxo</code> e ajuste:
    </div>
    <div class="panel"><div style="padding:16px;font-size:13px;line-height:2">
      <b>01 — Qualificador de Leads</b><br/>
      <code>crm_webhook_url</code> = <code>${base}/api/leads</code><br/>
      <code>crm_api_key</code> = <code>${tenant.api_key}</code>
      <hr style="border-color:var(--border);margin:12px 0"/>
      <b>02 — Confirmação de Agenda</b><br/>
      <code>crm_webhook_url</code> = <code>${base}/api/agenda/events</code><br/>
      <code>crm_api_key</code> = <code>${tenant.api_key}</code>
      <hr style="border-color:var(--border);margin:12px 0"/>
      <b>03 — Follow-up de Leads Esfriados</b><br/>
      <code>crm_list_url</code> = <code>${base}/api/leads</code><br/>
      <code>crm_update_url</code> = <code>${base}/api/leads/update</code><br/>
      <code>crm_api_key</code> = <code>${tenant.api_key}</code>
      <hr style="border-color:var(--border);margin:12px 0"/>
      <b>04 — Triagem de Atendimento</b><br/>
      <code>sheets_webhook_url</code> = <code>${base}/api/tickets</code><br/>
      <code>crm_api_key</code> (header Authorization) = <code>${tenant.api_key}</code>
      <hr style="border-color:var(--border);margin:12px 0"/>
      <b>05 — Relatório Semanal Automático</b><br/>
      <code>crm_metrics_url</code> = <code>${base}/api/metrics/weekly</code><br/>
      <code>crm_api_key</code> = <code>${tenant.api_key}</code>
    </div></div>
  `;
}

// ---------- WhatsApp ----------
async function renderWhatsApp(body, tenant) {
  body.innerHTML = '<div class="empty-state">Carregando…</div>';
  const status = await api('/api/whatsapp/status' + tenantQuery());
  const inst = status.instance;
  const live = status.live;

  const stateBadge = !inst
    ? '<span class="badge default">não criada</span>'
    : (inst.connected || (live && live.instance && live.instance.status === 'open'))
      ? '<span class="badge quente">conectado</span>'
      : '<span class="badge morno">desconectado</span>';

  const box = el('div', { className: 'panel', style: 'padding:16px' }, [
    el('div', { style: 'font-size:13px;line-height:2' }, [
      el('b', { textContent: 'Canal WhatsApp (Evolution API) · ' }),
      el('span', { innerHTML: stateBadge }),
      el('div', { textContent: `Instância: ${inst ? inst.instance_name : '—'}` }),
      el('div', { textContent: `Número conectado: ${inst && inst.phone ? inst.phone : '—'}` }),
      el('div', null, [
        'URL do webhook (usar no connect): ',
        el('code', { textContent: status.webhook_url || '(Evolution não configurada no servidor)' }),
      ]),
    ]),
  ]);

  const form = el('div', { className: 'panel', style: 'padding:16px;margin-top:12px' }, [
    el('b', { textContent: 'Configuração da instância' }),
    el('div', { className: 'form-row', style: 'margin-top:10px' }, [
      el('label', { textContent: 'Nome da instância (opcional, ex.: automacao-rentavel)' }),
      el('input', { id: 'waInstanceName', value: (inst && inst.instance_name) || '', placeholder: 'automacao-rentavel' }),
    ]),
    el('div', { className: 'form-row' }, [
      el('label', { textContent: 'Token da instância (opcional — gerado automaticamente ao criar)' }),
      el('input', { id: 'waInstanceToken', value: (inst && inst.instance_token) || '', placeholder: 'deixe vazio para gerar' }),
    ]),
    el('div', { className: 'form-row' }, [
      el('label', { textContent: 'URL de destino (forward) — envie cada evento para este webhook n8n' }),
      el('input', { id: 'waForwardUrl', value: (inst && inst.forward_url) || '', placeholder: 'https://webhook.autofunil.com.br/webhook/qualificador-leads' }),
    ]),
  ]);

  const statusArea = el('div', { id: 'waStatus', className: 'setup-hint', style: 'margin-top:12px;white-space:pre-wrap' });

  const btn = (label, fn, opts = {}) => el('button', { className: opts.primary ? 'primary' : 'ghost', textContent: label, onclick: fn });

  const actions = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' }, [
    btn('Salvar configuração', () => saveWaConfig(tenant), { primary: true }),
    btn('Criar instância', () => createWaInstance(tenant)),
    btn('Conectar (apontar webhook)', () => connectWa(tenant)),
    btn('Ver QR Code', () => showWaQr(tenant)),
    btn('Atualizar status', () => renderWhatsApp(body, tenant)),
    btn('Desconectar', () => logoutWa(tenant)),
    btn('Excluir instância', () => deleteWaInstance(tenant)),
  ]);

  body.innerHTML = '';
  body.appendChild(box);
  body.appendChild(form);
  body.appendChild(statusArea);
  body.appendChild(actions);

  if (live && live.instance) {
    body.appendChild(el('div', { className: 'setup-hint', style: 'margin-top:12px', textContent: `Status Evolution: ${live.instance.status}${live.instance.ownerJid ? ' · número: ' + live.instance.ownerJid : ''}` }));
  }
  if (live && live.error) {
    body.appendChild(el('div', { className: 'setup-hint', style: 'margin-top:12px', textContent: 'Falha ao consultar status na Evolution: ' + live.error }));
  }
}

function waBody(tenant) {
  const payload = {
    instance_name: $('#waInstanceName').value.trim() || null,
    instance_token: $('#waInstanceToken').value.trim() || null,
    forward_url: $('#waForwardUrl').value.trim() || null,
  };
  if (user.role === 'admin') payload.tenant_id = tenant.id;
  return payload;
}

function waSetStatus(msg, isError) {
  const s = $('#waStatus');
  if (s) s.innerHTML = (isError ? '<div class="error-msg">' : '<b>') + (msg || '') + (isError ? '</div>' : '</b>');
}

async function saveWaConfig(tenant) {
  try {
    await api('/api/whatsapp', { method: 'PUT', body: JSON.stringify(waBody(tenant)) });
    renderWhatsApp($('#tabBody'), activeTenant);
  } catch (e) { waSetStatus(e.message, true); }
}

async function createWaInstance(tenant) {
  try {
    const r = await api('/api/whatsapp/instance', { method: 'POST', body: JSON.stringify(waBody(tenant)) });
    waSetStatus('Instância criada: ' + ((r.instance && r.instance.instance_name) || '') + (r.evolution && r.evolution.error ? ' · aviso da Evolution: ' + r.evolution.error : ''));
    renderWhatsApp($('#tabBody'), activeTenant);
  } catch (e) { waSetStatus(e.message, true); }
}

async function connectWa(tenant) {
  try {
    await api('/api/whatsapp/connect', { method: 'POST', body: JSON.stringify(waBody(tenant)) });
    waSetStatus('Webhook apontado para o CRM. Abra o WhatsApp no aparelho → Dispositivos vinculados → Escaneie o QR Code.');
    renderWhatsApp($('#tabBody'), activeTenant);
  } catch (e) { waSetStatus(e.message, true); }
}

async function showWaQr(tenant) {
  try {
    const url = '/api/whatsapp/qr' + (user.role === 'admin' ? '?tenant_id=' + encodeURIComponent(tenant.id) : '');
    const r = await api(url);
    const b64 = (r && r.qrcode && r.qrcode.base64) || (r && r.base64) || '';
    if (!b64) { waSetStatus('Nenhum QR disponível agora. Instância criada? Conectada? (resposta: ' + JSON.stringify(r) + ')', true); return; }
    const src = b64.startsWith('data:') ? b64 : 'data:image/png;base64,' + b64;
    const img = el('img', { src, style: 'max-width:260px;border:1px solid var(--border);border-radius:8px;background:#fff' });
    const holder = $('#waStatus');
    if (holder) { holder.innerHTML = ''; holder.appendChild(img); }
  } catch (e) { waSetStatus(e.message, true); }
}

async function logoutWa(tenant) {
  try {
    const payload = user.role === 'admin' ? { tenant_id: tenant.id } : {};
    await api('/api/whatsapp/logout', { method: 'POST', body: JSON.stringify(payload) });
    waSetStatus('Instância desconectada.');
    renderWhatsApp($('#tabBody'), activeTenant);
  } catch (e) { waSetStatus(e.message, true); }
}

async function deleteWaInstance(tenant) {
  if (!confirm('Excluir a instância e remover a configuração deste cliente?')) return;
  try {
    const payload = user.role === 'admin' ? { tenant_id: tenant.id } : {};
    await api('/api/whatsapp/instance', { method: 'DELETE', body: JSON.stringify(payload) });
    waSetStatus('Instância excluída.');
    renderWhatsApp($('#tabBody'), activeTenant);
  } catch (e) { waSetStatus(e.message, true); }
}

// ---------- Google Calendar ----------
async function renderGoogle(body, tenant, msg) {
  body.innerHTML = '<div class="empty-state">Carregando…</div>';
  const status = await api(`/api/google/status${tenantQuery()}`);

  body.innerHTML = '';

  if (msg === 'connected') {
    body.appendChild(el('div', { className: 'setup-hint' }, [
      el('b', { textContent: 'Conta conectada com sucesso. ' }),
      'As agendas da conta aparecem abaixo — marque as que devem ser usadas nos workflows.',
    ]));
  }

  if (!status.configured) {
    body.appendChild(el('div', { className: 'panel' }, [
      el('div', { className: 'empty-state', textContent: 'Google Calendar ainda não foi configurado no servidor. O administrador precisa preencher GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env.' }),
    ]));
    return;
  }

  if (!status.connected) {
    const connectCard = el('div', { className: 'panel', style: 'padding:28px;text-align:center' }, [
      el('h3', { textContent: 'Conectar conta Google', style: 'margin:0 0 10px' }),
      el('p', { className: 'setup-hint', style: 'margin:0 auto 18px;max-width:420px', textContent: 'Ao conectar, você autoriza o acesso às agendas da sua conta Google. Depois escolha quais agendas serão usadas pelos workflows.' }),
      el('button', { className: 'primary', textContent: 'Conectar com o Google', onclick: () => startGoogleOAuth() }),
    ]);
    body.appendChild(connectCard);
    return;
  }

  const header = el('div', { className: 'google-connected', style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap' }, [
    el('div', [
      el('div', { className: 'ok-msg', textContent: `Conectado: ${status.google_email}` }),
      el('div', { style: 'color:var(--muted);font-size:12px;margin-top:4px', textContent: `Conectado em ${new Date(status.connected_at).toLocaleString('pt-BR')}` }),
    ]),
    el('button', { className: 'ghost', textContent: 'Desconectar', onclick: () => disconnectGoogleFlow() }),
  ]);
  body.appendChild(header);

  body.appendChild(el('div', { className: 'setup-hint', style: 'margin-top:16px', textContent: 'Selecione as agendas (calendarId) que os workflows devem usar. O ID fica salvo no CRM para o n8n consumir.' }));

  const panel = el('div', { className: 'panel' });
  const calBox = el('div', { className: 'cal-list' });
  (status.calendars || []).forEach((c) => {
    const item = el('label', { className: 'cal-item' }, [
      el('input', {
        type: 'checkbox',
        checked: c.selected,
        onchange: (e) => {
          api(`/api/google/calendars/${encodeURIComponent(c.calendar_id)}/select`, {
            method: 'POST',
            body: JSON.stringify({ selected: e.target.checked, ...(user.role === 'admin' ? { tenant_id: tenant.id } : {}) }),
          }).catch((err) => alert(err.message));
        },
      }),
      el('div', { className: 'cal-info' }, [
        el('div', { className: 'cal-name', textContent: c.summary || c.calendar_id }),
        el('div', { className: 'cal-id', textContent: c.calendar_id }),
      ]),
    ]);
    calBox.appendChild(item);
  });
  panel.appendChild(calBox);
  body.appendChild(panel);

  const selected = (status.calendars || []).filter((c) => c.selected).map((c) => c.calendar_id);
  if (selected.length) {
    const box = el('div', { className: 'apikey-box', style: 'margin-top:16px' }, [
      el('div', { style: 'color:var(--muted);margin-bottom:6px' }, ['IDs selecionados (usar nos workflows, ex: variável ', el('code', { textContent: 'google_calendar_id' }), '):']),
      document.createTextNode(selected.join(', ')),
    ]);
    body.appendChild(box);
  }
}

async function startGoogleOAuth() {
  try {
    const body = user.role === 'admin' ? { tenant_id: activeTenant.id } : {};
    const { url } = await api('/api/google/oauth/start', { method: 'POST', body: JSON.stringify(body) });
    window.location.href = url;
  } catch (e) {
    alert(e.message);
  }
}

function disconnectGoogleFlow() {
  if (!confirm('Desconectar a conta Google deste cliente? Os IDs de agendas selecionados serão removidos.')) return;
  api('/api/google/disconnect', {
    method: 'POST',
    body: JSON.stringify(user.role === 'admin' ? { tenant_id: activeTenant.id } : {}),
  })
    .then(() => renderTenantShell(activeTenant))
    .catch((e) => alert(e.message));
}

// ---------- Helpers ----------
function buildTable(headers, rows) {
  const panel = el('div', { className: 'panel' });
  const table = el('table');
  const thead = el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { textContent: h })))]);
  const tbody = el('tbody');
  rows.forEach((row) => {
    const tr = el('tr');
    row.forEach((cell) => {
      const td = el('td');
      if (cell instanceof Node) td.appendChild(cell);
      else td.innerHTML = String(cell);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  panel.appendChild(table);
  return panel;
}

// ---------- Init ----------
(async function init() {
  if (token) {
    try {
      await api('/api/auth/me');
      boot();
      return;
    } catch (e) { /* falls through to login */ }
  }
})();