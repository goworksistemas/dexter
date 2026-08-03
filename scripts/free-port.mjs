#!/usr/bin/env node
/**
 * Libera portas TCP presas por processos stale (server antigo que não morreu no
 * Ctrl+C, watcher duplicado, etc). Rodar antes de subir o dev evita o clássico
 * "o backend responde, mas é a versão velha do código".
 *
 * Uso: node scripts/free-port.mjs 8787 5273
 */
import { execFileSync } from 'node:child_process'
import net from 'node:net'

const isWindows = process.platform === 'win32'
const SELF_PIDS = new Set([process.pid, process.ppid].filter(Boolean))

const ports = process.argv.slice(2).map((value) => {
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[free-port] porta inválida: ${value}`)
    process.exit(1)
  }
  return port
})

if (ports.length === 0) {
  console.error('[free-port] informe ao menos uma porta. Ex: node scripts/free-port.mjs 8787')
  process.exit(1)
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function tryRun(command, args) {
  try {
    execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, message: '' }
  } catch (error) {
    const output = `${error.stderr ?? ''}${error.stdout ?? ''}`.trim()
    return { ok: false, message: output || String(error.message ?? error) }
  }
}

function listenerPids(port) {
  const pids = new Set()

  if (isWindows) {
    // Sem `-p tcp`: esse filtro esconde TCPv6, e o Vite escuta em [::1].
    for (const line of run('netstat', ['-ano']).split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) continue
      const [proto, local, , state, pid] = parts
      if (proto !== 'TCP' && proto !== 'TCPv6') continue
      if (state !== 'LISTENING') continue
      if (!local.endsWith(`:${port}`)) continue
      pids.add(Number.parseInt(pid, 10))
    }
  } else {
    const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    for (const line of out.split(/\r?\n/)) {
      if (line.trim()) pids.add(Number.parseInt(line.trim(), 10))
    }
  }

  // PID 0/4 são System no Windows; matar a si mesmo derruba o próprio `pnpm dev`.
  return [...pids].filter((pid) => Number.isInteger(pid) && pid > 4 && !SELF_PIDS.has(pid))
}

function kill(pid) {
  if (isWindows) {
    const result = tryRun('taskkill', ['/PID', String(pid), '/T', '/F'])
    if (!result.ok) {
      console.warn(`[free-port] pid ${pid}: taskkill falhou — ${result.message.split(/\r?\n/)[0]}`)
    }
    return
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if (error.code === 'EPERM') console.warn(`[free-port] pid ${pid}: sem permissão para matar`)
    }
  }
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const probe = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(port, host)
  })
}

// Fastify sobe em IPv4 e o Vite em [::1]; checar os dois stacks.
async function isFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    if (!(await canBind(port, host))) return false
  }
  return true
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

for (const port of ports) {
  const pids = listenerPids(port)

  if (pids.length === 0) {
    console.log(`[free-port] ${port}: livre`)
    continue
  }

  console.log(`[free-port] ${port}: matando processo stale (pid ${pids.join(', ')})`)
  for (const pid of pids) kill(pid)

  let freed = false
  for (let attempt = 0; attempt < 20 && !freed; attempt += 1) {
    await sleep(100)
    freed = await isFree(port)
  }

  if (freed) {
    console.log(`[free-port] ${port}: liberada`)
  } else {
    console.warn(`[free-port] ${port}: ainda ocupada — verifique manualmente (netstat -ano | findstr :${port})`)
  }
}
