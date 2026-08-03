# Deploy Dexter no Portainer

Stack: `docker-compose.portainer.yml`  
Domínio: `https://dexter.gowork.com.br`  
Imagens: `ghcr.io/goworksistemas/dexter-agentcore` e `dexter-web` (CI em `.github/workflows/publish-images.yml`)

## Pré-requisitos

1. Workflow **Publish images** rodou com sucesso no GitHub (aba Actions).
2. Pacotes GHCR visíveis para o Portainer:
   - deixe **public**, ou
   - cadastre o registry `ghcr.io` em Portainer → Registries (PAT com `read:packages`).
3. DNS `dexter.gowork.com.br` → IP do host Portainer.
4. Rede Docker externa `dexter` criada e **anexada ao container Traefik** (mesmo padrão `ia` / `litellm`).

```bash
docker network create dexter
docker network connect dexter <nome-do-container-traefik>
```

5. No Supabase Auth (projeto agentcore), Redirect URLs:
   - `https://dexter.gowork.com.br/**`
   - `https://dexter.gowork.com.br/auth/callback`
   - `https://dexter.gowork.com.br/update-password`

## Criar a stack

1. Portainer → **Stacks** → **Add stack**
2. Nome: `dexter`
3. Método: **Upload** do arquivo `docker-compose.portainer.yml`  
   (não use Web Editor — backticks do Traefik quebram)
4. Environment variables da stack (valores do Infisical projeto `agentcore`):

| Variável | Notas |
|---|---|
| `ANTHROPIC_API_KEY` | secret |
| `SUPABASE_URL` | `https://jtvscxbwralvzpfhtqcs.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | secret |
| `CORS_ORIGINS` | `https://dexter.gowork.com.br` |
| `LLM_PROVIDER` | `anthropic` (ou `ollama`) |
| `ALLOW_DEV_USER` | `false` |
| `ANTHROPIC_MODEL` | opcional |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | opcional |

5. Deploy the stack.

## Atualizar

Depois de um push em `main` (imagens novas no GHCR):

- Portainer → stack `dexter` → **Pull and redeploy**, ou
- `docker compose -f docker-compose.portainer.yml pull && docker compose -f docker-compose.portainer.yml up -d`

## Smoke

- `https://dexter.gowork.com.br/healthz` → `{"status":"ok"}`
- `https://dexter.gowork.com.br/` → UI de login
- Login Supabase → chat + lista de conversas
