// ============================================================
// Probe de fuso para o fuzzer de datas (tests/unit/date-tz-invariance.test.js)
// ============================================================
// Roda as funções de EXIBIÇÃO de data/hora de util.js sobre um conjunto
// determinístico de instantes e imprime o resultado em JSON.
//
// O ponto: este script é executado pelo teste em VÁRIOS fusos (via env TZ),
// um processo node novo por fuso — assim o fuso é aplicado ANTES de qualquer
// Date/Intl (Node cacheia a TZ no 1º uso; só processo separado é confiável).
// O teste então compara as saídas: para um bolão brasileiro, a hora/data
// exibida do jogo NÃO pode depender do fuso do dispositivo do usuário.
//
// Instantes são gerados como epoch-ms (Date.UTC / PRNG) → o INSTANTE é o mesmo
// em qualquer TZ; só a renderização varia. É essa variação que caça o bug.

import { makeRng } from '../../scripts/e2e/lib/prng.js';
import { formatTime, formatBrDate, formatBrShort, localDateKey } from '../../src/js/util.js';

// Instantes-armadilha: viram o dia/hora em fusos diferentes do BRT.
const EDGE = [
  Date.UTC(2026, 5, 15, 23, 0),  // 20:00 BRT, 15/jun (noite — vira dia em fusos +)
  Date.UTC(2026, 5, 21, 2, 30),  // 23:30 BRT, 20/jun (véspera da meia-noite BRT)
  Date.UTC(2026, 5, 21, 3, 30),  // 00:30 BRT, 21/jun (logo após meia-noite BRT)
  Date.UTC(2026, 5, 25, 16, 0),  // 13:00 BRT, 25/jun (tarde)
  Date.UTC(2026, 6, 19, 1, 0),   // 22:00 BRT, 18/jul (noite, fim do torneio)
];

// + 60 instantes pseudo-aleatórios determinísticos na janela do torneio.
const START = Date.UTC(2026, 5, 11, 0, 0);
const END = Date.UTC(2026, 6, 19, 23, 0);
const rng = makeRng('tz-fuzz-v1');
const RANDOM = Array.from({ length: 60 }, () => START + Math.floor(rng() * (END - START)));

const instants = [...EDGE, ...RANDOM];

const rows = instants.map((ms) => {
  const d = new Date(ms);
  return {
    ms,
    time: formatTime(d),
    brDate: formatBrDate(d),
    brShort: formatBrShort(d),
    key: localDateKey(d),
  };
});

process.stdout.write(JSON.stringify({ tz: process.env.TZ, rows }));
