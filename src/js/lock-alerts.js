// Alertas de bloqueio — cruza "jogo perto de travar" com "você ainda não palpitou".
//
// Um jogo entra no alerta quando: não terminou, o usuário NÃO tem palpite para
// ele, o prazo de bloqueio (23h59 da véspera) ainda não passou e falta < 1 semana.
// A urgência separa <48h (urgent) de <1 semana (soon), reaproveitando os mesmos
// limiares de dayPredictionStatus / do calendário.
//
// Usado em dois lugares: banner no Início e badge na sidebar. Por isso é um
// módulo próprio — uma só fonte de verdade para a regra do alerta.

import { supabase } from './supabase.js';
import { predictionDeadline } from './util.js';

const WEEK_MS = 7 * 24 * 3600000;
const H48_MS = 48 * 3600000;

function emptyAlerts() {
  return { urgent: 0, soon: 0, total: 0, matches: [], nextDeadline: null };
}

/**
 * Carrega os jogos pendentes (sem palpite) que estão perto do bloqueio.
 * @param {string} userId  profile.id do usuário logado
 * @returns {Promise<{urgent:number, soon:number, total:number,
 *   matches:Array, nextDeadline:number|null}>}
 *   matches: lista ordenada pelo prazo mais próximo, cada item com
 *   { ...match, deadline (ms), diff (ms até travar) }.
 */
export async function loadLockAlerts(userId) {
  if (!userId) return emptyAlerts();

  const [matchesRes, predsRes] = await Promise.all([
    supabase
      .from('matches')
      // matches.id é a PK (não existe match_id) — apelida pra id=match_id manter
      // o resto do módulo igual. Sem o alias, o select dava 400 e o alerta de
      // bloqueio ficava sempre vazio (silenciosamente).
      .select('match_id:id, match_date, team_home, team_away, group_name, stage')
      .eq('finished', false),
    supabase.from('predictions').select('match_id').eq('user_id', userId),
  ]);

  if (matchesRes.error || predsRes.error) return emptyAlerts();

  const predicted = new Set((predsRes.data ?? []).map(p => p.match_id));
  const now = Date.now();

  const pending = [];
  for (const m of matchesRes.data ?? []) {
    if (predicted.has(m.match_id)) continue;
    const deadline = predictionDeadline(m.match_date).getTime();
    const diff = deadline - now;
    if (diff <= 0) continue;       // já travou: não há ação possível, não alerta
    if (diff > WEEK_MS) continue;  // ainda distante
    pending.push({ ...m, deadline, diff });
  }

  pending.sort((a, b) => a.diff - b.diff);
  const urgent = pending.filter(p => p.diff <= H48_MS).length;

  return {
    urgent,
    soon: pending.length - urgent,
    total: pending.length,
    matches: pending,
    nextDeadline: pending[0]?.deadline ?? null,
  };
}
