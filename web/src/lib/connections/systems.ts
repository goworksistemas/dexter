/**
 * Metadados de apresentação dos sistemas GoWork no UI de conexões.
 * Slugs alinhados com `server/src/systems/registry.ts`.
 */

export type SystemPresentation = {
  /** Frase curta do que o sistema faz (não o slug técnico). */
  blurb: string
  /** Iniciais para avatar quando não há logo. */
  initials: string
  /** Cor de marca (fallback do avatar / acento). */
  color: string
  /** Logo em `/public/systems/...`, se existir. */
  logoSrc?: string
}

const SYSTEMS: Record<string, SystemPresentation> = {
  networkgo: {
    blurb: "Facilities — tickets, OS, reservas e satisfação",
    initials: "NG",
    color: "#3F76FF",
    logoSrc: "/systems/networkgo.png",
  },
  pipego: {
    blurb: "Cobrança, jornadas, obras e contas a receber",
    initials: "PG",
    color: "#00B9DD",
    logoSrc: "/systems/pipego.png",
  },
  godash: {
    blurb: "Funil comercial, financeiro e indicadores",
    initials: "GD",
    color: "#0EA5E9",
    logoSrc: "/systems/godash.svg",
  },
  mensurego: {
    blurb: "RH, férias, onboarding e medições",
    initials: "MG",
    color: "#249689",
    logoSrc: "/systems/mensurego.svg",
  },
  checkgo: {
    blurb: "Checklists, vistorias e conformidade",
    initials: "CG",
    color: "#2563EB",
    logoSrc: "/systems/checkgo.svg",
  },
  expertgo: {
    blurb: "CRM — deals, funil e atividades",
    initials: "EG",
    color: "#E67E22",
  },
  supplygo: {
    blurb: "Compras, fornecedores e vendas ML",
    initials: "SG",
    color: "#0D9488",
  },
  qrapido: {
    blurb: "Chamados via QR e status de locais",
    initials: "QR",
    color: "#4F46E5",
    logoSrc: "/systems/qrapido.svg",
  },
  sugestoes: {
    blurb: "Ideias e melhorias dos sistemas GoWork",
    initials: "SM",
    color: "#00C5E9",
    logoSrc: "/systems/sugestoes.png",
  },
}

const FALLBACK: SystemPresentation = {
  blurb: "Sistema GoWork conectado ao Dexter",
  initials: "GO",
  color: "#3F76FF",
}

export function getSystemPresentation(slug: string): SystemPresentation {
  return SYSTEMS[slug] ?? {
    ...FALLBACK,
    initials: slug.slice(0, 2).toUpperCase() || "GO",
  }
}
