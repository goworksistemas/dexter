/**
 * Helpers puros. O módulo importa config/supabase no load — setamos env
 * mínimo antes do import dinâmico para não chamar rede nos testes.
 */
import { beforeAll, describe, expect, it } from "vitest";

let normalizeEmail: (email: string) => string;
let emailDomainOf: (email: string) => string | null;
let isAllowedEmailSync: (
  email: string | undefined | null,
  domains: Set<string>,
) => boolean;

beforeAll(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??=
    "test-service-role-key-not-for-production";
  const mod = await import("./email-domain.js");
  normalizeEmail = mod.normalizeEmail;
  emailDomainOf = mod.emailDomainOf;
  isAllowedEmailSync = mod.isAllowedEmailSync;
});

describe("normalizeEmail", () => {
  it("trim + lowercase", () => {
    expect(normalizeEmail("  User@GoWork.COM.BR  ")).toBe("user@gowork.com.br");
  });
});

describe("emailDomainOf", () => {
  it("extrai domínio do e-mail normalizado", () => {
    expect(emailDomainOf("Luis@GoWork.com.br")).toBe("gowork.com.br");
  });

  it("rejeita entradas sem arroba, arroba inicial/final ou vazias", () => {
    expect(emailDomainOf("sem-arroba")).toBeNull();
    expect(emailDomainOf("@gowork.com.br")).toBeNull();
    expect(emailDomainOf("user@")).toBeNull();
    expect(emailDomainOf("")).toBeNull();
  });

  it("rejeita e-mail com mais de um arroba", () => {
    expect(emailDomainOf("a@b@c.com")).toBeNull();
  });
});

describe("isAllowedEmailSync", () => {
  const domains = new Set(["gowork.com.br", "partner.com"]);

  it("aceita e-mail cujo domínio está na lista", () => {
    expect(isAllowedEmailSync("x@gowork.com.br", domains)).toBe(true);
    expect(isAllowedEmailSync("Y@Partner.COM", domains)).toBe(true);
  });

  it("rejeita null/undefined/domínio fora da allowlist", () => {
    expect(isAllowedEmailSync(null, domains)).toBe(false);
    expect(isAllowedEmailSync(undefined, domains)).toBe(false);
    expect(isAllowedEmailSync("a@gmail.com", domains)).toBe(false);
    expect(isAllowedEmailSync("invalido", domains)).toBe(false);
  });
});
