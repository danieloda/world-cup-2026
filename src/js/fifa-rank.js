// FIFA World Ranking — posição oficial dos 48 times do Mundial 2026.
// Espelha a tabela team_fifa_rank do DB (migration 015_fifa_rank_tiebreaker.sql).
// Fonte: Transfermarkt 01/abr/2026 (próximo update FIFA: 11/jun/2026).
// Menor = melhor. 1 = França #1 do mundo.
//
// IMPORTANTE: manter sincronizado com supabase/migrations/015_fifa_rank_tiebreaker.sql

export const FIFA_RANK = {
  'France': 1, 'Spain': 2, 'Argentina': 3, 'England': 4, 'Portugal': 5,
  'Brazil': 6, 'Netherlands': 7, 'Morocco': 8, 'Belgium': 9, 'Germany': 10,
  'Croatia': 11, 'Colombia': 13, 'Senegal': 14, 'Mexico': 15, 'USA': 16,
  'Uruguay': 17, 'Japan': 18, 'Switzerland': 19, 'Iran': 21, 'Türkiye': 22,
  'Turkey': 22,  // alias
  'Ecuador': 23, 'Austria': 24, 'South Korea': 25, 'Australia': 27,
  'Algeria': 28, 'Egypt': 29, 'Canada': 30, 'Norway': 31, 'Panama': 33,
  'Ivory Coast': 34, 'Sweden': 38, 'Paraguay': 40, 'Czech Republic': 41,
  'Scotland': 43, 'Tunisia': 44, 'DR Congo': 46, 'Congo DR': 46,  // alias
  'Uzbekistan': 50, 'Qatar': 55, 'Iraq': 57, 'South Africa': 60,
  'Saudi Arabia': 61, 'Jordan': 63, 'Bosnia & Herzegovina': 65,
  'Cape Verde': 69, 'Cape Verde Islands': 69,  // alias
  'Ghana': 74, 'Curaçao': 82, 'Curacao': 82,  // alias
  'Haiti': 83, 'New Zealand': 85,
};

/**
 * Retorna ranking FIFA (menor = melhor). Times não listados retornam 999.
 * Usado como tiebreaker após PTS → SG → GF.
 */
export function fifaRank(team) {
  return FIFA_RANK[team] ?? 999;
}
