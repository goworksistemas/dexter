/**
 * Formatação (beautify) de artefatos com Prettier standalone.
 *
 * Prettier roda 100% no browser via `prettier/standalone` + plugins. Escolhido
 * por formatar CSS embutido em `<style>` e JS em `<script>` dentro do HTML
 * (`embeddedLanguageFormatting: "auto"`), o que resolve o caso do CSS minificado
 * gerado pelo modelo, e por cobrir markdown e JSON com a mesma API. Os plugins
 * são pesados, então o engine é carregado sob demanda — o bundle inicial não muda.
 *
 * O parser HTML do Prettier é estrito e recusa markup que não fecha; para esse
 * caso existe o fallback js-beautify (ver `beautifyFallback`).
 */
import type { ArtifactKind } from "./types"

export type FormatLanguage = "html" | "markdown" | "css" | "json"

/** Linha acima disso indica conteúdo minificado (CSS/HTML comprimido). */
const MINIFIED_LINE_CHARS = 240

const PARSER_BY_LANGUAGE: Record<FormatLanguage, string> = {
  html: "html",
  markdown: "markdown",
  css: "css",
  json: "json",
}

type PrettierEngine = {
  format: (
    source: string,
    options: Record<string, unknown>,
  ) => Promise<string>
  plugins: unknown[]
}

let enginePromise: Promise<PrettierEngine> | null = null

async function loadEngine(): Promise<PrettierEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [standalone, html, postcss, markdown, babel, estree] =
        await Promise.all([
          import("prettier/standalone"),
          import("prettier/plugins/html"),
          import("prettier/plugins/postcss"),
          import("prettier/plugins/markdown"),
          import("prettier/plugins/babel"),
          import("prettier/plugins/estree"),
        ])
      return {
        format: standalone.format as PrettierEngine["format"],
        plugins: [html, postcss, markdown, babel, estree],
      }
    })().catch((err) => {
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

/** Pré-carrega o Prettier (chamado ao abrir o painel, sem bloquear a UI). */
export function preloadFormatter(): void {
  void loadEngine().catch(() => {
    /* silencioso: o erro reaparece quando o usuário clicar em Formatar */
  })
}

function isJsonDocument(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/** Linguagem de formatação/realce a usar para um artefato. */
export function languageForArtifact(
  kind: ArtifactKind,
  content: string,
): FormatLanguage {
  if (kind === "html") return "html"
  if (isJsonDocument(content)) return "json"
  return "markdown"
}

/** Maior comprimento de linha do conteúdo. */
function maxLineLength(content: string): number {
  let max = 0
  let lineStart = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      const len = i - lineStart
      if (len > max) max = len
      lineStart = i + 1
    }
  }
  const tail = content.length - lineStart
  return tail > max ? tail : max
}

/**
 * Heurística de conteúdo minificado: alguma linha longuíssima, ou CSS/JS
 * colados em declarações sem quebra (`}` seguido de `.`/`*`/letra).
 */
export function looksMinified(content: string, language: FormatLanguage): boolean {
  if (!content.trim()) return false
  if (maxLineLength(content) > MINIFIED_LINE_CHARS) return true
  if (language === "html" || language === "css") {
    return /\}\s*[.#*a-zA-Z@:[]/.test(content) && !/\}\n/.test(content)
  }
  return false
}

function baseOptions(language: FormatLanguage): Record<string, unknown> {
  return {
    parser: PARSER_BY_LANGUAGE[language],
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    endOfLine: "lf",
    singleAttributePerLine: false,
    bracketSameLine: false,
    htmlWhitespaceSensitivity: "css",
    proseWrap: "preserve",
    embeddedLanguageFormatting: "auto",
  }
}

/**
 * Fallback tolerante (js-beautify): o parser HTML do Prettier é estrito e
 * recusa markup inválido — o caso real de uma resposta cortada no meio de um
 * `<style>`. js-beautify indenta o que der, inclusive o CSS embutido. Só entra
 * quando o Prettier falha, e é carregado sob demanda.
 */
async function beautifyFallback(
  content: string,
  language: FormatLanguage,
): Promise<string> {
  const beautify = (await import("js-beautify")).default
  const options = {
    indent_size: 2,
    indent_char: " ",
    wrap_line_length: 100,
    preserve_newlines: true,
    max_preserve_newlines: 2,
    end_with_newline: true,
  }
  if (language === "css") return beautify.css(content, options)
  return beautify.html(content, options)
}

/**
 * Formata o conteúdo do artefato. Cadeia de tentativas: Prettier completo →
 * Prettier sem formatar CSS/JS embutido (quando só o embutido está inválido) →
 * js-beautify (quando o markup em si não fecha).
 */
export async function formatArtifactContent(
  content: string,
  language: FormatLanguage,
): Promise<string> {
  const engine = await loadEngine()
  const options = { ...baseOptions(language), plugins: engine.plugins }
  try {
    return await engine.format(content, options)
  } catch (err) {
    if (language !== "html" && language !== "css") throw err
    if (language === "html") {
      try {
        return await engine.format(content, {
          ...options,
          embeddedLanguageFormatting: "off",
        })
      } catch {
        /* markup inválido: cai no fallback tolerante */
      }
    }
    try {
      return await beautifyFallback(content, language)
    } catch {
      throw err
    }
  }
}
