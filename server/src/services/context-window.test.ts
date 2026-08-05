import { describe, expect, it } from "vitest";
import { aplicarJanela, indiceInicioJanela } from "./context-window.js";

/** Conversa alternada user/assistant com `pares` turnos completos. */
function conversa(pares: number): Array<{ role: string; id: string }> {
  const out: Array<{ role: string; id: string }> = [];
  for (let i = 0; i < pares; i++) {
    out.push({ role: "user", id: `u${i}` });
    out.push({ role: "assistant", id: `a${i}` });
  }
  return out;
}

describe("indiceInicioJanela", () => {
  it("histórico menor que o limite não corta nada", () => {
    expect(indiceInicioJanela(conversa(3), 12)).toBe(0);
  });

  it("histórico do tamanho exato do limite não corta", () => {
    expect(indiceInicioJanela(conversa(6), 12)).toBe(0);
  });

  it("corta as mensagens mais antigas acima do limite", () => {
    // 16 mensagens, limite 12 → começa na 5ª (índice 4), que é do usuário.
    expect(indiceInicioJanela(conversa(8), 12)).toBe(4);
  });

  it("avança até a próxima mensagem do usuário quando o corte cai no assistente", () => {
    // 15 mensagens (a última do usuário) com limite 12 → corte natural no
    // índice 3 (assistant), que precisa avançar para o 4 (user).
    const historico = [...conversa(7), { role: "user", id: "u7" }];
    expect(historico[3]!.role).toBe("assistant");
    expect(indiceInicioJanela(historico, 12)).toBe(4);
  });

  it("histórico só de assistente colapsa a janela (nada começa com user)", () => {
    const historico = [
      { role: "assistant", id: "a0" },
      { role: "assistant", id: "a1" },
    ];
    expect(indiceInicioJanela(historico, 1)).toBe(2);
  });

  it("histórico vazio devolve 0", () => {
    expect(indiceInicioJanela([], 12)).toBe(0);
  });
});

describe("aplicarJanela", () => {
  it("sinaliza cortou=false e devolve tudo quando cabe", () => {
    const historico = conversa(2);
    const janela = aplicarJanela(historico, 12);
    expect(janela.cortou).toBe(false);
    expect(janela.mensagens).toHaveLength(4);
  });

  it("sinaliza cortou=true e a janela começa numa mensagem do usuário", () => {
    const janela = aplicarJanela(conversa(10), 12);
    expect(janela.cortou).toBe(true);
    expect(janela.mensagens).toHaveLength(12);
    expect(janela.mensagens[0]!.role).toBe("user");
    expect(janela.mensagens[0]!.id).toBe("u4");
  });

  it("o que sobra fora da janela é o complemento exato do índice de corte", () => {
    const historico = conversa(10);
    const inicio = indiceInicioJanela(historico, 12);
    const janela = aplicarJanela(historico, 12);
    // É essa igualdade que faz o resumo rolling cobrir exatamente o trecho
    // que o system prompt deixou de fora.
    expect(historico.slice(0, inicio).length + janela.mensagens.length).toBe(
      historico.length,
    );
    expect(historico.slice(0, inicio).at(-1)!.id).toBe("a3");
  });
});
