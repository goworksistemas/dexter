/**
 * Editor de código do painel de artefatos (CodeMirror 6).
 *
 * CodeMirror foi escolhido no lugar de Monaco: modular (só os modos usados
 * entram no bundle), sem web workers/CDN e com tema via CSS — dá para casar
 * com os tokens de cor do Dexter (light/dark) sem duplicar paleta.
 */
import * as React from "react"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view"
import { tags as t } from "@lezer/highlight"

import type { FormatLanguage } from "@/lib/artifacts"
import { cn } from "@/lib/utils"

const LANGUAGE_EXTENSIONS: Record<FormatLanguage, () => Extension> = {
  html: () => html({ autoCloseTags: true, matchClosingTags: true }),
  markdown: () => markdown(),
  css: () => css(),
  json: () => json(),
}

const lightHighlight = HighlightStyle.define([
  { tag: t.comment, color: "#6b7280", fontStyle: "italic" },
  { tag: [t.tagName, t.standard(t.tagName)], color: "#2563eb" },
  { tag: t.attributeName, color: "#7c3aed" },
  { tag: [t.string, t.attributeValue, t.special(t.string)], color: "#15803d" },
  { tag: [t.number, t.bool, t.null, t.unit], color: "#b45309" },
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: "#7c3aed" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "#0f766e" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "#1f2937" },
  { tag: [t.className, t.typeName, t.namespace], color: "#0369a1" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#64748b" },
  { tag: t.heading, color: "#1d4ed8", fontWeight: "600" },
  { tag: t.link, color: "#2563eb", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: [t.meta, t.processingInstruction, t.documentMeta], color: "#6b7280" },
  { tag: t.invalid, color: "#b91c1c" },
])

const darkHighlight = HighlightStyle.define([
  { tag: t.comment, color: "#8b95a1", fontStyle: "italic" },
  { tag: [t.tagName, t.standard(t.tagName)], color: "#7aa2ff" },
  { tag: t.attributeName, color: "#c4a7ff" },
  { tag: [t.string, t.attributeValue, t.special(t.string)], color: "#7ee0a2" },
  { tag: [t.number, t.bool, t.null, t.unit], color: "#f0b357" },
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: "#c4a7ff" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "#6fd3c7" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "#e5e7eb" },
  { tag: [t.className, t.typeName, t.namespace], color: "#8ecbff" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "#9ca3af" },
  { tag: t.heading, color: "#7aa2ff", fontWeight: "600" },
  { tag: t.link, color: "#7aa2ff", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: [t.meta, t.processingInstruction, t.documentMeta], color: "#9ca3af" },
  { tag: t.invalid, color: "#f87171" },
])

/** Tema base: cores vindas das CSS vars do Dexter (index.css). */
const dexterTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    lineHeight: "1.6",
  },
  ".cm-content": { padding: "10px 0", caretColor: "var(--primary)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "color-mix(in srgb, var(--muted-foreground) 65%, transparent)",
    border: "none",
    paddingRight: "4px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--primary) 6%, transparent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--primary) 22%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--primary) 18%, transparent)",
    outline: "none",
  },
})

/** `dark` resolvido observando a classe aplicada pelo ThemeProvider no <html>. */
function useResolvedDark(): boolean {
  const [dark, setDark] = React.useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"),
  )

  React.useEffect(() => {
    const target = document.documentElement
    const update = () => setDark(target.classList.contains("dark"))
    update()
    const observer = new MutationObserver(update)
    observer.observe(target, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return dark
}

export interface CodeEditorProps {
  value: string
  language: FormatLanguage
  onChange: (value: string) => void
  /** Ctrl/Cmd+S */
  onSave?: () => void
  /** Shift+Alt+F */
  onFormat?: () => void
  className?: string
  ariaLabel?: string
}

export function CodeEditor({
  value,
  language,
  onChange,
  onSave,
  onFormat,
  className,
  ariaLabel = "Editor de código",
}: CodeEditorProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  const languageCompartment = React.useRef(new Compartment())
  const themeCompartment = React.useRef(new Compartment())
  const isDark = useResolvedDark()

  // Callbacks em refs: os handlers do keymap são criados uma única vez.
  const onChangeRef = React.useRef(onChange)
  const onSaveRef = React.useRef(onSave)
  const onFormatRef = React.useRef(onFormat)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onFormatRef.current = onFormat

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          rectangularSelection(),
          indentOnInput(),
          bracketMatching(),
          indentUnit.of("  "),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.()
                return true
              },
            },
            {
              key: "Shift-Alt-f",
              preventDefault: true,
              run: () => {
                onFormatRef.current?.()
                return true
              },
            },
            indentWithTab,
          ]),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          languageCompartment.current.of(LANGUAGE_EXTENSIONS[language]()),
          themeCompartment.current.of([
            dexterTheme,
            syntaxHighlighting(isDark ? darkHighlight : lightHighlight),
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            onChangeRef.current(update.state.doc.toString())
          }),
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel,
            spellcheck: "false",
          }),
        ],
      }),
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Montagem única: value/language/tema são sincronizados nos effects abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
    })
  }, [value])

  React.useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageCompartment.current.reconfigure(
        LANGUAGE_EXTENSIONS[language](),
      ),
    })
  }, [language])

  React.useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure([
        dexterTheme,
        syntaxHighlighting(isDark ? darkHighlight : lightHighlight),
      ]),
    })
  }, [isDark])

  return (
    <div
      ref={hostRef}
      className={cn(
        "scroll-thin min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-background [&_.cm-editor]:h-full [&_.cm-editor.cm-focused]:outline-none [&_.cm-scroller]:overflow-auto",
        className,
      )}
    />
  )
}
