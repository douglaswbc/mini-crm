# Mini-CRM — Automação Rentável

Mini-CRM **multi-cliente** com **PostgreSQL**, **login por cliente** e
**conexão OAuth2 do Google Calendar** por empresa. Expõe os endpoints que os
5 workflows n8n do playbook já chamam (`crm_webhook_url`, `crm_list_url`,
`crm_update_url`, `crm_metrics_url`, `sheets_webhook_url`) — você **não
precisa reescrever nenhum node**, só apontar as variáveis dos workflows para cá.

---

## O que mudou (v2)

- **PostgreSQL** no lugar do arquivo JSON (`data/db.json`). O schema é criado
  automaticamente na primeira subida. Dá para usar o mesmo servidor Postgres do
  stack n8n, em um banco dedicado (ex: `mini_crm`).
- **Login por cliente**: cada empresa tem seu usuário/senha e vê **apenas os
  próprios dados**. O administrador continua com acesso total.
- **Google Calendar por cliente**: cada cliente conecta a própria conta Google
  via OAuth2 e seleciona as agendas (calendarId) que os workflows devem usar.
  Os tokens ficam criptografados (AES-256) no banco.
- **WhatsApp (Evolution API)**: cada cliente cadastra a própria instância
  (criada no painel da Evolution) direto no painel e define uma URL de
  *forward* (ex: webhook do n8n). Mensagens viram leads (`wa_<telefone>`) com a
  timeline de conversa; mídia é guardada como descritor + URL (sem base64).
- Import opcional do `db.json` legado na primeira subida.

---

## 1. Configurando o banco (PostgreSQL)

Use o mesmo servidor do stack n8n (host `postgres`, usuário `postgres`, senha
da stack). Crie o banco dedicado uma única vez:

```bash
docker exec -it <container_do_postgres> psql -U postgres -c "CREATE DATABASE mini_crm;"
```

Depois aponte o `.env` para ele. Veja `.env.example`.

## 2. Configurando o Google Cloud (uma vez por instalação)

1. Acesse https://console.cloud.google.com e crie um projeto.
2. Ative as APIs: **Google Calendar API** e **People API** (para obter o e-mail).
3. Crie credenciais OAuth2 do tipo *Web application*.
4. Em **URIs de redirecionamento autorizados**, adicione
   `https://SEU_DOMINIO/api/google/oauth/callback` (use `http://localhost:3000/...` para testes locais).
5. Copie o `Client ID` e o `Client Secret` para o `.env`
   (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`).

> Durante o desenvolvimento a conta do projeto fica em "modo de teste" e só
> aceita contas adicionadas como *test users*. Para produção, publique o app.

## 3. Rodando

```bash
cp .env.example .env
# edite .env: DATABASE_URL, ENCRYPTION_KEY, ADMIN_PASSWORD, GOOGLE_*
npm install
npm start
```

Localmente: `http://localhost:3000` → login com `admin` + `ADMIN_PASSWORD`.

## 4. Subindo na VPS (Docker Swarm + Traefik)

```bash
# na VPS, dentro da pasta do projeto
cp .env.example .env
nano .env
docker stack deploy -c docker-compose.yml crm   # ou: docker compose up -d --build
```

O `docker-compose.yml` já está pronto para a rede `DwbCNet` do stack n8n e o
Traefik (troque `crm.seudominio.com.br` pelo seu domínio). Sem Traefik, comente
os labels e use `ports: 3000:3000`.

## 5. Uso

1. **Admin** faz login e cria o cliente (botão "+ Novo cliente") → recebe a
   **API key** do cliente (usada nos workflows).
2. **Admin cria o login da empresa** (botão "Usuário" no cliente, ou aba
   "Usuários") → passa usuário/senha para a empresa.
3. **A empresa entra** com o login dela e vê somente os dados dela.
4. Na aba **Google Calendar**, a empresa clica em "Conectar com o Google",
   autoriza a conta e **marca as agendas** que os workflows devem usar. Os
   IDs selecionados ficam salvos para o n8n consumir.
5. Configure as variáveis dos workflows (veja aba "Configurar workflows" no
   painel do admin) apontando para este servidor com a API key do cliente.

## 5a. Canal WhatsApp (Evolution API)

O CRM não conversa com a API da Evolution: a instância é criada e vinculada no
**painel da Evolution** (na sua VPS, ex: `https://evogo.autofunil.com.br`), e o
CRM apenas guarda a referência (CRUD local) e recebe os eventos via webhook.

1. No painel da Evolution, **crie a instância** (nome, ex: `automacao-rentavel`)
   e copie o **ID (UUID)** e o **token** gerados.
2. Na aba **WhatsApp** do CRM (admin ou empresa), preencha: nome da instância,
   ID (UUID), token e a **URL de destino (forward)** — para enviar cada evento
   ao n8n, use `https://webhook.autofunil.com.br/webhook/qualificador-leads`.
3. Clique em **Salvar**.
4. No painel da Evolution, aponte o **webhook da instância** para
   `<CRM_BASE_URL>/api/evolution/webhook` (o CRM mostra essa URL na aba) e
   vincule o WhatsApp (QR Code) por lá.

Cada mensagem recebida cria/atualiza o lead `wa_<telefone>` (1 lead por
contato, dedup por `mid`) e, se houver `forward_url`, reenvia o payload bruto
da Evolution para ela (fire-and-forget). Mídia vira `[áudio]`, `[imagem]`,
`[vídeo]`, `[documento]` com URL no evento da timeline.

## 6. Endpoints

**API pública (workflows n8n)** — header `Authorization: Bearer <api_key>`:

- `POST /api/leads` — cria/atualiza lead ou registra evento na timeline.
- `GET /api/leads?dias=N&status=sem_resposta` — leads esfriados.
- `POST /api/leads/update` — atualiza status após follow-up.
- `POST /api/agenda/events` — registra confirmação/remarcação de agenda.
- `POST /api/tickets` — registra atendimento triado.
- `GET /api/metrics/weekly?from=&to=` — métricas semanais.

**Painel (login por usuário/senha)** — header `Authorization: Bearer <token>`:

- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/tenant/data`, `GET /api/tenant/metrics` (escopado ao tenant do usuário)
- `POST /api/tenant/metrics/override` (admin) — ajuste manual de faltas/receita.
- `GET /admin/api/tenants`, `POST/PATCH/DELETE /admin/api/tenants...` (admin)
- `GET/POST/DELETE /admin/api/users...`, `POST /admin/api/users/:id/password` (admin)
- `POST /api/google/oauth/start` — inicia OAuth2 (redireciona ao Google)
- `GET /api/google/oauth/callback` — retorno do Google (troca código por token)
- `GET /api/google/status` — situação da conexão + agendas salvas
- `POST /api/google/calendars/:calendarId/select` — marca/desmarca agenda
- `POST /api/google/disconnect` — desvincula a conta

**WhatsApp (painel, escopado ao tenant da sessão; admin usa `?tenant_id=`)**:

- `POST /api/evolution/webhook` — webhook da Evolution (autentica pelo
  `instanceToken` da instância, sem precisar de header).
- `GET /api/whatsapp/status` — webhook_url + instância cadastrada.
- `PUT /api/whatsapp` — salva nome/ID/token/forward da instância.
- `DELETE /api/whatsapp/instance` — remove o registro local.

## 7. Segurança

- Troque `ADMIN_PASSWORD` e gere uma `ENCRYPTION_KEY` forte (32 chars) antes de
  ir para produção.
- Os tokens do Google ficam **criptografados** (AES-256-GCM) no banco.
- Cada cliente enxerga apenas os próprios dados (o servidor escopa pelo tenant
  da sessão).
- Sirva sempre atrás de HTTPS (Traefik + Let's Encrypt).