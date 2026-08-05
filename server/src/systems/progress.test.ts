import { describe, expect, it } from "vitest";
import {
  MAX_RESUMO,
  contarLinhas,
  resumirArgs,
  resumirResultado,
  truncar,
} from "./progress.js";

describe("truncar", () => {
  it("devolve texto curto sem alterar o sentido (só colapsa whitespace)", () => {
    expect(truncar("  oi   mundo  ")).toBe("oi mundo");
  });

  it("não corta quando o comprimento fica exatamente no limite", () => {
    const texto = "a".repeat(MAX_RESUMO);
    expect(truncar(texto)).toBe(texto);
    expect(truncar(texto).endsWith("…")).toBe(false);
  });

  it("corta no limite e termina com reticências", () => {
    const texto = "a".repeat(MAX_RESUMO + 10);
    const out = truncar(texto);
    expect(out.length).toBe(MAX_RESUMO);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, MAX_RESUMO - 1)).toBe("a".repeat(MAX_RESUMO - 1));
  });

  it("respeita max customizado", () => {
    expect(truncar("abcdefghij", 5)).toBe("abcd…");
  });

  it("colapsa quebras de linha e tabs antes de medir", () => {
    expect(truncar("a\nb\tc")).toBe("a b c");
  });

  it("string vazia / só whitespace vira vazia", () => {
    expect(truncar("")).toBe("");
    expect(truncar("   \n\t  ")).toBe("");
  });
});

describe("resumirArgs", () => {
  it("omite p_email e coloca p_sql primeiro", () => {
    const out = resumirArgs({
      p_email: "user@gowork.com.br",
      p_limit: 10,
      p_sql: "SELECT 1",
    });
    expect(out).toBeDefined();
    expect(out!.startsWith("SELECT 1")).toBe(true);
    expect(out).toContain("limit=10");
    expect(out).not.toContain("gowork");
    expect(out).not.toContain("p_email");
    expect(out).not.toContain("email=");
  });

  it("remove prefixo p_ das chaves restantes", () => {
    expect(resumirArgs({ p_system: "pipego", p_q: "x" })).toBe(
      "system=pipego · q=x",
    );
  });

  it("ignora null, undefined e string vazia", () => {
    expect(
      resumirArgs({ p_sql: "SELECT 1", p_a: null, p_b: undefined, p_c: "" }),
    ).toBe("SELECT 1");
  });

  it("devolve undefined para não-objeto / objeto vazio / só p_email", () => {
    expect(resumirArgs(null)).toBeUndefined();
    expect(resumirArgs(undefined)).toBeUndefined();
    expect(resumirArgs("sql")).toBeUndefined();
    expect(resumirArgs(42)).toBeUndefined();
    expect(resumirArgs([])).toBeUndefined();
    expect(resumirArgs({})).toBeUndefined();
    expect(resumirArgs({ p_email: "a@b.com" })).toBeUndefined();
  });

  it("serializa objetos aninhados de forma truncada", () => {
    const out = resumirArgs({ filtro: { a: 1, b: "x".repeat(200) } });
    expect(out).toMatch(/^filtro=/);
    expect(out!.length).toBeLessThanOrEqual(MAX_RESUMO);
  });
});

describe("contarLinhas", () => {
  it("usa length de array raiz", () => {
    expect(contarLinhas([1, 2, 3])).toBe(3);
  });

  it("prioriza campos de total numéricos", () => {
    expect(contarLinhas({ total_encontrado: 7, rows: [1, 2] })).toBe(7);
    expect(contarLinhas({ total: 2, items: [1] })).toBe(2);
    expect(contarLinhas({ count: 0 })).toBe(0);
  });

  it("cai no length do primeiro array aninhado", () => {
    expect(contarLinhas({ meta: {}, rows: ["a", "b"] })).toBe(2);
  });

  it("devolve undefined quando não dá para inferir", () => {
    expect(contarLinhas(null)).toBeUndefined();
    expect(contarLinhas("x")).toBeUndefined();
    expect(contarLinhas({ ok: true })).toBeUndefined();
  });
});

describe("resumirResultado", () => {
  it("em erro usa a mensagem truncada", () => {
    expect(resumirResultado({ ok: false, error: "boom" }).summary).toBe("boom");
    expect(resumirResultado({ ok: false }).summary).toBe("falhou");
  });

  it("marca retorno nulo/ausente", () => {
    expect(resumirResultado({ ok: true }).summary).toBe("sem retorno");
    expect(resumirResultado({ ok: true, output: null }).summary).toBe(
      "sem retorno",
    );
  });

  it("detecta erro do banco embutido no output", () => {
    expect(
      resumirResultado({ ok: true, output: { erro: "timeout" } }).summary,
    ).toBe("erro do banco: timeout");
  });

  it("resume por quantidade de linhas com pluralização", () => {
    expect(resumirResultado({ ok: true, output: [1] })).toEqual({
      summary: "1 linha",
      rows: 1,
    });
    expect(resumirResultado({ ok: true, output: [1, 2] })).toEqual({
      summary: "2 linhas",
      rows: 2,
    });
  });

  it("lista campos quando não há linhas inferíveis", () => {
    expect(
      resumirResultado({ ok: true, output: { a: 1, b: 2 } }).summary,
    ).toBe("campos: a, b");
  });

  it("resume primitivos com valorCurto", () => {
    expect(resumirResultado({ ok: true, output: "ok" }).summary).toBe("ok");
    expect(resumirResultado({ ok: true, output: 42 }).summary).toBe("42");
  });
});
