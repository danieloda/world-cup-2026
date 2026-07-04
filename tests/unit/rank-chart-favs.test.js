// @vitest-environment jsdom
//
// Preset "Favoritos" do gráfico de evolução (rank-chart.js): o usuário monta o
// próprio grupo de amigos pela legenda e a seleção persiste em localStorage,
// POR USUÁRIO (chave rc:favs:<meId>). Cobre: seed com "Você" + legenda expandida
// na primeira ativação, edição ao vivo pela legenda (persistindo), restauração
// do modo na visita seguinte, saída pro preset Pódio, e descarte de ids que
// saíram do bolão.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderRankChart } from '../../src/js/rank-chart.js';

const N = 8, GAMES = 4;
const ME = 'u5';

// u0 sempre na frente, u7 sempre atrás — posições estáveis, sem empates.
const mkSeries = () => Array.from({ length: N }, (_, i) => ({
  userId: `u${i}`,
  name: `Jogador ${i}`,
  avatar_url: null,
  values: Array.from({ length: GAMES + 1 }, (_, g) => g * (N - i)),
}));
const mkMatches = () => Array.from({ length: GAMES }, (_, g) => ({
  id: g + 1, stage: 'group', group_name: 'A',
  match_date: new Date(Date.UTC(2026, 5, 11 + g, 18)).toISOString(),
  team_home: 'Brazil', team_away: 'Croatia', actual_home: 1, actual_away: 0,
}));

function render() {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  renderRankChart(mount, { series: mkSeries(), matches: mkMatches(), meId: ME });
  return mount;
}
const favChip = (m) => m.querySelector('.rc-chip[data-p="fav"]');
const legBtn = (m, uid) => m.querySelector(`.rc-leg[data-user="${uid}"]`);
const focUids = (m) => [...m.querySelectorAll('polyline.rc-foc')].length;
const storedFavs = () => JSON.parse(localStorage.getItem(`rc:favs:${ME}`) || '[]');

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('rank-chart — preset Favoritos persistido', () => {
  it('renderiza o chip Favoritos junto dos presets', () => {
    const m = render();
    expect(favChip(m)).toBeTruthy();
    expect(favChip(m).textContent).toMatch(/Favoritos/);
    // sem favoritos salvos → contador escondido e modo padrão = Pódio + Você
    expect(favChip(m).querySelector('.rc-chip-ct').hidden).toBe(true);
    expect(m.querySelector('.rc-chip[data-p="podio"]').classList.contains('active')).toBe(true);
  });

  it('primeira ativação: semente = Você, salva e expande o elenco pra montar o grupo', () => {
    const m = render();
    favChip(m).click();
    expect(favChip(m).classList.contains('active')).toBe(true);
    expect(favChip(m).getAttribute('aria-pressed')).toBe('true');
    expect(storedFavs()).toEqual([ME]);
    // legenda expandida (todos os N aparecem pra escolher)
    expect(m.querySelectorAll('.rc-leg[data-user]').length).toBe(N);
    // nota explica que a seleção fica salva
    expect(m.querySelector('.rc-note').textContent).toMatch(/fica salva/i);
  });

  it('em modo Favoritos a legenda EDITA o grupo e persiste a cada toque', () => {
    const m = render();
    favChip(m).click();
    legBtn(m, 'u0').click();
    legBtn(m, 'u3').click();
    expect(new Set(storedFavs())).toEqual(new Set([ME, 'u0', 'u3']));
    expect(focUids(m)).toBe(3);
    expect(favChip(m).querySelector('.rc-chip-ct').textContent).toBe('3');
    // remover também persiste
    legBtn(m, 'u0').click();
    expect(new Set(storedFavs())).toEqual(new Set([ME, 'u3']));
    expect(focUids(m)).toBe(2);
  });

  it('próxima visita reabre nos Favoritos salvos (modo + seleção)', () => {
    const m1 = render();
    favChip(m1).click();
    legBtn(m1, 'u0').click();

    const m2 = render();                       // "nova visita" — closure nova
    expect(favChip(m2).classList.contains('active')).toBe(true);
    expect(focUids(m2)).toBe(2);               // Você + u0
    expect(favChip(m2).querySelector('.rc-chip-ct').textContent).toBe('2');
  });

  it('fora do modo Favoritos a legenda NÃO mexe no grupo salvo', () => {
    const m1 = render();
    favChip(m1).click();
    legBtn(m1, 'u0').click();                  // grupo = {ME, u0}
    m1.querySelector('.rc-chip[data-p="podio"]').click();
    expect(m1.querySelector('.rc-chip[data-p="podio"]').classList.contains('active')).toBe(true);
    expect(favChip(m1).classList.contains('active')).toBe(false);
    expect(localStorage.getItem(`rc:mode:${ME}`)).toBeNull();
    legBtn(m1, 'u1').click();                  // seleção livre (modo custom)
    expect(new Set(storedFavs())).toEqual(new Set([ME, 'u0']));  // intacto

    const m2 = render();                       // sem modo salvo → padrão Pódio
    expect(favChip(m2).classList.contains('active')).toBe(false);
    expect(favChip(m2).querySelector('.rc-chip-ct').textContent).toBe('2');  // grupo continua lá
  });

  it('ids que saíram do bolão são descartados no load (e storage corrompido não quebra)', () => {
    localStorage.setItem(`rc:favs:${ME}`, JSON.stringify([ME, 'u0', 'fantasma']));
    localStorage.setItem(`rc:mode:${ME}`, 'fav');
    const m = render();
    expect(focUids(m)).toBe(2);                // fantasma fora

    document.body.innerHTML = '';
    localStorage.setItem(`rc:favs:${ME}`, '{não é json');
    expect(() => render()).not.toThrow();
  });
});
