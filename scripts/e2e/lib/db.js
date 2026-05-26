// Helpers de acesso ao banco pro E2E.

export async function loadAllMatches(client) {
  const { data, error } = await client
    .from('matches')
    .select('id, stage, group_name, team_home, team_away, slot_home, slot_away, match_date, finished, actual_home, actual_away, pen_winner')
    .order('id');
  if (error) throw new Error('loadAllMatches: ' + error.message);
  return data;
}

export async function loadAllPlayers(client) {
  const { data, error } = await client.from('players').select('id, full_name, team, position');
  if (error) throw new Error('loadAllPlayers: ' + error.message);
  return data;
}

export async function loadAllTeams(client) {
  // Times unicos do stage=group (todos os 48)
  const { data, error } = await client.from('matches').select('team_home, team_away').eq('stage', 'group');
  if (error) throw new Error('loadAllTeams: ' + error.message);
  const s = new Set();
  for (const m of data) { s.add(m.team_home); s.add(m.team_away); }
  return [...s];
}

/**
 * Inserta predictions em lote pra um user. Retorna { ok, error, inserted }.
 */
export async function insertPredictions(client, userId, predictions) {
  // predictions: [{ match_id, pred_home, pred_away, pred_pen_winner }]
  const rows = predictions.map((p) => ({ ...p, user_id: userId }));
  const { error } = await client.from('predictions').insert(rows);
  if (error) return { ok: false, error: error.message, inserted: 0 };
  return { ok: true, inserted: rows.length };
}

export async function setChampionPick(client, userId, team) {
  if (!team) return { ok: true, skipped: true };
  const { error } = await client.from('champion_picks').upsert({ user_id: userId, team });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function setScorerPick(client, userId, playerId) {
  if (!playerId) return { ok: true, skipped: true };
  const { error } = await client.from('top_scorer_picks').upsert({ user_id: userId, player_id: playerId });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function setPaid(client, userId, paid) {
  const { error } = await client.from('profiles').update({ paid }).eq('id', userId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Reset deadline pra "ja passou" (simula deadline batido).
 */
export async function simulateDeadlineHit(client, when = '2026-05-01T00:00:00Z') {
  const { error } = await client
    .from('settings')
    .upsert({ key: 'deadline_champion_scorer', value: JSON.stringify(when) });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Restaura deadline pro futuro (depois do E2E).
 */
export async function restoreDeadline(client, when = '2026-06-11T02:59:00Z') {
  return await simulateDeadlineHit(client, when);
}

/**
 * Lê o leaderboard atual.
 */
export async function loadLeaderboard(client) {
  const { data, error } = await client.from('v_leaderboard').select('*');
  if (error) throw new Error('loadLeaderboard: ' + error.message);
  return data;
}

/**
 * Lê o estado completo do DB pro audit.
 */
export async function fullSnapshot(client) {
  const [profiles, predictions, champion_picks, scorer_picks, player_goals, matches, leaderboard, alert_log] = await Promise.all([
    client.from('profiles').select('*'),
    client.from('predictions').select('*'),
    client.from('champion_picks').select('*'),
    client.from('top_scorer_picks').select('*, players(*)'),
    client.from('player_goals').select('*, players(*)'),
    client.from('matches').select('*'),
    client.from('v_leaderboard').select('*'),
    client.from('alert_log').select('*').order('created_at', { ascending: false }).limit(50),
  ]);
  return {
    profiles: profiles.data,
    predictions: predictions.data,
    champion_picks: champion_picks.data,
    scorer_picks: scorer_picks.data,
    player_goals: player_goals.data,
    matches: matches.data,
    leaderboard: leaderboard.data,
    alert_log: alert_log.data,
  };
}
