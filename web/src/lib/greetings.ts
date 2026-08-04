/**
 * Saudações dinâmicas do empty state — horário, dia da semana e easter eggs.
 * `{nome}` vira `, Luis` ou some se não houver nome.
 */

export type GreetingContext = {
  name?: string | null
  now?: Date
}

function primeiroNome(name?: string | null): string | undefined {
  const p = name?.trim().split(/\s+/)[0]
  return p || undefined
}

function periodo(h: number): "madrugada" | "manha" | "tarde" | "noite" {
  if (h < 5) return "madrugada"
  if (h < 12) return "manha"
  if (h < 18) return "tarde"
  return "noite"
}

function applyNome(template: string, nome?: string): string {
  const withName = nome
    ? template.replace(/\{nome\}/g, `, ${nome}`)
    : template.replace(/\{nome\}/g, "")
  return withName.replace(/\s{2,}/g, " ").replace(/\s+([.?!,])/g, "$1").trim()
}

const POR_PERIODO: Record<ReturnType<typeof periodo>, string[]> = {
  madrugada: [
    "Ainda acordado{nome}? Eu também. Em que mando?",
    "Madrugada produtiva{nome}. O que vamos destravar?",
    "Silêncio no escritório{nome} — bom momento pra ir fundo nos dados.",
  ],
  manha: [
    "Bom dia{nome}. Em que posso ajudar?",
    "Bom dia{nome}. Café e um sistema pra consultar?",
    "Bom dia{nome}. Por onde começamos hoje?",
  ],
  tarde: [
    "Boa tarde{nome}. Em que posso ajudar?",
    "Boa tarde{nome}. Tem algum número pra caçar?",
    "Boa tarde{nome}. Qual sistema a gente abre primeiro?",
  ],
  noite: [
    "Boa noite{nome}. Em que posso ajudar?",
    "Boa noite{nome}. Ainda dá tempo de resolver uma coisa.",
    "Boa noite{nome}. Me joga o problema que eu vasculho.",
  ],
}

const GERAIS = [
  "Oi{nome}. O que você precisa agora?",
  "Pronto quando você estiver{nome}.",
  "Pode perguntar feio{nome} — eu vou nos sistemas de verdade.",
  "Sem achismo{nome}: me fala o contexto que eu trago o número.",
  "Em que o Dexter entra hoje{nome}?",
]

const EASTER_EGGS: Array<{
  weight: number
  when?: (d: Date) => boolean
  lines: string[]
}> = [
  {
    weight: 3,
    when: (d) => d.getDay() === 1 && d.getHours() < 12,
    lines: [
      "Segunda{nome}. Respira — a gente resolve um de cada vez.",
      "Segunda de novo{nome}. Qual o primeiro foco?",
    ],
  },
  {
    weight: 3,
    when: (d) => d.getDay() === 5 && d.getHours() >= 15,
    lines: [
      "Sextou{nome}? Uma consulta rápida antes do fim do dia.",
      "Sexta à tarde{nome}. Vamos fechar isso com elegância.",
    ],
  },
  {
    weight: 2,
    when: (d) => d.getDay() === 0 || d.getDay() === 6,
    lines: [
      "Fim de semana e você por aqui{nome}? Respeito. Em que ajudo?",
      "Plantão de sábado/domingo{nome}? Pode mandar.",
    ],
  },
  {
    weight: 2,
    when: (d) => d.getHours() < 5,
    lines: [
      "3 da manhã e o Dexter online{nome}. Isso é compromisso.",
      "Madrugada root{nome}. Só não prometo café.",
    ],
  },
  {
    weight: 1,
    lines: [
      "42 não é a resposta{nome} — mas o NetworkGo talvez seja.",
      "Eu não alucino ticket{nome}. Eu consulto.",
      "Se for lead vazando{nome}, a gente investiga com método.",
      "Dexter mode: ligado. Drama mode: desligado{nome}.",
      "Pode falar “não sei o nome da tabela”{nome}. Eu descubro.",
    ],
  },
]

function pickWeighted<T>(items: T[], weight: (item: T) => number): T {
  const total = items.reduce((s, i) => s + Math.max(0, weight(i)), 0)
  let r = Math.random() * (total || 1)
  for (const item of items) {
    r -= Math.max(0, weight(item))
    if (r <= 0) return item
  }
  return items[items.length - 1]!
}

export function pickGreeting(ctx: GreetingContext = {}): string {
  const now = ctx.now ?? new Date()
  const nome = primeiroNome(ctx.name)

  const eggs = EASTER_EGGS.filter((e) => !e.when || e.when(now))
  if (eggs.length > 0 && Math.random() < 0.18) {
    const egg = pickWeighted(eggs, (e) => e.weight)
    const line = egg.lines[Math.floor(Math.random() * egg.lines.length)]!
    return applyNome(line, nome)
  }

  const pool = [...POR_PERIODO[periodo(now.getHours())], ...GERAIS]
  const raw = pool[Math.floor(Math.random() * pool.length)]!
  return applyNome(raw, nome)
}

export function nextGreeting(
  ctx: GreetingContext,
  current?: string,
  attempts = 10,
): string {
  let next = pickGreeting(ctx)
  for (let i = 0; i < attempts && next === current; i++) {
    next = pickGreeting(ctx)
  }
  return next
}
