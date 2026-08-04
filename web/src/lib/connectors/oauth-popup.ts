import {
  fetchConnectors,
  startConnectorConnect,
  type ConnectorId,
} from "@/lib/connectors/api"

export const CONNECTOR_OAUTH_MSG = "dexter-connector-oauth" as const

export type ConnectorOAuthMessage = {
  type: typeof CONNECTOR_OAUTH_MSG
  provider: ConnectorId
  status: "connected" | "error"
}

function isOAuthMessage(data: unknown): data is ConnectorOAuthMessage {
  if (!data || typeof data !== "object") return false
  const d = data as Record<string, unknown>
  return (
    d.type === CONNECTOR_OAUTH_MSG &&
    (d.provider === "notion" || d.provider === "outlook") &&
    (d.status === "connected" || d.status === "error")
  )
}

/**
 * 1 clique: busca URL OAuth (auth no fetch) → abre popup → espera retorno.
 * Se o popup for bloqueado, faz redirect na mesma aba.
 */
export async function connectWithPopup(
  provider: ConnectorId,
  returnTo?: string,
): Promise<"connected" | "cancelled" | "error"> {
  const url = await startConnectorConnect(provider, returnTo)
  const features =
    "popup=yes,width=600,height=720,menubar=no,toolbar=no,location=yes,status=no"
  const popup = window.open(url, `dexter_oauth_${provider}`, features)

  if (!popup) {
    window.location.assign(url)
    return "cancelled"
  }

  return await new Promise<"connected" | "cancelled" | "error">((resolve) => {
    let settled = false
    const finish = (result: "connected" | "cancelled" | "error") => {
      if (settled) return
      settled = true
      window.clearInterval(pollTimer)
      window.clearInterval(closedTimer)
      window.clearTimeout(safetyTimer)
      window.removeEventListener("message", onMessage)
      window.removeEventListener("focus", onFocus)
      try {
        popup.close()
      } catch {
        /* ignore */
      }
      resolve(result)
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (!isOAuthMessage(event.data)) return
      if (event.data.provider !== provider) return
      finish(event.data.status === "connected" ? "connected" : "error")
    }

    // Um GET /api/connectors por vez: poll, focus e popup.closed disparavam
    // duas ou três requisições concorrentes ao mesmo endpoint.
    let inFlight: Promise<void> | null = null
    const checkConnected = (): Promise<void> => {
      if (settled) return Promise.resolve()
      if (inFlight) return inFlight
      const run = (async () => {
        try {
          const data = await fetchConnectors()
          const row = data.connectors.find((c) => c.id === provider)
          if (row?.connected) finish("connected")
        } catch {
          /* ignore transient */
        } finally {
          inFlight = null
        }
      })()
      inFlight = run
      return run
    }

    const onFocus = () => {
      void checkConnected()
    }

    window.addEventListener("message", onMessage)
    window.addEventListener("focus", onFocus)

    // 3s basta: `focus` e o popup fechado cobrem os casos rápidos.
    const pollTimer = window.setInterval(() => {
      void checkConnected()
    }, 3000)

    const closedTimer = window.setInterval(() => {
      if (!popup.closed) return
      // Espera a checagem em voo antes de declarar cancelado.
      void checkConnected().then(() => {
        if (!settled) finish("cancelled")
      })
    }, 500)

    // safety: 5 min
    const safetyTimer = window.setTimeout(() => {
      if (!settled) finish("cancelled")
    }, 300_000)
  })
}
