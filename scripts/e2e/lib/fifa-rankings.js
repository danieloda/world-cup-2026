// FIFA World Ranking — posição aproximada de cada uma das 48 seleções
// do Mundial 2026. Fonte: https://inside.fifa.com/fifa-world-ranking/men
// Atualizada em maio/2025 (aproximação — usar como TIEBREAKER apos pts/SG/GF).
//
// Quanto menor o número, melhor o ranking (1 = melhor do mundo).

export const FIFA_RANK = {
  Argentina: 1,
  Spain: 2,
  France: 3,
  England: 4,
  Portugal: 5,
  Netherlands: 6,
  Brazil: 7,
  Belgium: 8,
  Croatia: 9,
  Germany: 11,
  Morocco: 12,
  Switzerland: 13,
  USA: 14,
  Colombia: 15,
  Mexico: 16,
  Uruguay: 17,
  Senegal: 18,
  Iran: 19,
  Japan: 20,
  Ecuador: 21,
  Austria: 23,
  'South Korea': 24,
  Australia: 25,
  'Czech Republic': 26,
  Sweden: 27,
  Canada: 30,
  Türkiye: 29,
  Turkey: 29,           // alias
  Norway: 31,
  Egypt: 33,
  Algeria: 34,
  Tunisia: 37,
  'Ivory Coast': 39,
  'Côte d\'Ivoire': 39, // alias
  'Saudi Arabia': 41,
  Scotland: 42,
  Panama: 43,
  'South Africa': 49,
  Paraguay: 51,
  Iraq: 52,
  Qatar: 53,
  'Cape Verde': 55,
  'Cape Verde Islands': 55, // alias
  'Bosnia & Herzegovina': 56,
  Uzbekistan: 57,
  Ghana: 58,
  Jordan: 59,
  'New Zealand': 60,
  'Congo DR': 61,
  'DR Congo': 61,       // alias
  Haiti: 62,
  Curaçao: 88,
  Curacao: 88,          // alias
};

/**
 * Retorna ranking FIFA (menor = melhor). Times nao listados retornam 999.
 */
export function fifaRank(team) {
  return FIFA_RANK[team] ?? 999;
}
