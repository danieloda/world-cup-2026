#!/usr/bin/env node
/**
 * TRAVAS por data/hora — cobertura PROFUNDA (preenche lacunas do test-date-locks.js).
 *
 * O test-date-locks.js só checava palpite "2 dias antes = aceito" e "no dia = rejeitado",
 * deixava champeão/artilheiro como STUB e não testava UPDATE (edição) nem o artilheiro.
 * Aqui cobrimos, no nível RLS (cliente autenticado, não service-role):
 *
 *   PALPITE (predictions):
 *     P1. INSERT antes do prazo (deadline no futuro)            → ACEITO
 *     P2. UPDATE depois do prazo (deadline no passado)          → REJEITADO (policy UPDATE distinta)
 *     P3. INSERT depois do prazo                                → REJEITADO
 *     P4. prediction_deadline() (SQL) usa fuso de Brasília      → bate com valores conhecidos
 *
 *   CAMPEÃO (champion_picks) e ARTILHEIRO (top_scorer_picks), via cs_deadline():
 *     C1. INSERT antes do prazo  → ACEITO   |  C2. UPDATE antes do prazo → ACEITO
 *     C3. UPDATE depois do prazo → REJEITADO |  C4. INSERT depois do prazo → REJEITADO
 *     (idem para artilheiro: S1..S4)
 *
 * Cria um usuário descartável via Admin API, faz snapshot/restore de match_date e do
 * setting deadline_champion_scorer, e remove o usuário no fim. Roda contra Supabase LOCAL.
 *
 * Uso:  source .env.e2e.local && node scripts/e2e/test-deadline-boundary.js
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { makeAdminClient } from './lib/admin-client.js';
import { makeClient, loginAs } from './lib/supabase-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

const C = { r: '\x1b[31m', g: '\x1b[32m', b: '\x1b[34m', d: '\x1b[2m', x: '\x1b[0m', bold: '\x1b[1m' };
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`   ${pass ? C.g + '✓' : C.r + '✗'} ${name}${detail ? C.d + ' — ' + detail : ''}${C.x}`);
};

const DAY = 86400000;
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const TEST_EMAIL = 'dl-boundary@testuser.com';
const TEST_PASS = 'DlBoundary2026!';

async function main() {
  const admin = makeAdminClient();
  console.log(`${C.b}${C.bold}🔒 Travas por data/hora — cobertura profunda (RLS)${C.x}`);

  // ---- cria/reusa usuário descartável (confirmado + profile pago c/ avatar) ----
  let userId;
  {
    // se já existe de uma run anterior, remove p/ começar limpo
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const existing = list?.users?.find((u) => u.email === TEST_EMAIL);
    if (existing) await admin.auth.admin.deleteUser(existing.id);

    const { data: created, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL, password: TEST_PASS, email_confirm: true,
      user_metadata: { full_name: 'Deadline Boundary' },
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    userId = created.user.id;
    // garante profile (service-role ignora RLS); profiles.id = auth user id (NÃO há user_id).
    // predictions/picks.user_id têm FK → profiles.id, então o profile precisa existir.
    await admin.from('profiles').upsert(
      { id: userId, full_name: 'Deadline Boundary', email: TEST_EMAIL, paid: true, avatar_url: 'https://example.com/a.png' },
      { onConflict: 'id' },
    );
  }

  const uc = makeClient();
  await loginAs(uc, TEST_EMAIL, TEST_PASS);

  // dados auxiliares: 2 jogos de grupo distintos + 1 team + 2 players
  const { data: gmatches } = await admin.from('matches').select('id, match_date').eq('stage', 'group').order('match_date').order('id').limit(2);
  const mA = gmatches[0], mB = gmatches[1];
  const { data: players } = await admin.from('players').select('id').order('id').limit(2);
  const playerA = players[0].id, playerB = players[1].id;
  // times reais do torneio (evita qualquer FK/constraint em champion_picks.team)
  const { data: teams } = await admin.from('matches').select('team_home').eq('stage', 'group').order('id').limit(2);
  const champA = teams[0].team_home, champB = teams[1].team_home;

  const origA = mA.match_date, origB = mB.match_date;
  const { data: setRow } = await admin.from('settings').select('value').eq('key', 'deadline_champion_scorer').single();
  const origDeadline = setRow.value;

  try {
    // ============================================================
    // PALPITES (predictions)
    // ============================================================
    console.log(`\n${C.b}Palpites (predictions)${C.x}`);

    // P4. Fórmula no DB usa fuso de Brasília (independe do fuso do servidor).
    // jogo 2026-06-15 19:00Z → véspera 23h59 BRT = 2026-06-15 02:59Z.
    {
      const { data, error } = await uc.rpc('prediction_deadline', { p_match_date: '2026-06-15T19:00:00Z' });
      const got = data ? new Date(data).toISOString() : null;
      check('P4 prediction_deadline() em fuso BRT (15/jun 19hZ → 15/jun 02:59Z)',
        !error && got === '2026-06-15T02:59:00.000Z', error?.message || `got=${got}`);
    }

    // P1. deadline no FUTURO → INSERT aceito. Jogo daqui a 3 dias.
    await admin.from('matches').update({ match_date: iso(Date.now() + 3 * DAY) }).eq('id', mA.id);
    {
      const { error } = await uc.from('predictions').insert({ user_id: userId, match_id: mA.id, pred_home: 1, pred_away: 0 });
      check('P1 INSERT palpite antes do prazo', !error, error?.message || '');
    }

    // P2. deadline no PASSADO → UPDATE do palpite existente rejeitado. Jogo daqui a 1h (véspera já passou).
    await admin.from('matches').update({ match_date: iso(Date.now() + 1 * HOUR) }).eq('id', mA.id);
    {
      const { data, error } = await uc.from('predictions').update({ pred_home: 5, pred_away: 5 }).eq('user_id', userId).eq('match_id', mA.id).select();
      const blocked = !!error || !data || data.length === 0; // RLS UPDATE: erro OU 0 linhas afetadas
      check('P2 UPDATE palpite depois do prazo BLOQUEADO', blocked, blocked ? '' : 'EDITOU INDEVIDAMENTE');
      // confirma que o valor NÃO mudou no banco
      const { data: cur } = await admin.from('predictions').select('pred_home, pred_away').eq('user_id', userId).eq('match_id', mA.id).single();
      check('P2b valor preservado no banco (1-0, não 5-5)', cur && cur.pred_home === 1 && cur.pred_away === 0, `db=${cur?.pred_home}-${cur?.pred_away}`);
    }

    // P3. deadline no PASSADO → INSERT em outro jogo rejeitado.
    await admin.from('matches').update({ match_date: iso(Date.now() + 1 * HOUR) }).eq('id', mB.id);
    {
      const { error } = await uc.from('predictions').insert({ user_id: userId, match_id: mB.id, pred_home: 2, pred_away: 1 });
      check('P3 INSERT palpite depois do prazo BLOQUEADO', !!error, error ? '' : 'PASSOU INDEVIDAMENTE');
    }

    // ============================================================
    // CAMPEÃO (champion_picks) + ARTILHEIRO (top_scorer_picks)
    // ============================================================
    const setDeadline = async (ms) => {
      const { error } = await admin.from('settings').update({ value: iso(ms) }).eq('key', 'deadline_champion_scorer');
      if (error) throw new Error(`set deadline: ${error.message}`);
    };

    console.log(`\n${C.b}Campeão (champion_picks) — cs_deadline()${C.x}`);
    await setDeadline(Date.now() + 1 * DAY); // FUTURO
    {
      const { error: e1 } = await uc.from('champion_picks').insert({ user_id: userId, team: champA });
      check('C1 INSERT campeão antes do prazo', !e1, e1?.message || '');
      const { data: u1, error: e2 } = await uc.from('champion_picks').update({ team: champB }).eq('user_id', userId).select();
      check('C2 UPDATE campeão antes do prazo', !e2 && u1 && u1.length === 1, e2?.message || `rows=${u1?.length}`);
    }
    await setDeadline(Date.now() - 1 * HOUR); // PASSADO
    {
      const { data: u3, error: e3 } = await uc.from('champion_picks').update({ team: champA }).eq('user_id', userId).select();
      const blocked = !!e3 || !u3 || u3.length === 0;
      check('C3 UPDATE campeão depois do prazo BLOQUEADO', blocked, blocked ? '' : 'TROCOU INDEVIDAMENTE');
      const { data: cur } = await admin.from('champion_picks').select('team').eq('user_id', userId).single();
      check('C3b campeão preservado (Argentina)', cur?.team === champB, `db=${cur?.team}`);
      // INSERT depois do prazo: apaga e tenta reinserir
      await admin.from('champion_picks').delete().eq('user_id', userId);
      const { error: e4 } = await uc.from('champion_picks').insert({ user_id: userId, team: champA });
      check('C4 INSERT campeão depois do prazo BLOQUEADO', !!e4, e4 ? '' : 'PASSOU INDEVIDAMENTE');
    }

    console.log(`\n${C.b}Artilheiro (top_scorer_picks) — cs_deadline()${C.x}`);
    await setDeadline(Date.now() + 1 * DAY); // FUTURO
    {
      const { error: e1 } = await uc.from('top_scorer_picks').insert({ user_id: userId, player_id: playerA });
      check('S1 INSERT artilheiro antes do prazo', !e1, e1?.message || '');
      const { data: u2, error: e2 } = await uc.from('top_scorer_picks').update({ player_id: playerB }).eq('user_id', userId).select();
      check('S2 UPDATE artilheiro antes do prazo', !e2 && u2 && u2.length === 1, e2?.message || `rows=${u2?.length}`);
    }
    await setDeadline(Date.now() - 1 * HOUR); // PASSADO
    {
      const { data: u3, error: e3 } = await uc.from('top_scorer_picks').update({ player_id: playerA }).eq('user_id', userId).select();
      const blocked = !!e3 || !u3 || u3.length === 0;
      check('S3 UPDATE artilheiro depois do prazo BLOQUEADO', blocked, blocked ? '' : 'TROCOU INDEVIDAMENTE');
      await admin.from('top_scorer_picks').delete().eq('user_id', userId);
      const { error: e4 } = await uc.from('top_scorer_picks').insert({ user_id: userId, player_id: playerA });
      check('S4 INSERT artilheiro depois do prazo BLOQUEADO', !!e4, e4 ? '' : 'PASSOU INDEVIDAMENTE');
    }
  } finally {
    // ---- restore + cleanup ----
    await admin.from('matches').update({ match_date: origA }).eq('id', mA.id);
    await admin.from('matches').update({ match_date: origB }).eq('id', mB.id);
    await admin.from('settings').update({ value: origDeadline }).eq('key', 'deadline_champion_scorer');
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${C.b}${C.bold}Resumo: ${results.length - failed.length}/${results.length} OK${C.x}`);
  if (failed.length) {
    console.log(`${C.r}FALHAS: ${failed.map((f) => f.name).join('; ')}${C.x}`);
    process.exit(1);
  }
  console.log(`${C.g}${C.bold}🎉 Travas por data/hora corretas.${C.x}`);
  process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
