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
}

export class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams | null = null
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

  async listTools(): Promise<McpTool[]> {
    await this.ensureReady()
    const result = (await this.request("tools/list", {})) as McpListToolsResult
    return result.tools ?? []
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult> {
    await this.ensureReady()
    return (await this.request("tools/call", {
      name,
      arguments: args,
    })) as McpCallToolResult
  }

  async close(): Promise<void> {
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`MCP ${this.label}: cliente fechado`))
    }
    this.pending.clear()
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM")
      await new Promise((r) => setTimeout(r, 400))
      if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL")
    }
    this.proc = null
    this.ready = null
  }

  private ensureReady(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`MCP ${this.label}: cliente fechado`))
    }
    if (!this.ready) this.ready = this.start()
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
    proc.on("error", (err) => {
      this.failAll(
        new Error(`MCP ${this.label}: falha ao spawn — ${err.message}`),
      )
    })
    proc.on("exit", (code, signal) => {
      this.failAll(
        new Error(
          `MCP ${this.label}: processo encerrou (code=${code}, signal=${signal})`,
        ),
      )
      this.proc = null
      this.ready = null
    })

    const rl = createInterface({ input: proc.stdout })
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
    clearTimeout(pending.timer)
    this.pending.delete(msg.id)
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
  ): Promise<unknown> {
    if (!this.proc?.stdin.writable) {
      return Promise.reject(
        new Error(`MCP ${this.label}: stdin indisponível`),
      )
    }
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `MCP ${this.label}: timeout em ${method} (${this.timeoutMs}ms)`,
          ),
        )
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc!.stdin.write(`${payload}\n`, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) return
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params })
    this.proc.stdin.write(`${payload}\n`)
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
