// ============================================================
// Auto-refresh — recarrega a página quando o "mundo" muda
// ============================================================
// As páginas de leitura (Início, Ranking, Histórico) montam tudo no load e
// ficavam congeladas até um F5 manual: resultado lançado, lacre publicado ou
// jogo começando não apareciam pra quem já estava com a aba aberta.
//
// Estratégia deliberadamente simples e sem risco: polling leve (2 HEAD counts
// por minuto) num FINGERPRINT do estado renderizável —
//   • jogos finalizados (resultado lançado no admin), e
//   • jogos revelados (v_revealed_matches: lacre publicado OU apito — o count
//     muda sozinho quando um jogo cruza o horário do apito, já que a view
//     compara match_date com now()).
// Mudou → location.reload(): re-render parcial arriscaria estado inconsistente
// nessas páginas (tudo é HTML montado de uma vez); recarregar é atômico. Os
// eventos são raros (~meia dúzia por dia), então o reload não incomoda.
//
// NUNCA use em página com input do usuário (palpites!): um reload engoliria
// o que ele estava digitando.
//
// Aba oculta não gasta rede nem pisca: pausa via visibilitychange e re-checa
// na volta. Falha de rede não recarrega às cegas — só compara fingerprints
// obtidos com sucesso.
//
// KEEP IN SYNC: supabase/migrations/060_reveal_after_publication.sql
// (v_revealed_matches é o mesmo predicado do RLS de predictions).

import { supabase } from './supabase.js';

const INTERVAL_MS = 60_000;

export function startAutoRefresh() {
  let baseline = null;   // fingerprint do que a página renderizou
  let inflight = false;

  async function fingerprint() {
    const [finished, revealed] = await Promise.all([
      supabase.from('matches').select('id', { count: 'exact', head: true }).eq('finished', true),
      supabase.from('v_revealed_matches').select('id', { count: 'exact', head: true }),
    ]);
    if (finished.error || revealed.error) return null;
    return `${finished.count}|${revealed.count}`;
  }

  async function check() {
    if (inflight || document.hidden) return;
    inflight = true;
    const fp = await fingerprint().catch(() => null);
    inflight = false;
    if (fp == null) return;                    // rede/banco indisponível → não arrisca
    if (baseline == null) { baseline = fp; return; }
    if (fp !== baseline) location.reload();
  }

  check();                                     // baseline logo após o render
  const timer = setInterval(check, INTERVAL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  return () => clearInterval(timer);
}
