// ============================================================
// Ranking do bolão — desempate entre participantes + rateio do prêmio.
// Módulo PURO (sem DOM/Supabase) → SSOT testável da regra de desempate e da
// divisão de prêmio. Espelha o ORDER BY do v_leaderboard; é a fonte da ordem
// EXIBIDA (o front ordena por aqui, sem depender de o PostgREST preservar a
// ordem interna da view). Ver tests/unit/prize.test.js e regras.html#desempate.
// ============================================================

// Desempate entre participantes (Regras → "Ranking do bolão"):
//   1) mais pontos no total
//   2) mais placares exatos (cravados)
//   3) mais acertos de vencedor + saldo (sem cravar)
// Retorna uma NOVA lista ordenada (não muta a entrada). Array.sort é estável:
// jogadores idênticos nos 3 critérios mantêm a ordem de entrada — eles dividem
// a mesma posição no rateio de qualquer forma.
export function sortLeaderboard(rows) {
  return [...rows].sort((a, b) =>
    (b.total_pts ?? 0) - (a.total_pts ?? 0)
    || (b.exact_count ?? 0) - (a.exact_count ?? 0)
    || (b.winner_sg_count ?? 0) - (a.winner_sg_count ?? 0)
  );
}

// Dois jogadores empatam DE VERDADE quando são iguais nos 3 critérios — aí não
// há como separá-los e entra o rateio (dividem a mesma posição).
export function tiedPair(a, b) {
  return (a.total_pts ?? 0) === (b.total_pts ?? 0)
      && (a.exact_count ?? 0) === (b.exact_count ?? 0)
      && (a.winner_sg_count ?? 0) === (b.winner_sg_count ?? 0);
}

// Atribui a posição ("competição padrão": 1, 2, 2, 4…) e o prêmio JÁ RATEADO.
// Assume `rows` ORDENADAS (rode sortLeaderboard antes). Muta cada linha com:
//   pos, tied (compartilha posição), tieSize (tamanho do bloco), prizeShare (R$).
// prizeByPos = [prêmio 1º, 2º, 3º] em reais. Rateio (regra SBC 2022): soma os
// prêmios das CASAS realmente ocupadas pelo bloco empatado e divide por igual.
export function assignRanksAndPrizes(rows, prizeByPos) {
  rows.forEach((u, i) => {
    u.pos = (i > 0 && tiedPair(rows[i - 1], u)) ? rows[i - 1].pos : i + 1;
  });

  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].pos === rows[i].pos) j++;
    const size = j - i + 1;
    // Soma os prêmios das casas ocupadas pelo bloco (pos … pos+size-1).
    let pool = 0;
    for (let k = 0; k < size; k++) {
      const slot = rows[i].pos + k; // casa 1-based
      if (slot >= 1 && slot <= prizeByPos.length) pool += prizeByPos[slot - 1];
    }
    const share = pool / size;
    for (let r = i; r <= j; r++) {
      rows[r].tied = size > 1;
      rows[r].tieSize = size;
      rows[r].prizeShare = share;
    }
    i = j + 1;
  }
  return rows;
}
