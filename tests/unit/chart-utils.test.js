// ============================================================
// chart-utils.js — lógica pura dos gráficos de evolução (rank/journey).
// O que está em jogo: posição certa em cada passo (ranking do replay),
// timeline agrupada pelo DIA DE BRASÍLIA (não UTC) e faixas de fase.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  computePositions, buildTimeline, stageBands, buildColorMap,
  ME_COLOR, PALETTE, clamp, pointXY, firstMeaningfulGame,
  matchHeader, placeTip, avatarSvgAt,
} from '../../src/js/chart-utils.js';
import { stageLabel } from '../../src/js/util.js';

describe('computePositions — ranking a cada jogo', () => {
  it('exemplo à mão: líder troca no meio', () => {
    const series = [
      { userId: 'a', values: [0, 10, 15, 22] },   // 1º no ranking final
      { userId: 'b', values: [0, 12, 16, 20] },
    ];
    const pos = computePositions(series);
    expect(pos[0]).toEqual([2, 2, 1]);   // a: atrás, atrás, assume a ponta
    expect(pos[1]).toEqual([1, 1, 2]);
  });

  it('INVARIANTE: em todo passo as posições são uma permutação 1..N (sem duplicata)', () => {
    const series = [
      { userId: 'a', values: [0, 5, 9, 9, 30] },
      { userId: 'b', values: [0, 5, 9, 12, 12] },
      { userId: 'c', values: [0, 0, 9, 12, 30] },
      { userId: 'd', values: [0, 7, 7, 7, 7] },
    ];
    const pos = computePositions(series);
    const steps = series[0].values.length - 1;
    for (let s = 0; s < steps; s++) {
      const col = pos.map(row => row[s]).sort((x, y) => x - y);
      expect(col).toEqual([1, 2, 3, 4]);
    }
  });

  it('empate de pontos: quem termina melhor no ranking final (menor índice) fica acima', () => {
    const series = [
      { userId: 'a', values: [0, 10] },
      { userId: 'b', values: [0, 10] },
    ];
    const pos = computePositions(series);
    expect(pos[0][0]).toBe(1);
    expect(pos[1][0]).toBe(2);
  });

  it('valores ausentes contam como 0 (série mais curta não explode)', () => {
    const series = [
      { userId: 'a', values: [0, 10, 20] },
      { userId: 'b', values: [0, 15] },          // sem o passo 2
    ];
    const pos = computePositions(series);
    expect(pos[1][1]).toBe(2);                    // b: 0 implícito no passo 2
    expect(pos[0][1]).toBe(1);
  });

  it('bordas: lista vazia e usuário único', () => {
    expect(computePositions([])).toEqual([]);
    expect(computePositions([{ userId: 'a', values: [0, 3, 9] }])).toEqual([[1, 1]]);
  });
});

describe('firstMeaningfulGame — onde as estatísticas começam (filtro de ruído)', () => {
  // 10 jogadores, 10 jogos. Todos empatados em 0 nos jogos 0–2; no jogo 3 o
  // usuário (idx 0) e mais 2 se separam (3 < metade do bolão). O corte FIXO de 6
  // descartava esse jogo 3 — exatamente o "5º no 4º jogo" do bug.
  it('REGRESSÃO: separação cedo (jogo 3) NÃO é descartada pelo teto de 6', () => {
    const sep = [10, 10, 10, ...Array(7).fill(0)];   // 3 empatados em 10 no jogo 3
    const series = sep.map((v4, i) => ({
      userId: `u${i}`, values: [0, 0, 0, 0, v4, ...Array(6).fill(v4)],
    }));
    expect(firstMeaningfulGame(series, 0)).toBe(3);   // antes: 6 (perdia o pico)
  });

  it('empate persistente (todos idênticos sempre) → cai no teto antigo (6)', () => {
    const series = Array.from({ length: 10 }, (_, i) => ({
      userId: `u${i}`, values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    }));
    expect(firstMeaningfulGame(series, 0)).toBe(6);
  });

  it('SALVAGUARDA: separação tardia (jogo 8) nunca pula MAIS que o teto (6)', () => {
    const sep = [10, ...Array(9).fill(0)];            // só o usuário sai, no jogo 8
    const series = sep.map((v9, i) => ({
      userId: `u${i}`, values: [0, 0, 0, 0, 0, 0, 0, 0, 0, v9, v9],
    }));
    expect(firstMeaningfulGame(series, 0)).toBe(6);
  });

  it('usuário distinto desde o 1º jogo → tudo conta (0)', () => {
    const series = [
      { userId: 'me', values: [0, 5, 9, 12] },
      { userId: 'b', values: [0, 0, 9, 12] },
      { userId: 'c', values: [0, 0, 0, 12] },
      { userId: 'd', values: [0, 0, 0, 0] },
    ];
    expect(firstMeaningfulGame(series, 0)).toBe(0);
  });

  it('bordas: lista vazia e usuário único não explodem', () => {
    expect(firstMeaningfulGame([], 0)).toBe(0);
    expect(firstMeaningfulGame([{ userId: 'a', values: [0, 3, 9] }], 0)).toBe(0);
  });

  it('valores ausentes (null) contam como 0, sem quebrar', () => {
    const series = [
      { userId: 'a', values: [0, null, 9] },
      { userId: 'b', values: [0, 0, 5] },
    ];
    expect(firstMeaningfulGame(series, 0)).toBe(0);  // null→0; separa no 2º jogo
  });
});

describe('buildTimeline — dias/semanas pelo relógio de Brasília', () => {
  // g1 às 02:00Z de 12/jun = 23h de 11/jun em BRT → MESMO dia do g0.
  const MATCHES = [
    { match_date: '2026-06-11T16:00:00+00:00' },  // 11/jun BRT
    { match_date: '2026-06-12T02:00:00+00:00' },  // ainda 11/jun BRT (23h)
    { match_date: '2026-06-12T16:00:00+00:00' },  // 12/jun BRT
    { match_date: '2026-06-18T16:00:00+00:00' },  // 18/jun BRT → semana seguinte
  ];
  const tl = buildTimeline(MATCHES);

  it('agrupa pelo dia BRT: jogo das 23h NÃO vira "dia seguinte" (bug clássico de UTC)', () => {
    expect(tl.dayOfGame).toEqual([0, 0, 1, 2]);
  });
  it('dayEnds aponta o último jogo de cada dia', () => {
    expect(tl.dayEnds).toEqual([1, 2, 3]);
  });
  it('semanas de 7 dias a partir do 1º dia de jogo', () => {
    // 11/jun → semana 0 · 18/jun (7 dias depois) → semana 1
    expect(tl.weekEnds[0]).toBe(2);
    expect(tl.weekEnds[1]).toBe(3);
  });
  it('rótulos humanos: dayLabel e weekRange', () => {
    expect(tl.dayLabel(0)).toBe('11/6');
    expect(tl.weekRange(0)).toBe('11/6–12/6');
    expect(tl.weekRange(1)).toBe('18/6–18/6');
    expect(tl.weekRange(9)).toBe('');
  });
});

describe('stageBands — faixas de fase do fundo do gráfico', () => {
  const MATCHES = [
    { stage: 'group' }, { stage: 'group' }, { stage: 'r32' }, { stage: 'r32' }, { stage: 'final' },
  ];
  const steps = [0, 1, 2, 3, 4];
  const xAt = (i) => i * 100;

  it('um run contíguo por fase, com fronteira no meio do caminho', () => {
    const bands = stageBands(MATCHES, steps, xAt, 0, 400);
    expect(bands).toHaveLength(3);
    expect(bands[0]).toEqual({ x: 0, w: 150, label: stageLabel('group') });
    expect(bands[1]).toEqual({ x: 150, w: 200, label: stageLabel('r32') });
    expect(bands[2]).toEqual({ x: 350, w: 50, label: stageLabel('final') });
  });
  it('as faixas cobrem exatamente x0..x1, sem buraco nem sobreposição', () => {
    const bands = stageBands(MATCHES, steps, xAt, 0, 400);
    let cursor = 0;
    for (const b of bands) { expect(b.x).toBe(cursor); cursor = b.x + b.w; }
    expect(cursor).toBe(400);
  });
  it('fase única → 1 faixa inteira; sem passos → nenhuma', () => {
    const one = stageBands([{ stage: 'group' }, { stage: 'group' }], [0, 1], xAt, 0, 300);
    expect(one).toEqual([{ x: 0, w: 300, label: stageLabel('group') }]);
    expect(stageBands(MATCHES, [], xAt, 0, 400)).toEqual([]);
  });
  it('partida sem stage cai no rótulo padrão "group"', () => {
    const bands = stageBands([{ stage: 'group' }, {}], [0, 1], xAt, 0, 200);
    expect(bands).toEqual([{ x: 0, w: 200, label: stageLabel('group') }]);
  });
});

describe('buildColorMap / helpers', () => {
  it('"você" é sempre amarelo; demais seguem a paleta na ordem do ranking', () => {
    const series = [{ userId: 'u1' }, { userId: 'me' }, { userId: 'u3' }];
    const map = buildColorMap(series, 'me');
    expect(map.get('me')).toBe(ME_COLOR);
    expect(map.get('u1')).toBe(PALETTE[0]);
    expect(map.get('u3')).toBe(PALETTE[2]);
  });
  it('paleta cicla além do tamanho (19º jogador reusa a cor 1)', () => {
    const series = Array.from({ length: PALETTE.length + 1 }, (_, i) => ({ userId: `u${i}` }));
    const map = buildColorMap(series, 'nobody');
    expect(map.get(`u${PALETTE.length}`)).toBe(PALETTE[0]);
  });
  it('clamp e pointXY (mouse × touch)', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
    expect(pointXY({ clientX: 3, clientY: 4 })).toEqual({ x: 3, y: 4 });
    expect(pointXY({ touches: [{ clientX: 7, clientY: 8 }] })).toEqual({ x: 7, y: 8 });
  });
});

describe('matchHeader — cabeçalho do tooltip', () => {
  it('grupo + com placar: rótulo "Grupo X" e o placar formatado', () => {
    const html = matchHeader({
      stage: 'group', group_name: 'C',
      actual_home: 2, actual_away: 0,
      match_date: '2026-06-15T18:00:00Z',
      team_home: 'Brazil', team_away: 'Mexico',
    });
    expect(html).toContain('Grupo C');
    expect(html).toContain('2');
    expect(html).toContain('–');   // separador de placar (não o "×")
    expect(html).toContain('Brasil');
  });

  it('mata-mata + sem placar: usa stageLabel e a marca "×"', () => {
    const html = matchHeader({
      stage: 'r16', group_name: null,
      actual_home: null, actual_away: null,
      match_date: '2026-07-01T18:00:00Z',
      team_home: 'France', team_away: 'Spain',
    });
    expect(html).toContain(stageLabel('r16'));
    expect(html).toContain('×');
  });

  it('grupo sem group_name não quebra (fallback vazio)', () => {
    const html = matchHeader({
      stage: 'group', group_name: null,
      actual_home: 0, actual_away: 0,
      match_date: '2026-06-20T15:00:00Z',
      team_home: 'Japan', team_away: 'Egypt',
    });
    expect(html).toContain('Grupo ');  // rótulo presente, sufixo vazio
  });
});

describe('placeTip — posicionamento do tooltip', () => {
  // jsdom não faz layout: offsetWidth=0 (cai no fallback 180) e getBoundingClientRect
  // é stubado p/ exercitar os dois ramos (cabe / estoura a borda direita).
  const mkTip = () => document.createElement('div');
  const mkHost = (width) => {
    const h = document.createElement('div');
    h.getBoundingClientRect = () => ({ left: 0, width, top: 0, right: width, bottom: 0, height: 0 });
    return h;
  };

  it('cabe: fica à direita do cursor', () => {
    const tip = mkTip();
    placeTip(mkHost(1000), tip, 10);  // 10+14 + 180 = 204 <= 1000
    expect(tip.style.left).toBe('24px');
    expect(tip.style.top).toBe('8px');
  });

  it('estoura a borda: vira para a esquerda do cursor (com piso de 4px)', () => {
    const tip = mkTip();
    placeTip(mkHost(100), tip, 10);   // 24 + 180 > 100 → 10-180-14 < 0 → max(4, ...)
    expect(tip.style.left).toBe('4px');
  });
});

describe('avatarSvgAt — avatar na ponta da linha', () => {
  it('com foto: recorta a imagem em círculo (clipPath + image)', () => {
    const svg = avatarSvgAt({ name: 'Ana', avatar_url: 'http://x/a"b.png' }, '#f4c430', 10, 20, 8, 'u1');
    expect(svg).toContain('<clipPath id="avc-u1">');
    expect(svg).toContain('<image href="http://x/a&quot;b.png"');  // escAttr nas aspas
    expect(svg).toContain('stroke="#f4c430"');
  });

  it('sem foto: cai nas iniciais', () => {
    const svg = avatarSvgAt({ name: 'Bruno Lima' }, '#fff', 10, 20, 8, 'u2');
    expect(svg).toContain('<text');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('stroke="#fff"');
  });
});
