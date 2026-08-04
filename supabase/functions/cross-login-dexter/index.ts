/**
 * Cross-login NetworkGo -> Dexter.
 *
 * O front do NetworkGo (logado) faz POST { access_token } aqui; a funcao valida o
 * token no projeto Supabase do NetworkGo, confirma que o mesmo e-mail ja existe no
 * Dexter e devolve um magic link (action_link) para redirecionar o browser.
 *
 * NAO auto-provisiona usuarios. Atencao: generateLink({ type: 'magiclink' }) CRIA
 * o usuario caso nao exista (comportamento documentado do Supabase). Por isso a
 * existencia e checada ANTES via RPC check_user_exists_by_email; se o e-mail nao
 * existir no Dexter, retorna 404 e o generateLink nunca e chamado.
 *
 * Depende da RPC public.check_user_exists_by_email(text)
 * (migration 0019_check_user_exists_by_email.sql).
 *
 * Config: NETWORKGO_SUPABASE_URL / NETWORKGO_SUPABASE_ANON_KEY podem ser
 * sobrescritos via secrets; os defaults abaixo sao valores PUBLICOS do
 * NetworkGo (URL do projeto + publishable key, a mesma que vai no bundle
 * do browser). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sao injetados
 * automaticamente pelo runtime.
 *
 * Deploy: supabase functions deploy cross-login-dexter --no-verify-jwt
 * (a autenticacao e feita aqui dentro, validando o access_token do NetworkGo;
 * o front chama sem header Authorization, como nas demais cross-login)
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
}

const DEXTER_HOME = 'https://dexter.gowork.com.br/'

// Defaults publicos do NetworkGo (projeto qgtbxeobqlyptevsckjp); a publishable
// key e publica por definicao (vai no bundle do front do NetworkGo).
const NETWORKGO_URL_DEFAULT = 'https://qgtbxeobqlyptevsckjp.supabase.co'
const NETWORKGO_PUBLISHABLE_KEY_DEFAULT = 'sb_publishable_npAPMTijFS93Gfw53pICgA_JEwD3vzT'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }

  try {
    const { access_token } = await req.json()

    if (!access_token) {
      return new Response(JSON.stringify({ error: 'Token nao fornecido' }), {
        status: 400,
        headers: jsonHeaders,
      })
    }

    const networkGoUrl = Deno.env.get('NETWORKGO_SUPABASE_URL') || NETWORKGO_URL_DEFAULT
    const networkGoAnon = Deno.env.get('NETWORKGO_SUPABASE_ANON_KEY') || NETWORKGO_PUBLISHABLE_KEY_DEFAULT

    const networkGoSupabase = createClient(networkGoUrl, networkGoAnon, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const {
      data: { user: networkGoUser },
      error: authError,
    } = await networkGoSupabase.auth.getUser(access_token)

    if (authError || !networkGoUser?.email) {
      return new Response(JSON.stringify({ error: 'Token invalido ou expirado' }), {
        status: 401,
        headers: jsonHeaders,
      })
    }

    const email = networkGoUser.email.trim().toLowerCase()

    const dexterAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    // Checa a existencia ANTES de gerar o link. generateLink com magiclink
    // criaria o usuario automaticamente; aqui barramos quem nao tem conta.
    const { data: userExists, error: existsError } = await dexterAdmin.rpc(
      'check_user_exists_by_email',
      { user_email: email },
    )

    if (existsError) {
      console.error('[cross-login-dexter] Erro ao verificar usuario:', existsError)
      return new Response(JSON.stringify({ error: 'Erro ao verificar usuario' }), {
        status: 500,
        headers: jsonHeaders,
      })
    }

    if (!userExists) {
      return new Response(JSON.stringify({ error: 'Usuario nao encontrado no Dexter' }), {
        status: 404,
        headers: jsonHeaders,
      })
    }

    const { data: linkData, error: linkError } = await dexterAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: DEXTER_HOME },
    })

    if (linkError || !linkData?.properties?.action_link) {
      console.error('[cross-login-dexter] Erro ao gerar link:', linkError)
      return new Response(JSON.stringify({ error: 'Erro ao gerar link de acesso' }), {
        status: 500,
        headers: jsonHeaders,
      })
    }

    return new Response(JSON.stringify({ url: linkData.properties.action_link }), {
      headers: jsonHeaders,
    })
  } catch (error) {
    console.error('[cross-login-dexter] Erro interno:', error)
    return new Response(JSON.stringify({ error: 'Erro interno do servidor' }), {
      status: 500,
      headers: jsonHeaders,
    })
  }
})
