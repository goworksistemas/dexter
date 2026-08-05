# Load test — AgentCore `POST /api/chat`

Script [k6](https://k6.io) para validar a meta do projeto: **50 conversas simultâneas com p95 < 3s até o primeiro token** (TTFT).

## ⚠️ Custo — leia antes de rodar

**Cada VU dispara chamadas reais ao LLM** (e pode acionar tools). Isso gera custo de tokens e carga no AgentCore/Supabase.

Recomendações:

1. Use um **modelo barato** via `K6_MODEL` (ex.: Haiku / equivalente no catálogo admin).
2. Rode por **tempo curto** no smoke (`K6_DURATION=10s`, `K6_VUS=2`).
3. Prefira **homolog**, não produção, na primeira medição de 50 VUs.
4. Mensagem padrão do script é curta (`Responda apenas com a palavra ok…`) para limitar output.

## Como o TTFT é medido

O k6 **stock não tem parser SSE nativo** e `k6/experimental/streams` **não** lê chunks do cliente HTTP (issue [grafana/k6#4086](https://github.com/grafana/k6/issues/4086); SSE oficial ficou na extensão community).

Este script usa:

| Métrica | Como | Limitação |
|--------|------|-----------|
| **`ttft`** (Trend) | `res.timings.waiting` — TTFB, tempo até o **primeiro byte** do body | Pode ser um evento `progress`/keepalive **antes** de `event: text-delta`. Não é o relógio exato do primeiro token de texto. |
| Checks | Após buffer completo (`responseType: 'text'`), valida presença de `event: text-delta` e `event: done` | Só confirma que o stream “parece” completo; latência do token é a aproximação acima. |

Threshold: `ttft` → `p(95)<3000` (ms).

**Alternativa (TTFT real):** extensão [xk6-sse](https://github.com/phymbert/xk6-sse) (`import sse from "k6/x/sse"`) — k6 recente resolve community extensions automaticamente. Cronometrar do `open` até o primeiro `event` com `name === "text-delta"`. Este repo mantém o script **sem** extensão para portabilidade no Windows/CI.

## Instalar o k6

### Windows (winget)

```powershell
winget install k6 --source winget
k6 version
```

Alternativa: [releases](https://github.com/grafana/k6/releases) (`.msi`) ou `choco install k6`.

### Linux

```bash
# Debian/Ubuntu (exemplo — ver docs oficiais para a distro)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
k6 version
```

Docs: https://grafana.com/docs/k6/latest/set-up/install-k6/

## Obter um JWT de teste (GoTrue / Supabase Auth)

Projeto agentcore: `https://jtvscxbwralvzpfhtqcs.supabase.co`.

A chave **anon/publishable** é pública (está em `web/.env.example` como `VITE_SUPABASE_ANON_KEY`). Use um usuário de teste com e-mail autorizado.

### PowerShell

```powershell
$SUPABASE_URL = "https://jtvscxbwralvzpfhtqcs.supabase.co"
$ANON_KEY = "<cole VITE_SUPABASE_ANON_KEY do web/.env.example ou Infisical>"
$EMAIL = "seu.usuario@gowork.com.br"
$PASSWORD = "<senha>"

$r = Invoke-RestMethod -Method POST `
  -Uri "$SUPABASE_URL/auth/v1/token?grant_type=password" `
  -Headers @{
    apikey = $ANON_KEY
    "Content-Type" = "application/json"
  } `
  -Body (@{ email = $EMAIL; password = $PASSWORD } | ConvertTo-Json)

$env:K6_JWT = $r.access_token
```

### curl (Linux / Git Bash)

```bash
SUPABASE_URL="https://jtvscxbwralvzpfhtqcs.supabase.co"
ANON_KEY="<cole VITE_SUPABASE_ANON_KEY>"
EMAIL="seu.usuario@gowork.com.br"
PASSWORD="<senha>"

export K6_JWT=$(curl -sS -X POST \
  "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" \
  | jq -r .access_token)

echo "JWT length: ${#K6_JWT}"
```

O JWT expira (tipicamente ~1h). Renove se o load test for longo.

## Variáveis

| Env | Default | Descrição |
|-----|---------|-----------|
| `K6_JWT` | _(obrigatório)_ | `Authorization: Bearer …` |
| `K6_BASE_URL` | `http://localhost:8787` | Origem do AgentCore |
| `K6_VUS` | `50` | Virtual users (conversas simultâneas) |
| `K6_DURATION` | `60s` | Duração do cenário |
| `K6_MODEL` | _(vazio)_ | `context.model` — id do catálogo (use modelo barato) |
| `K6_MESSAGE` | frase curta “ok” | Conteúdo da mensagem user |

Payload por iteração (contrato atual de `chatRequestSchema`):

```json
{
  "threadId": "<uuid novo>",
  "message": { "id": "<uuid>", "role": "user", "content": "…", "createdAt": "…" },
  "context": { "model": "<opcional>" }
}
```

## Como rodar

Na raiz do monorepo (ou nesta pasta):

```powershell
# Smoke barato (2 VUs, 10s) — local
$env:K6_JWT = "…"
$env:K6_VUS = "2"
$env:K6_DURATION = "10s"
$env:K6_MODEL = "claude-haiku-4-5-20251001"   # ajuste ao id real do catálogo
k6 run .\scripts\loadtest\k6-chat.js
```

### Homolog

```powershell
$env:K6_BASE_URL = "https://agentcore-homolog.exemplo.com"  # URL real de homolog
$env:K6_JWT = "…"
$env:K6_VUS = "50"
$env:K6_DURATION = "60s"
$env:K6_MODEL = "<modelo-barato>"
k6 run .\scripts\loadtest\k6-chat.js
```

Valide o script sem trafegar (parse/AST):

```powershell
k6 inspect .\scripts\loadtest\k6-chat.js
```

## Interpretar o resultado

1. **Threshold `ttft` `p(95)<3000`** — verde = meta de latência aproximada atingida; vermelho = p95 ≥ 3s (ou TTFB alto por auth/LLM/fila).
2. **Checks** `status 200`, `SSE tem text-delta`, `SSE tem done` — falhas apontam auth (401), schema (400), timeout ou erro de provider (event `error` sem `done`).
3. **`http_req_duration`** — duração **total** do stream (até o buffer fechar), não é TTFT. Pode ser dezenas de segundos com resposta longa.
4. Compare `ttft` p95 com carga em homolog; anote modelo, VUs, horário e se o AgentCore tinha 1 ou N réplicas.

## Status desta máquina (leva C2)

- k6 **não** estava instalado no PATH no momento da entrega.
- `http://localhost:8787/healthz` **não** respondeu — smoke real fica para homolog/ambiente com server + JWT.
- Validação local prevista: instalar k6 e rodar `k6 inspect` / smoke quando o ambiente estiver de pé.
