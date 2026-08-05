/**
 * "≈ R$ 0,03 por mensagem" no rodapé do composer.
 *
 * Cálculo 100% local (ver `@/lib/models/cost-estimate`): usa o texto digitado, o
 * histórico que a thread já carregou e o preço do modelo que veio em
 * `GET /api/models`. Nenhuma requisição extra. Só aparece quando o modelo
 * escolhido tem preço conhecido e há texto no campo.
 *
 * O recálculo é em tempo real, a cada tecla e a cada troca de modelo: a conta
 * é aritmética simples sobre uma janela de no máximo 12 mensagens, então não
 * precisa de debounce. Para o layout não pular, o elemento fica sempre montado
 * (com a largura do valor) e só transiciona a opacidade quando o campo
 * esvazia/enche.
 */
import { useMemo } from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  estimarCustoMensagem,
  formatBRL,
  rateHint,
  useUsdBrlRate,
  type MensagemHistorico,
  type ModelInfo,
} from "@/lib/models"
import { cn } from "@/lib/utils"

function fmtTokens(n: number): string {
  return new Intl.NumberFormat("pt-BR").format(n)
}

export function CostEstimateHint({
  texto,
  historico,
  model,
  className,
}: {
  texto: string
  /** Mensagens já carregadas da conversa, em ordem cronológica. */
  historico: MensagemHistorico[]
  model?: ModelInfo
  className?: string
}) {
  const rate = useUsdBrlRate()
  const temTexto = texto.trim().length > 0

  const estimativa = useMemo(() => {
    if (!model) return null
    return estimarCustoMensagem({
      texto,
      historico,
      inputUsdPerMillion: model.inputUsdPerMillion,
      outputUsdPerMillion: model.outputUsdPerMillion,
    })
  }, [model, texto, historico])

  if (!estimativa) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "cursor-default whitespace-nowrap text-[11px] tabular-nums text-muted-foreground/80 transition-[color,opacity] duration-200 hover:text-muted-foreground",
            temTexto ? "opacity-100" : "pointer-events-none opacity-0",
            className,
          )}
          aria-hidden={!temTexto}
          aria-label={`Custo estimado desta mensagem: ${formatBRL(estimativa.usd, rate)}`}
        >
          ≈ {formatBRL(estimativa.usd, rate)} por mensagem
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 space-y-1 px-3 py-2 text-xs">
        <p className="font-medium text-background">Estimativa, não cobrança</p>
        <p className="text-background/80">
          Entrada ≈ {fmtTokens(estimativa.tokensEntrada)} tokens:{" "}
          {fmtTokens(estimativa.tokensSystem)} de instruções e ferramentas,{" "}
          {fmtTokens(estimativa.tokensHistorico)} do histórico reenviado e{" "}
          {fmtTokens(estimativa.tokensDigitado)} do que você escreveu.
        </p>
        <p className="text-background/80">
          Saída ≈ {fmtTokens(estimativa.tokensSaida)} tokens{" "}
          {estimativa.saidaMedida
            ? "(média real das respostas desta conversa)."
            : "(média típica — esta conversa ainda não tem resposta medida)."}
        </p>
        <p className="text-background/70">
          O valor real varia com o tamanho da resposta e com as ferramentas que o
          Dexter usar. {rateHint(rate)}
        </p>
      </TooltipContent>
    </Tooltip>
  )
}
