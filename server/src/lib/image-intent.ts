/**
 * Intenção de geração/edição de imagem — evita gastar cota em mensagem de chat
 * quando o seletor está num modelo só-imagem (e o inverso no chat).
 */
import type { ModelInfo } from "../llm/models.js"
import { isImageGenerationModel } from "../llm/capabilities.js"

export type ImageIntent = "generate" | "chat" | "clarify"

export interface ImageIntentResult {
  intent: ImageIntent
  /** 0–1 */
  confidence: number
  reason: string
}

const RE_CHAT_STRONG =
  /\b(conversa|conversar|conversando|fale comigo|fala comigo|podemos conversar|você conversa|vc conversa|consegue conversar|pode conversar|é um chat|modo chat|só conversar|apenas conversar|quem (é|eh) (você|voce)|o que (você|voce) (faz|é|eh)|como (você|voce) funciona|me explica|explica(?:r)?|explique|por\s*qu[eê]|porque|o que é|o que sao|diferença entre|ajuda com|debug|código|codigo|sql|api|erro\b|bug\b)\b/i

const RE_CHAT_GREETING =
  /^(oi|olá|ola|hey|hi|hello|bom dia|boa tarde|boa noite|e aí|eai|fala)\b/i

const RE_GENERATE_VERB =
  /\b(gera(?:r|ção)?|gere|crie|criar|cria|desenhe|desenhar|ilustre|ilustrar|pinte|pintar|renderiz(?:e|ar)|faça|faz(?:er)?|mostre|mostrar|transforme|edite|editar|modifique|modificar|altere|alterar|generate|draw|paint|render|illustrate|create an? image|make an? image|edit (?:this|the) image)\b/i

const RE_IMAGE_NOUN =
  /\b(imagem(?:s)?|image(?:s)?|foto(?:s)?|picture(?:s)?|ilustra[cç][aã]o(?:ões)?|illustration(?:s)?|artwork|wallpaper|banner|logo|pôster|poster|retrato|portrait|cena|scene|concept art)\b/i

const RE_QUESTION = /\?/

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Pedido claro de *saída* imagem (para redirecionar fora do modelo de chat).
 * Não pega "gere um resumo" / "faça um SQL".
 */
export function isImageOutputRequest(
  raw: string,
  opts: { hasImageReferences?: boolean } = {},
): boolean {
  const text = normalize(raw)
  if (opts.hasImageReferences && text && !RE_CHAT_STRONG.test(text)) {
    return true
  }
  if (!text) return false
  if (RE_CHAT_STRONG.test(text) && !RE_GENERATE_VERB.test(text)) return false
  if (/\b(desenhe|desenhar|ilustre|ilustrar|pinte|pintar)\b/i.test(text)) {
    return true
  }
  if (RE_IMAGE_NOUN.test(text) && (RE_GENERATE_VERB.test(text) || !RE_QUESTION.test(text))) {
    return true
  }
  if (
    RE_GENERATE_VERB.test(text) &&
    /\b(superman|batman|logo|banner|wallpaper|retrato|portrait|scene|cena)\b/i.test(
      text,
    )
  ) {
    return true
  }
  return false
}

/**
 * Classifica se a mensagem pede geração/edição de imagem ou é conversa.
 * Com referência anexada, tende a "generate" (edição) salvo chat explícito.
 */
export function classifyImageIntent(
  raw: string,
  opts: { hasImageReferences?: boolean } = {},
): ImageIntentResult {
  const text = normalize(raw)
  const hasRefs = Boolean(opts.hasImageReferences)

  if (!text && hasRefs) {
    return {
      intent: "clarify",
      confidence: 0.7,
      reason: "referencia_sem_instrucao",
    }
  }
  if (!text) {
    return { intent: "chat", confidence: 0.9, reason: "vazio" }
  }

  const chatStrong = RE_CHAT_STRONG.test(text) || RE_CHAT_GREETING.test(text)
  const genVerb = RE_GENERATE_VERB.test(text)
  const imageNoun = RE_IMAGE_NOUN.test(text)
  const question = RE_QUESTION.test(text)

  // Conversa explícita — nunca gastar cota de imagem.
  if (chatStrong && !genVerb) {
    return { intent: "chat", confidence: 0.92, reason: "conversa_explicita" }
  }

  // "você gera imagens?" — pergunta sobre capacidade, não pedido.
  if (
    question &&
    imageNoun &&
    /\b(consegue|pode|sab[ei]|você|voce|vc)\b/i.test(text) &&
    !genVerb
  ) {
    return { intent: "chat", confidence: 0.85, reason: "pergunta_capacidade" }
  }

  if (genVerb && imageNoun) {
    return { intent: "generate", confidence: 0.95, reason: "verbo_e_imagem" }
  }
  // Verbo sozinho ("gere um resumo") NÃO é imagem — precisa substantivo visual
  // ou verbo tipicamente gráfico.
  if (
    genVerb &&
    /\b(desenhe|desenhar|ilustre|ilustrar|pinte|pintar|draw|paint|render)\b/i.test(
      text,
    )
  ) {
    return { intent: "generate", confidence: 0.9, reason: "verbo_grafico" }
  }
  const looksLikeDocTask =
    /\b(resumo|relat[oó]rio|texto|sql|c[oó]digo|codigo|lista|plano|e-?mail|email|documento|pdf|planilha)\b/i.test(
      text,
    )

  // "gere um resumo" / tarefas de texto — nunca imagem.
  if (genVerb && looksLikeDocTask && !imageNoun) {
    return { intent: "chat", confidence: 0.9, reason: "tarefa_texto" }
  }

  // "uma imagem de Superman", "foto de um gato" — sem verbo, sem pergunta.
  if (imageNoun && !question) {
    return { intent: "generate", confidence: 0.78, reason: "pedido_imagem" }
  }
  // "gere o Superman" / assunto visual curto com verbo de criação.
  if (genVerb && !question && text.length <= 160 && !looksLikeDocTask) {
    return { intent: "generate", confidence: 0.7, reason: "verbo_assunto" }
  }

  // Referência + instrução de edição ("coloque um chapéu", "deixe noturno").
  if (hasRefs && !chatStrong) {
    if (question && text.length < 40 && !genVerb) {
      return { intent: "clarify", confidence: 0.6, reason: "ref_ambigua" }
    }
    return {
      intent: "generate",
      confidence: 0.8,
      reason: "edicao_com_referencia",
    }
  }

  // Assunto curto tipo caption ("superman voando", "gato laranja no sofá").
  if (
    !question &&
    !chatStrong &&
    !genVerb &&
    !looksLikeDocTask &&
    text.length >= 3 &&
    text.length <= 160 &&
    !/\b(obrigado|valeu|ok|certo|entendi|sim|não|nao)\b/i.test(text)
  ) {
    if (!/\b(liste|mostre os|qual modelo|trocar modelo)\b/i.test(text)) {
      return {
        intent: "generate",
        confidence: 0.62,
        reason: "assunto_visual",
      }
    }
  }

  if (question || chatStrong) {
    return { intent: "chat", confidence: 0.7, reason: "pergunta_ou_chat" }
  }

  return { intent: "clarify", confidence: 0.55, reason: "ambiguo" }
}

/** Enriquece o prompt sem LLM — estrutura clara, sem inventar o assunto. */
export function enrichImagePrompt(userPrompt: string): string {
  const base = normalize(userPrompt)
  if (!base) return "Imagem detalhada, alta qualidade, iluminação coerente."

  // Já parece um prompt elaborado — não empilhar lero-lero.
  if (base.length > 220 || /\b(estilo|lighting|photoreal|8k|composition)\b/i.test(base)) {
    return base
  }

  return [
    base,
    "",
    "Diretrizes (não alterar o assunto pedido): composição clara, detalhes nítidos, iluminação coerente, sem texto na imagem salvo se o pedido pedir legendas.",
  ].join("\n")
}

export function listImageGenModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter(
    (m) =>
      m.enabled !== false &&
      (m.capabilities.imageGeneration ||
        isImageGenerationModel(m.provider, m.model)),
  )
}

export function listChatModels(models: ModelInfo[], limit = 6): ModelInfo[] {
  return models
    .filter(
      (m) =>
        m.enabled !== false &&
        !m.capabilities.imageGeneration &&
        !isImageGenerationModel(m.provider, m.model),
    )
    .slice(0, limit)
}

function formatModelLine(m: ModelInfo): string {
  const provider =
    m.provider === "gemini"
      ? "Gemini"
      : m.provider === "openai"
        ? "OpenAI"
        : m.provider === "anthropic"
          ? "Anthropic"
          : m.provider
  return `- **${m.label}** (${provider})`
}

/** Resposta quando o usuário está no modelo de imagem mas não pediu imagem. */
export function replyOnImageModelButChat(
  currentLabel: string,
  chatModels: ModelInfo[],
  classification: ImageIntentResult,
): string {
  const chats = chatModels.length
    ? chatModels.map(formatModelLine).join("\n")
    : "- Qualquer modelo de chat no seletor (Claude, GPT, Gemini texto)"

  if (classification.intent === "clarify") {
    return [
      `Você está no modelo de imagem **${currentLabel}**.`,
      "",
      "Não ficou claro se quer **gerar/editar uma imagem** ou só **conversar**.",
      "",
      "- Para gerar: descreva a cena (ex.: *gere um Superman voando sobre Metrópolis ao entardecer*).",
      "- Com foto anexada: diga o que mudar (ex.: *deixe o fundo noturno*).",
      "- Para conversar: troque no seletor para um modelo de chat, por exemplo:",
      chats,
    ].join("\n")
  }

  return [
    `Este modelo (**${currentLabel}**) só **gera ou edita imagens** — não é chat.`,
    "",
    "Para conversar ou tirar dúvidas, escolha um modelo de texto no seletor, por exemplo:",
    chats,
    "",
    "Se a intenção era imagem, descreva o que gerar (ex.: *gere a imagem de um Superman em estilo comic*).",
  ].join("\n")
}

/** Resposta quando pediu imagem num modelo de chat. */
export function replyNeedImageModel(
  currentLabel: string,
  imageModels: ModelInfo[],
  userPrompt: string,
): string {
  const list = imageModels.length
    ? imageModels.slice(0, 10).map(formatModelLine).join("\n")
    : "- Nenhum modelo de imagem habilitado no admin agora."

  const hint = normalize(userPrompt)
  const promptHint =
    hint.length > 0 && hint.length < 300
      ? `\n\nPrompt sugerido (copie após trocar o modelo):\n> ${hint}`
      : ""

  return [
    `Você pediu uma **imagem**, mas o modelo atual (**${currentLabel}**) é de **chat** e não gera imagens aqui.`,
    "",
    "No seletor, escolha um modelo com a tag **Gerar imagem**, por exemplo:",
    list,
    "",
    "Depois envie de novo a descrição (ou anexe uma referência para editar)." +
      promptHint,
  ].join("\n")
}
