import * as React from "react"

/** Trocar srcDoc recarrega o iframe (flicker + scroll perdido): espera a pausa. */
const RELOAD_DEBOUNCE_MS = 250

/** Preview HTML sandboxed (painel + aba dedicada). */
export function HtmlPreview({ html }: { html: string }) {
  const [deferred, setDeferred] = React.useState(html)

  React.useEffect(() => {
    const t = window.setTimeout(() => setDeferred(html), RELOAD_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [html])

  const srcDoc = React.useMemo(() => {
    return `<!doctype html><html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:;" />
<style>body{font-family:system-ui,sans-serif;margin:16px;color:#14181b;background:#fff} @media (prefers-color-scheme: dark){body{color:#f8f9fa;background:#0a0d0f}}</style>
</head><body>${deferred}</body></html>`
  }, [deferred])

  return (
    <iframe
      title="Preview do artefato HTML"
      sandbox=""
      srcDoc={srcDoc}
      className="size-full min-h-0 flex-1 rounded-lg border border-border/60 bg-background"
    />
  )
}
