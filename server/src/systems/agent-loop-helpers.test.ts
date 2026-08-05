import { describe, expect, it } from "vitest";
import {
  emendarContinuacao,
  fenceAberto,
  isToolResultVazio,
  removerSobreposicao,
  respostaIncompleta,
  toolCallFingerprint,
  truncarToolResultContent,
} from "./agent-loop-helpers.js";

describe("truncarToolResultContent", () => {
  it("devolve o conteúdo intacto quando cabe no limite", () => {
    const json = JSON.stringify({ total_encontrado: 3, linhas: [1, 2, 3] });
    expect(truncarToolResultContent(json, 10_000)).toBe(json);
  });

  it("preserva os agregados do GoDash e descarta a lista grande", () => {
    const linhas = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      nome: `empresa ${i}`.padEnd(80, "x"),
    }));
    const json = JSON.stringify({
      total_encontrado: 4321,
      total_retornado: 200,
      limite_aplicado: 200,
      linhas,
    });
    const out = truncarToolResultContent(json, 1_000);

    expect(out.length).toBeLessThan(json.length);
    expect(out).toContain('"total_encontrado": 4321');
    expect(out).toContain('"total_retornado": 200');
    expect(out).toContain('"limite_aplicado": 200');
    expect(out).toContain("total autoritativo");
    // A lista inteira não pode voltar ao modelo (é o que estourava a janela).
    expect(out).not.toContain("empresa 199");
  });

  it("mantém até 5 linhas de amostra junto dos agregados", () => {
    const json = JSON.stringify({
      total_encontrado: 2,
      linhas: [{ n: "N1234" }, { n: "N5678" }],
      ruido: "y".repeat(5_000),
    });
    const out = truncarToolResultContent(json, 800);
    expect(out).toContain("N1234");
    expect(out).toContain("N5678");
    expect(out).not.toContain("yyyyy");
  });

  it("trunca texto Notion (JSON string) mantendo JSON válido", () => {
    const markdown = "# Base\n" + "conteúdo ".repeat(500);
    const json = JSON.stringify(markdown);
    const out = truncarToolResultContent(json, 1_000);

    expect(out.length).toBeLessThan(json.length);
    const parsed = JSON.parse(out) as string;
    expect(typeof parsed).toBe("string");
    expect(parsed.startsWith("# Base")).toBe(true);
    expect(parsed).toContain("resultado truncado");
  });

  it("nunca colapsa JSON sem agregados em objeto vazio", () => {
    const json = JSON.stringify({
      schema: { propriedades: "z".repeat(3_000) },
    });
    const out = truncarToolResultContent(json, 500);
    expect(out).not.toBe("{}");
    expect(out.startsWith('{"schema"')).toBe(true);
    expect(out).toContain("não refetch o mesmo id");
  });

  it("corta não-JSON no limite e informa quantos chars foram omitidos", () => {
    const texto = "a".repeat(1_200);
    const out = truncarToolResultContent(texto, 1_000);
    expect(out.startsWith("a".repeat(1_000))).toBe(true);
    expect(out).toContain("(200 chars omitidos)");
  });
});

describe("fenceAberto", () => {
  it("detecta bloco de código aberto sem fechamento", () => {
    expect(fenceAberto("texto\n```sql\nselect 1")).toBe(true);
  });

  it("bloco fechado não conta como aberto", () => {
    expect(fenceAberto("```sql\nselect 1\n```\nfim")).toBe(false);
  });

  it("crase no meio da linha não abre bloco", () => {
    expect(fenceAberto("use ```isto``` inline")).toBe(false);
  });
});

describe("removerSobreposicao", () => {
  it("remove o trecho repetido do fim do texto anterior", () => {
    const anterior = "O total de contratos ativos na unidade Paulista é ";
    const cabecalho = "contratos ativos na unidade Paulista é 42.";
    expect(removerSobreposicao(cabecalho, anterior)).toBe("42.");
  });

  it("ignora sobreposição curta demais (menos de 24 chars)", () => {
    const anterior = "linha anterior termina assim: fim";
    const cabecalho = "fim da história";
    expect(removerSobreposicao(cabecalho, anterior)).toBe(cabecalho);
  });

  it("sem sobreposição devolve o cabeçalho intacto", () => {
    expect(removerSobreposicao("continuação nova", "nada em comum")).toBe(
      "continuação nova",
    );
  });
});

describe("emendarContinuacao", () => {
  it("remove o preâmbulo 'Continuando:' da continuação", () => {
    const out = emendarContinuacao("Continuando:\n- item 3", "- item 2\n");
    expect(out).toBe("- item 3");
  });

  it("não reabre o fence quando o bloco anterior ficou aberto", () => {
    const anterior = "```sql\nselect a,\n";
    const out = emendarContinuacao("```sql\n  b from tabela", anterior);
    expect(out).toBe("  b from tabela");
  });

  it("mantém o fence quando o bloco anterior já estava fechado", () => {
    const anterior = "```sql\nselect 1\n```\n";
    const out = emendarContinuacao("```json\n{}", anterior);
    expect(out).toBe("```json\n{}");
  });

  it("preserva a quebra de linha inicial quando a linha anterior ficou aberta", () => {
    // O anterior NÃO termina em \n: o \n da continuação é o que fecha a linha.
    expect(emendarContinuacao("\nlinha nova", "linha cortada")).toBe(
      "\nlinha nova",
    );
  });

  it("descarta o espaçamento inicial quando o anterior já quebrou a linha", () => {
    expect(emendarContinuacao("\n\n  resto", "parágrafo.\n")).toBe("resto");
  });

  it("aplica preâmbulo e sobreposição na mesma emenda", () => {
    const anterior = "A unidade Faria Lima fechou o mês com 128 contratos ";
    const out = emendarContinuacao(
      "Continuando a resposta:\nfechou o mês com 128 contratos ativos.",
      anterior,
    );
    expect(out).toBe("ativos.");
  });
});

describe("respostaIncompleta", () => {
  it("sem tools executadas nunca considera incompleta", () => {
    expect(respostaIncompleta("vou buscar os dados", false)).toBe(false);
  });

  it("texto vazio após tools é incompleto", () => {
    expect(respostaIncompleta("   ", true)).toBe(true);
  });

  it("narração de intenção curta é incompleta", () => {
    expect(respostaIncompleta("Deixa eu puxar os números certos.", true)).toBe(
      true,
    );
  });

  it("reticências sem números é incompleto", () => {
    expect(respostaIncompleta("Consultando a base de contratos…", true)).toBe(
      true,
    );
  });

  it("dossiê com tabela e números é resposta completa", () => {
    const texto = [
      "Encontrei 3 contratos ativos na unidade Paulista.",
      "",
      "| Contrato | Valor |",
      "| --- | --- |",
      "| N1234 | 12.500 |",
      "| N5678 | 8.300 |",
      "",
      "Total apurado: 20.800 no período.",
    ].join("\n");
    expect(respostaIncompleta(texto, true)).toBe(false);
  });

  it("narração longa (>700 chars) não é cortada como preâmbulo", () => {
    const texto = "Vou buscar os dados. " + "Detalhe apurado. ".repeat(60);
    expect(respostaIncompleta(texto, true)).toBe(false);
  });
});

describe("toolCallFingerprint", () => {
  it("é estável para a mesma tool e os mesmos argumentos", () => {
    const a = toolCallFingerprint("godash__sql", { p_sql: "select 1" });
    const b = toolCallFingerprint("godash__sql", { p_sql: "select 1" });
    expect(a).toBe(b);
  });

  it("muda quando os argumentos mudam", () => {
    expect(toolCallFingerprint("t", { id: 1 })).not.toBe(
      toolCallFingerprint("t", { id: 2 }),
    );
  });

  it("muda quando a tool muda com os mesmos argumentos", () => {
    expect(toolCallFingerprint("a", { id: 1 })).not.toBe(
      toolCallFingerprint("b", { id: 1 }),
    );
  });

  it("input nulo/indefinido colapsam no mesmo fingerprint", () => {
    expect(toolCallFingerprint("t", null)).toBe("t::{}");
    expect(toolCallFingerprint("t", undefined)).toBe("t::{}");
  });

  it("argumento circular não lança — cai no marcador '?'", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toolCallFingerprint("t", circular)).toBe("t::?");
  });
});

describe("isToolResultVazio", () => {
  it("null, undefined, array vazio e objeto vazio são vazios", () => {
    expect(isToolResultVazio(null)).toBe(true);
    expect(isToolResultVazio(undefined)).toBe(true);
    expect(isToolResultVazio([])).toBe(true);
    expect(isToolResultVazio({})).toBe(true);
  });

  it("string curta demais é vazia; string útil não é", () => {
    expect(isToolResultVazio("  ok  ")).toBe(true);
    expect(isToolResultVazio("N1234 encontrado")).toBe(false);
  });

  it("resposta MCP sem content nem structuredContent é vazia", () => {
    expect(isToolResultVazio({ content: [] })).toBe(true);
  });

  it("resposta MCP com structuredContent não é vazia", () => {
    expect(
      isToolResultVazio({ content: [], structuredContent: { total: 0 } }),
    ).toBe(false);
  });

  it("agregado zerado não é vazio (zero é resposta válida)", () => {
    expect(isToolResultVazio({ total_encontrado: 0, linhas: [] })).toBe(false);
  });
});
