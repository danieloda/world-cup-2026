// ============================================================
// Captura de erros do cliente → tabela public.client_errors (observabilidade)
// ============================================================
// Instala handlers globais (window.onerror + unhandledrejection) e grava erros
// não tratados no Supabase, pro admin ver bug ANTES do usuário reclamar.
//
// Princípios:
//   - NUNCA quebra a página nem cria loop (todo envio é try/catch silencioso).
//   - Rate-limit: dedupe por assinatura + teto por carregamento (não inunda a
//     tabela num erro que dispara em loop).
//   - Só envia autenticado (RLS exige user_id = auth.uid()).
//
// KEEP IN SYNC: supabase/migrations/047_client_errors.sql. Instalado pelo
// requireAuth() (auth.js) após confirmar a sessão.

import { supabase } from './supabase.js';

let installed = false;
let currentUserId = null;
const seen = new Set();        // assinaturas já enviadas (dedupe)
let sentCount = 0;
const MAX_PER_LOAD = 20;       // teto por carregamento de página

function trunc(s, n) {
  return s == null ? null : String(s).slice(0, n);
}

async function report(kind, message, { source = '', line = '', stack = null } = {}) {
  try {
    if (!currentUserId || sentCount >= MAX_PER_LOAD) return;
    const sig = `${message}::${source}:${line}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    sentCount++;
    await supabase.from('client_errors').insert({
      user_id: currentUserId,
      kind,
      message: trunc(message, 1000) || '(sem mensagem)',
      stack: trunc(stack, 4000),
      url: trunc(location.href, 500),
      user_agent: trunc(navigator.userAgent, 300),
    });
  } catch {
    // silêncio absoluto: o reporter jamais pode gerar erro (evita loop infinito).
  }
}

/**
 * Instala os handlers globais uma única vez. Passe o id do usuário autenticado
 * (de requireAuth) — sem ele nada é enviado (RLS bloquearia mesmo).
 * @param {string} userId
 */
export function installErrorReporter(userId) {
  if (userId) currentUserId = userId;
  if (installed) return;
  installed = true;

  window.addEventListener('error', (e) => {
    report('error', e.message || 'window.onerror', {
      source: e.filename, line: e.lineno, stack: e.error?.stack,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    report('unhandledrejection', r?.message || String(r), { stack: r?.stack });
  });
}
