// DEV ONLY — gera SQL pra avançar o snapshot local até "R32 em andamento".
// Restaura resultados/gols reais do oracle (expected-tournament.json), mantendo
// o bracket coerente. Datas ancoradas em "agora" pra exercitar trava/abertos.
//
// Uso:
//   node scripts/dev/advance-to-r32.mjs > scripts/dev/_advance.sql
//   docker exec -i supabase_db_world-cup-2026 psql -U postgres -d postgres \
//     -v ON_ERROR_STOP=1 < scripts/dev/_advance.sql
//
// Estado resultante:
//   grupos 1-72   → finalizados (datas no passado)
//   r32 73-82     → finalizados (resultados + gols) — testar cores no bracket
//   r32 83        → apito HOJE à noite → TRAVADO (deadline ontem), não jogado
//   r32 84-88     → amanhã em diante → ABERTOS (travam na véspera 23h59)
//   r16+ 89-104   → futuro / slots (jogos faltando)

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const oracle = JSON.parse(readFileSync(join(__dirname, '..', 'e2e', 'expected-tournament.json'), 'utf8'));
const byId = new Map(oracle.matches.map(m => [m.id, m]));

const now = Date.now();
const H = 3600e3, D = 24 * H;
const iso = ms => new Date(ms).toISOString();
const sq = s => s == null ? 'null' : `'${String(s).replace(/'/g, "''")}'`;

// ---- agenda (ms epoch) por id ----
function matchDate(id) {
  if (id <= 72) {                      // grupos: -21d .. -4d
    const dayIdx = Math.floor((id - 1) / 4);
    return now - 21 * D + dayIdx * D + ((id - 1) % 4) * 2 * H;
  }
  if (id <= 82) return now - (82 - id) * 6 * H - 2 * H;  // r32 jogados: -2.3d .. -2h
  if (id === 83) return now + 5 * H;                      // r32: HOJE à noite (travado)
  if (id <= 88) return now + (id - 83) * D;               // r32: amanhã em diante (abertos)
  if (id <= 96) return now + (6 + (id - 89)) * D;         // r16
  if (id <= 100) return now + (15 + (id - 97)) * D;       // qf
  if (id <= 102) return now + (20 + (id - 101)) * D;      // sf
  if (id === 103) return now + 22 * D;                    // 3º lugar
  return now + 23 * D;                                    // final
}

const FINISH_MAX = 82;                 // finaliza grupos + r32 73-82
const isFinished = id => id <= FINISH_MAX;
const NEW_GOALS = [];                  // ids cujos gols vamos (re)inserir = mata-mata jogado + Grupo L
for (let id = 67; id <= 82; id++) NEW_GOALS.push(id);

const out = [];
out.push('-- gerado por scripts/dev/advance-to-r32.mjs');
out.push('set client_min_messages = warning;');
out.push('begin;');
// desliga triggers durante a carga (resolve/recompute rodam 1x no fim)
out.push(`alter table public.matches disable trigger trg_match_finished;`);
out.push(`alter table public.matches disable trigger trg_resolve_slots;`);
out.push(`alter table public.matches disable trigger trg_s_qualifier_bonus;`);
out.push(`alter table public.matches disable trigger trg_z_alert_orphan_predictions;`);
out.push(`alter table public.matches disable trigger trg_z_alert_unresolved_slots;`);

for (let id = 1; id <= 104; id++) {
  const o = byId.get(id);
  const dt = iso(matchDate(id));
  if (isFinished(id)) {
    out.push(
      `update public.matches set match_date=${sq(dt)}, finished=true, ` +
      `finished_at=${sq(iso(matchDate(id) + 2 * H))}, ` +
      `actual_home=${o.actual_home}, actual_away=${o.actual_away}, pen_winner=${sq(o.pen_winner)} where id=${id};`
    );
  } else {
    out.push(
      `update public.matches set match_date=${sq(dt)}, finished=false, finished_at=null, ` +
      `actual_home=null, actual_away=null, pen_winner=null where id=${id};`
    );
  }
}

// gols dos jogos recém-finalizados do mata-mata + Grupo L (grupos 1-66 já têm)
out.push(`delete from public.player_goals where match_id between 67 and 82;`);
for (const id of NEW_GOALS) {
  const o = byId.get(id);
  for (const s of (o.scorers || [])) {
    out.push(`insert into public.player_goals (player_id, match_id, goals) values (${s.player_id}, ${id}, ${s.goals});`);
  }
}

// zera pontos cacheados dos palpites de jogos não finalizados
out.push(`update public.predictions set points_earned=null where match_id > ${FINISH_MAX};`);

// re-liga triggers e roda resolve + recompute 1x
out.push(`alter table public.matches enable trigger trg_match_finished;`);
out.push(`alter table public.matches enable trigger trg_resolve_slots;`);
out.push(`alter table public.matches enable trigger trg_s_qualifier_bonus;`);
out.push(`alter table public.matches enable trigger trg_z_alert_orphan_predictions;`);
out.push(`alter table public.matches enable trigger trg_z_alert_unresolved_slots;`);
out.push(`select public.resolve_match_slots();`);
out.push(`select public.recompute_prediction_points();`);
out.push(`select public.recompute_qualifier_points();`);
out.push('commit;');

console.log(out.join('\n'));
