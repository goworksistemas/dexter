# Dexter

Monorepo pnpm com dois pacotes:

| Pacote   | O que é                              | Porta |
| -------- | ------------------------------------ | ----- |
| `server` | AgentCore — backend Fastify (tsx)    | 8787  |
| `web`    | Front Vite + React                   | 5273  |

O `web` faz proxy de `/api` para `http://localhost:8787` em dev.

## Rodando local

```bash
pnpm install   # instala server + web (workspace)
pnpm dev       # sobe os dois
```

`pnpm dev` faz, nessa ordem:

1. `scripts/free-port.mjs` mata processos stale nas portas 8787 e 5273 — sem isso, um server antigo continua respondendo e você depura código que não está rodando;
2. sobe `server` (via `infisical run --env=prod --path=/`) e `web` em paralelo, com log prefixado por `[server]` / `[web]`;
3. `scripts/wait-healthz.mjs` espera `/healthz` do AgentCore e imprime `[ready]` quando o stack está de pé.

Requisitos: Node 22+, pnpm 10+ e a CLI do [Infisical](https://infisical.com/docs/cli/overview) autenticada (o server lê os secrets de lá, não de `.env`).

### Parando

`Ctrl+C` no terminal do `pnpm dev` derruba server e web juntos. Se sobrar algum processo preso numa porta, o próximo `pnpm dev` mata sozinho — ou rode:

```bash
pnpm free-port          # libera 8787 e 5273
pnpm free-port 5274     # libera também outras portas
```

Se o `free-port` avisar `taskkill falhou — Acesso negado`, o processo pertence a outro usuário/sessão do Windows: feche o terminal dono dele (ou rode como admin).

### Outros comandos (raiz)

| Comando          | O que faz                                                     |
| ---------------- | ------------------------------------------------------------- |
| `pnpm dev:server` | Só o AgentCore (com Infisical), liberando a 8787 antes         |
| `pnpm dev:web`    | Só o front                                                     |
| `pnpm build`      | `pnpm -r build` — server é type-check (roda via tsx), web gera `dist/` |
| `pnpm typecheck`  | `tsc` nos dois pacotes                                         |
| `pnpm lint`       | `oxlint` nos dois pacotes                                      |

O lockfile válido é o `pnpm-lock.yaml` da raiz; os `pnpm-lock.yaml` dentro de `server/` e `web/` são resquício das instalações separadas e o pnpm os ignora no workspace.
