/**
 * Cotação USD→BRL para o web exibir custos em reais.
 *
 * Os custos são gravados em USD (é a moeda dos providers e a única que permite
 * auditoria contra a fatura). A conversão para BRL é só apresentação, então a
 * cotação vive aqui: cache em memória de 1h e fallback constante quando a API
 * pública está fora — nunca deixamos o endpoint de modelos falhar por câmbio.
 *
 * Fonte: AwesomeAPI (`economia.awesomeapi.com.br`) — pública, sem chave e sem
 * dependência nova (fetch nativo do Node 22).
 */

const AWESOME_API_URL = "https://economia.awesomeapi.com.br/json/last/USD-BRL"

/**
 * Usado quando a API está inacessível. Não é cotação real: é a ordem de
 * grandeza do dólar para o valor em tela continuar plausível (melhor mostrar
 * "≈ R$ 0,03" com câmbio aproximado do que esconder o custo do usuário).
 */
const FALLBACK_USD_BRL = 5.5

/** Cotação boa por 1h — câmbio intradiário não muda a decisão de ninguém. */
const CACHE_TTL_MS = 60 * 60 * 1_000

/** Falhou: tenta de novo em 5min em vez de segurar o fallback por 1h inteira. */
const CACHE_TTL_ERRO_MS = 5 * 60 * 1_000

/** A rota de modelos não pode ficar pendurada esperando câmbio. */
const TIMEOUT_MS = 4_000

/** Faixa sanitária: fora dela o payload da API mudou e o número não serve. */
const MIN_RATE = 1
const MAX_RATE = 100

/**
 * Formato real da resposta (conferido em chamada ao endpoint):
 * `{"USDBRL":{"code":"USD","codein":"BRL","bid":"5.1197","ask":"5.1251",...}}`
 * Todos os números vêm como string.
 */
interface AwesomeApiResposta {
  USDBRL?: {
    bid?: string
    ask?: string
  }
}

interface CotacaoCache {
  rate: number
  /** false = veio do FALLBACK_USD_BRL (API fora). */
  live: boolean
  expiresAt: number
}

let cache: CotacaoCache | null = null
/** Requisição em voo — evita N chamadas simultâneas na expiração do cache. */
let emVoo: Promise<CotacaoCache> | null = null

function parseRate(valor: string | undefined): number | null {
  if (!valor) return null
  const n = Number.parseFloat(valor)
  if (!Number.isFinite(n) || n < MIN_RATE || n > MAX_RATE) return null
  return n
}

async function buscarCotacao(): Promise<CotacaoCache> {
  const agora = Date.now()
  try {
    const res = await fetch(AWESOME_API_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    })
    if (!res.ok) throw new Error(`AwesomeAPI respondeu ${res.status}`)
    const body = (await res.json()) as AwesomeApiResposta
    // `ask` é o preço de venda do dólar: converter um custo A PAGAR pela venda
    // é o lado conservador. `bid` só entra se a API omitir o ask.
    const rate = parseRate(body.USDBRL?.ask) ?? parseRate(body.USDBRL?.bid)
    if (rate == null) throw new Error("cotação ausente ou fora da faixa")
    return { rate, live: true, expiresAt: agora + CACHE_TTL_MS }
  } catch {
    return {
      rate: FALLBACK_USD_BRL,
      live: false,
      expiresAt: agora + CACHE_TTL_ERRO_MS,
    }
  }
}

/** Cotação atual (cache 1h). Nunca rejeita: no pior caso devolve o fallback. */
export async function getUsdBrlRate(): Promise<number> {
  const info = await getUsdBrlRateInfo()
  return info.rate
}

/** Igual a `getUsdBrlRate`, com a origem do número (para log/diagnóstico). */
export async function getUsdBrlRateInfo(): Promise<{
  rate: number
  live: boolean
}> {
  const atual = cache
  if (atual && atual.expiresAt > Date.now()) {
    return { rate: atual.rate, live: atual.live }
  }
  emVoo ??= buscarCotacao().then((novo) => {
    cache = novo
    emVoo = null
    return novo
  })
  const resultado = await emVoo
  return { rate: resultado.rate, live: resultado.live }
}

export { FALLBACK_USD_BRL }
