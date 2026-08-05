import { describe, expect, it } from "vitest";
import {
  ARTIFACT_APPENDIX_MARKER,
  ARTIFACT_INJECT_MAX_CHARS,
  formatArtifactsSystemBlock,
  selectArtifactsForContext,
  stripArtifactAppendix,
  type ArtifactWire,
} from "./artifacts-context.js";

function art(
  partial: Partial<ArtifactWire> & Pick<ArtifactWire, "kind" | "content">,
): ArtifactWire {
  return {
    title: partial.title ?? "Doc",
    version: partial.version ?? 1,
    ...partial,
  };
}

describe("stripArtifactAppendix", () => {
  it("remove o apêndice a partir do marker e trimEnd", () => {
    const base = "mensagem do usuário  ";
    const full = base + ARTIFACT_APPENDIX_MARKER + "\n### html\n...";
    expect(stripArtifactAppendix(full)).toBe("mensagem do usuário");
  });

  it("mantém conteúdo intacto quando não há marker", () => {
    expect(stripArtifactAppendix("só texto")).toBe("só texto");
  });

  it("se o marker estiver no início, sobra string vazia", () => {
    expect(stripArtifactAppendix(ARTIFACT_APPENDIX_MARKER + "x")).toBe("");
  });
});

describe("selectArtifactsForContext", () => {
  it("deduplica por kind pegando a maior versão", () => {
    const out = selectArtifactsForContext([
      art({ kind: "html", content: "<html></html>", version: 1, title: "v1" }),
      art({
        kind: "html",
        content: "<html>novo</html>",
        version: 3,
        title: "v3",
      }),
      art({
        kind: "html",
        content: "<html>meio</html>",
        version: 2,
        title: "v2",
      }),
      art({ kind: "markdown", content: "# md", version: 1, title: "md" }),
    ]);
    expect(out).toHaveLength(2);
    const html = out.find((a) => a.kind === "html")!;
    expect(html.version).toBe(3);
    expect(html.title).toBe("v3");
    expect(html.content).toContain("novo");
  });

  it("marca is_truncated quando a flag já vem true", () => {
    const [a] = selectArtifactsForContext([
      art({ kind: "markdown", content: "# ok", is_truncated: true }),
    ]);
    expect(a!.is_truncated).toBe(true);
  });

  it("detecta HTML truncado sem fechamento html", () => {
    const [a] = selectArtifactsForContext([
      art({
        kind: "html",
        content: "<!DOCTYPE html><html><body><h1>Oi",
      }),
    ]);
    expect(a!.is_truncated).toBe(true);
  });

  it("detecta HTML truncado sem fechamento body", () => {
    const [a] = selectArtifactsForContext([
      art({
        kind: "html",
        content: "<html><body><p>x</p>",
      }),
    ]);
    expect(a!.is_truncated).toBe(true);
  });

  it("detecta tag HTML cortada no fim", () => {
    const [a] = selectArtifactsForContext([
      art({ kind: "html", content: '<div class="x"' }),
    ]);
    expect(a!.is_truncated).toBe(true);
  });

  it("detecta fence markdown aberta no fim", () => {
    const [a] = selectArtifactsForContext([
      art({ kind: "markdown", content: "# t\n\n```html" }),
    ]);
    expect(a!.is_truncated).toBe(true);
  });

  it("não marca HTML completo como truncado", () => {
    const [a] = selectArtifactsForContext([
      art({
        kind: "html",
        content: "<html><body><p>ok</p></body></html>",
      }),
    ]);
    expect(a!.is_truncated).toBe(false);
  });

  it("conteúdo vazio conta como truncado", () => {
    const [a] = selectArtifactsForContext([
      art({ kind: "markdown", content: "   " }),
    ]);
    expect(a!.is_truncated).toBe(true);
  });

  it("trunca conteúdo acima de ARTIFACT_INJECT_MAX_CHARS e sinaliza no texto", () => {
    const huge = "x".repeat(ARTIFACT_INJECT_MAX_CHARS + 50);
    const [a] = selectArtifactsForContext([
      art({ kind: "markdown", content: huge }),
    ]);
    expect(a!.content.length).toBeGreaterThan(ARTIFACT_INJECT_MAX_CHARS);
    expect(a!.content.startsWith("x".repeat(ARTIFACT_INJECT_MAX_CHARS))).toBe(
      true,
    );
    expect(a!.content).toContain("[…conteúdo truncado para o prompt");
    expect(a!.is_truncated).toBe(false);
  });
});

describe("formatArtifactsSystemBlock", () => {
  it("retorna null para lista vazia", () => {
    expect(formatArtifactsSystemBlock([])).toBeNull();
  });

  it("monta bloco com regras e fence do kind", () => {
    const block = formatArtifactsSystemBlock([
      art({
        kind: "html",
        title: "Landing",
        version: 2,
        content: "<html></html>",
      }),
    ]);
    expect(block).toContain("## Artefatos da conversa");
    expect(block).toContain("### Landing (html, v2)");
    expect(block).toContain("```html\n<html></html>\n```");
    expect(block).toContain("### Landing (html, v2)\n");
    expect(block).not.toContain(", INCOMPLETO");
  });

  it("inclui flag INCOMPLETO quando truncado", () => {
    const block = formatArtifactsSystemBlock([
      art({
        kind: "html",
        title: "X",
        content: "<html><body>cortado",
      }),
    ]);
    expect(block).toContain("INCOMPLETO");
  });
});
