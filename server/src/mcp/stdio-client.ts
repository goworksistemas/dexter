/**
 * Cliente MCP sobre stdio (JSON-RPC 2.0).
 * Spawna o subprocesso, faz initialize + tools/list + tools/call.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

import type {
  McpCallToolResult,
  McpClientOptions,
  McpListToolsResult,
  McpTool,
} from "./types.js"

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** Solta o listener de abort do signal do request (evita acumular listeners). */
  cleanup?: () => void
}

export class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private rl: ReturnType<typeof createInterface> | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private ready: Promise<void> | null = null
  private closed = false
  private readonly timeoutMs: number
  private readonly label: string

  constructor(private readonly opts: McpClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.label = opts.label ?? opts.command
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    await this.ensureReady()
    const result = (await this.request(
      "tools/list",
      {},
      signal,
    )) as McpListToolsResult
    return result.tools ?? []
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallToolResult> {
    await this.ensureReady()
    return (await this.request(
      "tools/call",
      { name, arguments: args },
      signal,
    )) as McpCallToolResult
  }

  async close(): Promise<void> {
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.cleanup?.()
      p.reject(new Error(`MCP ${this.label}: cliente fechado`))
    }
    this.pending.clear()
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM")
      await new Promise((r) => setTimeout(r, 400))
      if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL")
    }
    this.rl?.close()
    this.rl = null
    this.proc = null
    this.ready = null
  }

  private ensureReady(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`MCP ${this.label}: cliente fechado`))
    }
    // Sem o reset, uma promise REJEITADA ficaria em cache e toda chamada
    // seguinte falharia com o erro antigo até reiniciar o AgentCore.
    if (!this.ready) {
      this.ready = this.start().catch((err: unknown) => {
        this.ready = null
        throw err
      })
    }
    return this.ready
  }

  private async start(): Promise<void> {
    const env = {
      ...process.env,
      ...(this.opts.env ?? {}),
    } as NodeJS.ProcessEnv

    this.proc = spawn(this.opts.command, this.opts.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })

    const proc = this.proc

    // Os pipes do filho podem morrer entre o teste de `writable` e o write
    // (EPIPE/ECONNRESET). Sem listener de 'error' o stream vira
    // uncaughtException e derruba o AgentCore inteiro — o erro real chega pelo
    // callback do write / pelo 'exit' do processo.
    proc.stdin.on("error", () => undefined)
    proc.stdout.on("error", () => undefined)
    proc.stderr.on("error", () => undefined)

    proc.on("error", (err) => {
      if (this.proc !== proc) return
      this.failAll(
        new Error(`MCP ${this.label}: falha ao spawn — ${err.message}`),
      )
    })
    proc.on("exit", (code, signal) => {
      // Processo já substituído (initialize falhou e um novo spawn assumiu):
      // este exit é do antigo — mexer no estado mataria o readline do novo e
      // rejeitaria requests que não são deste processo.
      if (this.proc !== proc) return
      this.failAll(
        new Error(
          `MCP ${this.label}: processo encerrou (code=${code}, signal=${signal})`,
        ),
      )
      this.rl?.close()
      this.rl = null
      this.proc = null
      this.ready = null
    })

    const rl = createInterface({ input: proc.stdout })
    this.rl = rl
    rl.on("line", (line) => this.onLine(line))

    const errChunks: string[] = []
    proc.stderr.on("data", (buf: Buffer) => {
      errChunks.push(buf.toString("utf8"))
      if (errChunks.join("").length > 8_000) errChunks.shift()
    })

    try {
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "dexter-agentcore", version: "0.1.0" },
      })
      this.notify("notifications/initialized", {})
    } catch (err) {
      // Mata o processo antes de propagar — senão sobra um filho órfão por
      // tentativa de initialize que falhou sem o processo ter morrido.
      if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL")
      this.rl?.close()
      this.rl = null
      this.proc = null
      const tail = errChunks.join("").trim().slice(-1_500)
      const base = err instanceof Error ? err.message : String(err)
      throw new Error(tail ? `${base} | stderr: ${tail}` : base)
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: {
      id?: number
      result?: unknown
      error?: { message?: string; code?: number }
    }
    try {
      msg = JSON.parse(trimmed) as typeof msg
    } catch {
      return
    }
    if (msg.id == null) return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.discard(msg.id)
    if (msg.error) {
      pending.reject(
        new Error(
          `MCP ${this.label}: ${msg.error.message ?? JSON.stringify(msg.error)}`,
        ),
      )
      return
    }
    pending.resolve(msg.result)
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.proc?.stdin.writable) {
      return Promise.reject(
        new Error(`MCP ${this.label}: stdin indisponível`),
      )
    }
    if (signal?.aborted) {
      return Promise.reject(
        new Error(`MCP ${this.label}: ${method} cancelado`),
      )
    }
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.discard(id)
        reject(
          new Error(
            `MCP ${this.label}: timeout em ${method} (${this.timeoutMs}ms)`,
          ),
        )
      }, this.timeoutMs)

      // Cancelamento: avisa o servidor MCP (JSON-RPC notifications/cancelled)
      // para ele parar o trabalho, e solta a promise pendente aqui.
      const onAbort = () => {
        this.discard(id)
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: "cancelado pelo cliente",
        })
        reject(new Error(`MCP ${this.label}: ${method} cancelado`))
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true })

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup: signal
          ? () => signal.removeEventListener("abort", onAbort)
          : undefined,
      })
      this.proc!.stdin.write(`${payload}\n`, (err) => {
        if (err) {
          this.discard(id)
          reject(err)
        }
      })
    })
  }

  /** Tira o request do mapa (timer + listener de abort) sem resolver/rejeitar. */
  private discard(id: number): void {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    p.cleanup?.()
    this.pending.delete(id)
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) return
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params })
    this.proc.stdin.write(`${payload}\n`)
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.cleanup?.()
      p.reject(err)
    }
    this.pending.clear()
  }
}
