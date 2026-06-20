import { requireAuth } from '../auth.js';
import { reportFatal } from '../error-reporter.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import { matchPoints, championBonus, scorerBonus, qualifierBonus } from '../scoring.js';
import { heroMeta, wireHScroll } from '../util.js';

// ============================================================
// Regras & Pontuação
// Página 100% estática — todos os NÚMEROS vêm de js/scoring.js (módulo
// canônico, espelho das migrations). Assim a página nunca diverge da engine.
// ============================================================

let profile, stats, settings;

// Fases na ordem do torneio.
const STAGES = [
  { id: 'group', label: 'Grupos',     short: 'Grupos' },
  { id: 'r32',   label: '32-avos',    short: '32-avos' },
  { id: 'r16',   label: 'Oitavas',    short: 'Oitavas' },
  { id: 'qf',    label: 'Quartas',    short: 'Quartas' },
  { id: 'sf',    label: 'Semifinais', short: 'Semis' },
  { id: 'third', label: 'Disputa de 3º lugar', short: '3º lugar' },
  { id: 'final', label: 'Final',      short: 'Final' },
];

const GP = matchPoints('group'); // valores da fase de grupos

// ============================================================
// Estrutura da página
// Uma única lista de seções alimenta o índice (TOC) E o corpo — assim os dois
// nunca saem de sincronia. Os capítulos agrupam as seções numa ordem de leitura
// natural: primeiro o panorama, depois como pontuar, os bônus e, por fim, a parte
// prática (prazos e desempates).
// As funções renderX são hoisted (function declarations), então podem ser
// referenciadas aqui mesmo declaradas mais abaixo no arquivo.
// ============================================================
const SECTIONS = [
  { id: 'como-funciona', nav: 'Como funciona',      title: 'Como funciona',                       render: renderComoFunciona },
  { id: 'premiacao',     nav: 'Premiação',          title: 'Premiação',                           render: renderPremiacao },
  { id: 'pontos-jogo',   nav: 'Pontos por jogo',    title: 'Pontos por jogo',                     render: renderPontosJogo },
  { id: 'fases',         nav: 'Quanto cada fase vale', title: 'Quanto cada fase vale',            render: renderFases },
  { id: 'vaga',          nav: 'Regra da vaga',      title: 'Regra da vaga (mata-mata)',           render: renderVaga },
  { id: 'penaltis',      nav: 'Empate no mata-mata', title: 'Empate no mata-mata',                render: renderPenaltis },
  { id: 'campeao',       nav: 'Campeão',            title: 'Bônus de Campeão',                    render: renderCampeao },
  { id: 'artilheiro',    nav: 'Artilheiro',         title: 'Bônus de Artilheiro',                 render: renderArtilheiro },
  { id: 'classificado',  nav: 'Classificado',       title: 'Bônus de seleção classificada',       render: renderClassificado },
  { id: 'prazos',        nav: 'Prazos',             title: 'Prazos — até quando dá para palpitar', render: renderPrazos },
  { id: 'desempate',     nav: 'Desempates',         title: 'Critérios de desempate',              render: renderDesempate },
];

const CHAPTERS = [
  { label: 'Para começar',           ids: ['como-funciona', 'premiacao'] },
  { label: 'Como você pontua',       ids: ['pontos-jogo', 'fases', 'vaga', 'penaltis'] },
  { label: 'Os três bônus',          ids: ['campeao', 'artilheiro', 'classificado'] },
  { label: 'Na prática',             ids: ['prazos', 'desempate'] },
];

// Índice por id, já com o número sequencial da seção (1..N) para o selo do título.
const SECTION_BY_ID = Object.fromEntries(SECTIONS.map((s, i) => [s.id, { ...s, num: i + 1 }]));

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  const [statsRes, settingsRes] = await Promise.all([
    supabase.from('v_pool_stats').select('*').single(),
    supabase.from('settings').select('key, value'),
  ]);
  stats = statsRes.data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0 };
  // Mesma ideia do resto da página: os números (taxa, divisão de prêmios) vêm da
  // fonte canônica — aqui, a tabela settings, espelho do que o Admin configura.
  settings = Object.fromEntries(
    (settingsRes.data ?? []).map(r => [r.key, typeof r.value === 'string' ? tryParse(r.value) : r.value])
  );

  const pageBody = await renderShell({ active: 'regras', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');
  wireHScroll();
  attachEventListeners();
} catch (err) {
  console.error('[regras] FATAL:', err);
  reportFatal('regras', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:var(--text); font-family:'Figtree',system-ui,-apple-system,sans-serif;">
      <h1 style="color:var(--red)">⚠️ Erro ao carregar Regras</h1>
      <pre style="background:#000; padding:16px; border-radius:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:var(--red);">${err.stack || err.message || err}</pre>
      <p style="margin-top:20px;"><a href="inicio.html" style="color:var(--accent)">← Voltar ao Início</a></p>
    </div>
  `;
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  const toc = CHAPTERS.map(ch => `
    <div class="rules-toc-group">
      <span class="rules-toc-group-label">${ch.label}</span>
      <div class="rules-toc-pills">
        ${ch.ids.map(id => `<a href="#${id}" class="rules-toc-link">${SECTION_BY_ID[id].nav}</a>`).join('')}
      </div>
    </div>
  `).join('');

  const body = CHAPTERS.map(ch => `
    <div class="rules-chapter">
      <span class="rules-chapter-label">${ch.label}</span>
    </div>
    ${ch.ids.map(id => SECTION_BY_ID[id].render()).join('')}
  `).join('');

  return `
    <section class="hero">
      <div class="hero-kicker">Tudo que você precisa saber, explicado com calma</div>
      <h1 class="hero-title">Regras & Pontuação</h1>
      <div class="hero-meta">${heroMeta([
        '<b>104 jogos</b>',
        'Cada acerto soma pontos',
        { html: 'Quanto mais perto da final, mais vale', flow: true },
      ])}</div>
    </section>

    <nav class="rules-toc">${toc}</nav>

    ${body}

    <div class="rules-foot">
      Ficou com dúvida em alguma regra? Fale com a organização do bolão.
    </div>
  `;
}

// ---- 1) Como funciona ----
function renderComoFunciona() {
  return section('como-funciona', `
    <p class="rules-p">
      Você ganha pontos de <strong>quatro formas</strong>, e elas se somam no seu total.
      Vence o bolão quem tiver mais pontos no fim da Copa.
    </p>
    <div class="rules-cards3">
      ${miniCard('⚽', 'Palpites de placar', 'Você dá o placar de cada um dos 104 jogos. Cada parte que você acerta já vale pontos.')}
      ${miniCard('🏆', 'Bônus de Campeão', `Você escolhe quem leva a taça. Se acertar: <strong>+${championBonus(true)} pontos</strong> de uma vez.`)}
      ${miniCard('🥇', 'Bônus de Artilheiro', 'Você escolhe 1 jogador. Cada gol dele soma pontos extras.')}
      ${miniCard('🎟️', 'Bônus de classificado', 'A cada fase do mata-mata, você ganha pontos por acertar quais seleções avançam.')}
    </div>
    <div class="rules-tip">
      💡 Você não precisa entender de conta: é só dar o placar dos jogos. O sistema soma os pontos
      <strong>sozinho</strong>, assim que cada resultado é lançado.
    </div>
  `);
}

// ---- 2) Premiação ----
function renderPremiacao() {
  const fee   = settings?.fee_amount ?? 100;
  const split = settings?.prize_split || { first: 70, second: 20, third: 10 };
  const paid  = stats?.paid_users ?? 0;
  const pot   = paid * fee;

  const prizeRow = (place, pct, medal) => `
    <div class="rules-tier">
      <div class="rules-tier-pts">
        <span class="ico">${medal}</span>
        <span class="pts">${pct}%</span>
      </div>
      <div class="rules-tier-body">
        <div class="rules-tier-name">${place} lugar${pot > 0 ? ` — ${formatBRL(Math.round(pot * pct / 100))}` : ''}</div>
        <div class="rules-tier-desc">${pct}% de todo o dinheiro arrecadado no bolão.</div>
      </div>
    </div>`;

  return section('premiacao', `
    <p class="rules-p">
      O bolão é <strong>pago</strong>: cada participante entra com uma <strong>taxa de inscrição</strong> e
      todo esse dinheiro forma um <strong>caixa único</strong>, que vai inteiro para os primeiros colocados.
      A organização não fica com nada — <strong>tudo é distribuído entre os jogadores</strong>.
    </p>
    <div class="rules-bignum">
      <span class="n">${formatBRL(fee)}</span>
      <span class="l">taxa de inscrição por jogador</span>
    </div>
    <p class="rules-p">
      O <strong>bolso total</strong> é simplesmente a taxa multiplicada por quantos jogadores pagaram —
      então quanto mais gente entra, maior o prêmio. ${pot > 0
        ? `Hoje, com <strong>${paid}</strong> ${paid === 1 ? 'pagante' : 'pagantes'}, o caixa está em <strong>${formatBRL(pot)}</strong>.`
        : `O valor atualizado aparece sempre no topo da tela de <a href="ranking.html">Ranking</a>.`}
    </p>
    <p class="rules-p">Esse bolso é dividido assim entre o <strong>pódio final do bolão</strong>:</p>
    <div class="rules-tiers">
      ${prizeRow('1º', split.first, '🥇')}
      ${prizeRow('2º', split.second, '🥈')}
      ${prizeRow('3º', split.third, '🥉')}
    </div>
    <div class="rules-tip">
      💡 Só entra na disputa do prêmio quem <strong>pagou a inscrição</strong> e teve o pagamento confirmado
      pela organização. Combine a forma de pagamento com quem organiza o bolão; o acompanhamento ao vivo de
      quanto cada posição vai levar fica na página de <a href="ranking.html">Ranking</a>.
    </div>
  `);
}

// ---- 3) Pontos por jogo (modelo aditivo) ----
function renderPontosJogo() {
  const rows = [
    { icon: '🥅', pts: GP.ag,  name: 'Acertou os gols de um time',
      desc: 'Para cada seleção em que você acertar quantos gols ela fez, você ganha esses pontos. Pode valer pelos dois times.' },
    { icon: '⚽', pts: GP.ave, name: 'Acertou quem vence (ou o empate)',
      desc: 'Se você acertar qual time venceu — ou que o jogo terminaria empatado.' },
    { icon: '➕', pts: GP.dg,  name: 'Acertou a diferença de gols',
      desc: 'Se você acertar por quantos gols o jogo terminou (ex.: vitória por 2). O empate também conta como diferença certa.' },
  ].map(t => `
    <div class="rules-tier">
      <div class="rules-tier-pts">
        <span class="ico">${t.icon}</span>
        <span class="pts">+${t.pts}</span>
      </div>
      <div class="rules-tier-body">
        <div class="rules-tier-name">${t.name}</div>
        <div class="rules-tier-desc">${t.desc}</div>
      </div>
    </div>
  `).join('');

  return section('pontos-jogo', `
    <p class="rules-p">
      Em cada jogo, <strong>cada acerto soma</strong> — você não precisa cravar o placar para pontuar.
      Estes são os valores na <strong>fase de grupos</strong> (nas fases seguintes valem mais):
    </p>
    <div class="rules-tiers">${rows}</div>
    <div class="rules-example">
      <div class="rules-example-head">Exemplo</div>
      <p>O jogo terminou <strong>Brasil 3 × 1 Suíça</strong>.</p>
      <p>Se você tinha palpitado <strong>2 × 0</strong>: acertou que o Brasil venceria (+${GP.ave}) e que a
        diferença seria de 2 gols (+${GP.dg}) → <strong>${GP.ave + GP.dg} pontos</strong>.</p>
      <p class="rules-example-result">Se tivesse cravado <strong>3 × 1</strong>, somaria tudo:
        os gols dos dois times (+${GP.ag} e +${GP.ag}), o vencedor (+${GP.ave}) e a diferença (+${GP.dg}) =
        <strong>${GP.exact} pontos</strong> (o máximo de um jogo de grupos).</p>
    </div>
  `);
}

// ---- 4) Quanto cada fase vale ----
function renderFases() {
  const head = STAGES.map(s => `<th>${s.short}</th>`).join('');
  const row = (label, pick, hl) => `
    <tr ${hl ? 'class="rules-matrix-mult"' : ''}>
      <td class="rules-matrix-label">${label}</td>
      ${STAGES.map(s => {
        const v = pick(matchPoints(s.id));
        return `<td class="${hl ? '' : ''}">${v}</td>`;
      }).join('')}
    </tr>`;

  return section('fases', `
    <p class="rules-p">
      Quanto mais decisivo o jogo, <strong>mais pontos ele vale</strong>. Um placar exato na
      <strong>final</strong> vale <strong>${matchPoints('final').exact}</strong> pontos — contra
      <strong>${GP.exact}</strong> de um jogo de grupos. É por isso que <strong>a emoção fica para o fim</strong>:
      mesmo quem não foi bem nos grupos pode virar o jogo no mata-mata.
    </p>
    <div class="rules-table-wrap hscroll"><div class="hscroll-in">
      <table class="rules-matrix">
        <thead>
          <tr><th class="rules-matrix-label">Acerto →</th>${head}</tr>
        </thead>
        <tbody>
          ${row('🥅 Gols de um time', p => '+' + p.ag)}
          ${row('⚽ Vencedor / empate', p => '+' + p.ave)}
          ${row('➕ Diferença de gols', p => '+' + p.dg)}
          ${row('🎯 Placar exato', p => p.exact, true)}
        </tbody>
      </table>
    </div></div>
    <div class="rules-tip">
      💡 A linha <strong>Placar exato</strong> é o máximo que um jogo daquela fase pode dar
      (a soma de todos os acertos).
    </div>
  `);
}

// ---- 5) Regra da vaga ----
function renderVaga() {
  return section('vaga', `
    <p class="rules-p">
      No mata-mata você não aposta numa seleção específica — você dá o <strong>placar de uma vaga do
      chaveamento</strong> (por exemplo: "1º do Grupo A × 2º do Grupo B"). Seu palpite de gols vale para
      <strong>quem realmente se classificar naquela posição</strong>, mesmo que não seja a seleção que você imaginava.
    </p>
    <div class="rules-example">
      <div class="rules-example-head">Exemplo</div>
      <p>
        No jogo "1º do Grupo A × 2º do Grupo B" você achava que seria
        <strong>França × Argentina</strong> e apostou <strong>1 × 0</strong>.
        Na vida real, quem se classificou nessas posições foi <strong>África do Sul × Nigéria</strong>.
      </p>
      <p class="rules-example-result">
        → Seu palpite passa a valer como <strong>África do Sul 1 × 0 Nigéria</strong> e é contado contra o
        resultado real desse jogo. Você ainda pode pontuar normalmente.
      </p>
    </div>
    <div class="rules-tip">
      💡 Na tela <a href="palpites-mata.html">Mata-mata</a>, as bandeiras que aparecem nas vagas são
      apenas uma ideia baseada nos <em>seus</em> palpites — não mudam a pontuação.
    </div>
  `);
}

// ---- 6) Pênaltis ----
function renderPenaltis() {
  return section('penaltis', `
    <p class="rules-p">
      Se você acha que um jogo de mata-mata vai terminar <strong>empatado</strong>, escolha também
      <strong>quem passa nos pênaltis</strong>. Essa escolha define o "vencedor" do seu palpite.
    </p>
    <ul class="rules-list">
      <li>Vale o <strong>placar do tempo normal</strong> para os pontos de gols e de diferença.</li>
      <li>Se você cravar o placar do tempo normal, leva o <strong>placar exato</strong> — mesmo que erre quem ganhou nos pênaltis.</li>
      <li>Na fase de grupos não há pênaltis: empate é empate.</li>
    </ul>
  `);
}

// ---- 7) Campeão ----
function renderCampeao() {
  return section('campeao', `
    <p class="rules-p">
      Antes da Copa começar, você escolhe a seleção que acha que vai <strong>levantar a taça</strong>.
      Se acertar o campeão, ganha <strong>+${championBonus(true)} pontos</strong> de bônus.
    </p>
    <div class="rules-bignum">
      <span class="n">+${championBonus(true)}</span>
      <span class="l">pontos se você acertar o campeão</span>
    </div>
    <div class="rules-tip">
      💡 É um dos palpites mais valiosos do bolão — vale como ${Math.round(championBonus(true) / GP.exact)}
      placares exatos da fase de grupos. E como só é decidido no último jogo, ajuda a manter a emoção até o fim.
    </div>
  `);
}

// ---- 8) Artilheiro ----
function renderArtilheiro() {
  const cells = STAGES.map(s => `
    <div class="rules-scorer-col">
      <div class="rules-scorer-stage">${s.short}</div>
      <div class="rules-scorer-val">+${scorerBonus(1, s.id)}</div>
      <div class="rules-scorer-per">por gol</div>
    </div>
  `).join('');

  return section('artilheiro', `
    <p class="rules-p">
      Você escolhe <strong>1 jogador</strong> antes da Copa. Cada gol que ele marcar soma pontos —
      e gols nas fases finais valem mais (<strong>+${scorerBonus(1, 'group')} por gol</strong> nos grupos,
      chegando a <strong>+${scorerBonus(1, 'final')} por gol</strong> na final).
    </p>
    <div class="rules-scorer-grid">${cells}</div>
    <div class="rules-tip">
      💡 Escolher o artilheiro de uma seleção que vai longe na Copa rende mais pontos.
    </div>
  `);
}

// ---- 9) Classificado (BPE/BP) ----
function renderClassificado() {
  const PH = [
    { id: 'r32',   label: '32-avos' },
    { id: 'r16',   label: 'Oitavas' },
    { id: 'qf',    label: 'Quartas' },
    { id: 'sf',    label: 'Semis' },
    { id: 'third', label: '3º lugar' },
    { id: 'final', label: 'Final' },
  ];
  const head = PH.map(p => `<th>${p.label}</th>`).join('');
  const bpeRow = PH.map(p => `<td class="hl">+${qualifierBonus(p.id, true)}</td>`).join('');
  const bpRow = PH.map(p => {
    const v = qualifierBonus(p.id, false);
    return `<td>${v === 0 ? '—' : '+' + v}</td>`;
  }).join('');

  return section('classificado', `
    <p class="rules-p">
      Além do placar, você ganha pontos por <strong>acertar qual seleção chega a cada fase do mata-mata</strong>
      — com base em quem os <em>seus palpites</em> fazem avançar. São dois casos:
    </p>
    <ul class="rules-list">
      <li><strong>Posição exata:</strong> a seleção que você previu para aquela vaga é exatamente quem se classificou ali.</li>
      <li><strong>Time certo, vaga errada:</strong> a seleção chegou àquela fase, mas em outra posição. Vale a <strong>metade</strong>.</li>
    </ul>
    <p class="rules-p">Soma a cada fase: uma seleção que você acompanha corretamente fase após fase rende bônus em todas elas.</p>
    <div class="rules-table-wrap hscroll"><div class="hscroll-in">
      <table class="rules-matrix">
        <thead>
          <tr><th class="rules-matrix-label">Acerto →</th>${head}</tr>
        </thead>
        <tbody>
          <tr><td class="rules-matrix-label">✓ Posição exata</td>${bpeRow}</tr>
          <tr><td class="rules-matrix-label">~ Vaga errada</td>${bpRow}</tr>
        </tbody>
      </table>
    </div></div>
    <div class="rules-tip">
      💡 Acertar o caminho das seleções é mais <strong>sorte</strong> do que ciência, então esse bônus é
      pequeno de propósito: dá um tempero, mas quem decide o bolão é o acerto dos placares.
    </div>
  `);
}

// ---- 10) Desempate ----
function renderDesempate() {
  return section('desempate', `
    <p class="rules-p">
      No fim, dois jogadores podem terminar com a <strong>mesma pontuação</strong>. Quando isso acontece, o
      sistema desempata <strong>na ordem abaixo</strong> — só passa para o próximo critério se o anterior
      continuar empatado. É tudo automático: ninguém decide no "par ou ímpar".
    </p>

    <div class="rules-two">
      <div class="rules-half">
        <div class="rules-half-title">🏆 Classificação dos grupos (seleções)</div>
        <p class="rules-p">Para decidir quais <strong>seleções</strong> avançam quando empatam em pontos no grupo (ordem oficial da Copa 2026):</p>
        <ol class="rules-ord">
          <li>Pontos no grupo</li>
          <li>Confronto direto (entre as seleções empatadas)</li>
          <li>Saldo de gols</li>
          <li>Gols marcados</li>
          <li>Fair play (menos cartões amarelos e vermelhos)</li>
          <li>Ranking da FIFA (melhor posição passa)</li>
        </ol>
        <p class="rules-p" style="font-size:.85em; color:var(--text-mute);">
          Entre os melhores 3ºs colocados (grupos diferentes) não há confronto direto:
          pontos → saldo → gols → fair play → ranking da FIFA.
        </p>
      </div>
      <div class="rules-half">
        <div class="rules-half-title">👥 Ranking do bolão (participantes)</div>
        <p class="rules-p">Para decidir a ordem entre <strong>você e os outros jogadores</strong>:</p>
        <ol class="rules-ord">
          <li>Mais pontos no total</li>
          <li>Mais placares exatos (cravados)</li>
          <li>Mais acertos de vencedor + saldo</li>
          <li>Empatou em tudo? <strong>Rateio</strong> — dividem a posição e o prêmio</li>
        </ol>
      </div>
    </div>

    <p class="rules-p" style="margin-top:20px;">
      <strong>O desempate entre participantes, passo a passo</strong> — com exemplos:
    </p>

    <div class="rules-tiers">
      <div class="rules-tier">
        <div class="rules-tier-pts"><span class="pts">1</span></div>
        <div class="rules-tier-body">
          <div class="rules-tier-name">Mais pontos no total</div>
          <div class="rules-tier-desc">
            O total soma <strong>tudo</strong>: pontos dos jogos + Campeão + Artilheiro + Classificados.
            Quem tiver mais pontos fica na frente — <strong>a grande maioria dos empates termina aqui</strong>.
          </div>
          <div class="rules-tier-ex"><b>Exemplo:</b> Ana terminou com <strong>152</strong> e Bruno com <strong>148</strong> → Ana fica na frente.</div>
        </div>
      </div>

      <div class="rules-tier">
        <div class="rules-tier-pts"><span class="pts">2</span></div>
        <div class="rules-tier-body">
          <div class="rules-tier-name">Mais placares exatos (cravados)</div>
          <div class="rules-tier-desc">
            Empataram no total? Passa à frente quem <strong>cravou mais placares</strong> — acertou em cheio o
            resultado (palpitou 2 × 1 e o jogo terminou 2 × 1). Cravar é o acerto mais difícil, então premia quem foi mais preciso.
          </div>
          <div class="rules-tier-ex"><b>Exemplo:</b> Ana e Bruno empatam com <strong>150 pts</strong>. Ana cravou <strong>11</strong> placares e Bruno <strong>9</strong> → Ana fica na frente.</div>
        </div>
      </div>

      <div class="rules-tier">
        <div class="rules-tier-pts"><span class="pts">3</span></div>
        <div class="rules-tier-body">
          <div class="rules-tier-name">Mais acertos de vencedor + saldo</div>
          <div class="rules-tier-desc">
            Ainda empatados? Conta quem, entre os palpites que <em>não</em> foram cravados, acertou ao mesmo
            tempo <strong>quem venceu e o saldo de gols</strong> — o "quase cravou" (palpitou 2 × 0 e deu 3 × 1:
            acertou o vencedor e o saldo de 2 gols).
          </div>
          <div class="rules-tier-ex"><b>Exemplo:</b> Ana e Bruno empatam em <strong>150 pts</strong> e <strong>9 exatos</strong>. Ana fez vencedor + saldo em <strong>20</strong> jogos e Bruno em <strong>17</strong> → Ana fica na frente.</div>
        </div>
      </div>

      <div class="rules-tier">
        <div class="rules-tier-pts"><span class="pts">4</span></div>
        <div class="rules-tier-body">
          <div class="rules-tier-name">Rateio do prêmio — regra SBC 2022</div>
          <div class="rules-tier-desc">
            Se mesmo assim continuarem <strong>idênticos</strong> (mesmos pontos, mesmos exatos e mesmos vencedor + saldo),
            não há como separá-los: os dois ficam na <strong>mesma posição</strong> (ex.: dois "2º lugar") e, quando a
            posição é premiada, os prêmios das casas que eles ocupam são <strong>somados e divididos por igual</strong> —
            o <strong>rateio</strong>. Campanhas idênticas, prêmio idêntico.
          </div>
        </div>
      </div>
    </div>

    <div class="rules-example">
      <div class="rules-example-head">Exemplo de rateio</div>
      <p>Suponha um bolso de <strong>R$ 2.000</strong>, dividido em <strong>70% / 20% / 10%</strong> →
        1º = <strong>R$ 1.400</strong>, 2º = <strong>R$ 400</strong>, 3º = <strong>R$ 200</strong>.</p>
      <p><strong>Dois empatam em 1º:</strong> ocupam as casas de 1º e 2º. Soma-se R$ 1.400 + R$ 400 = R$ 1.800
        e divide por 2 → <strong>R$ 900 para cada um</strong>. O próximo colocado cai para 3º e leva os R$ 200.</p>
      <p class="rules-example-result"><strong>Dois empatam em 2º:</strong> o 1º leva os R$ 1.400 cheios; os empatados
        ocupam as casas de 2º e 3º → (R$ 400 + R$ 200) ÷ 2 = <strong>R$ 300 para cada um</strong>.</p>
    </div>

    <div class="rules-tip">
      💡 No <a href="ranking.html">Ranking</a>, jogadores empatados aparecem com o <strong>mesmo número de
      posição</strong> e um marcador de empate <strong>(=)</strong>, e o prêmio já mostra o valor do rateio.
    </div>
  `);
}

// ---- 11) Prazos ----
function renderPrazos() {
  return section('prazos', `
    <div class="rules-tip" style="border-left-color: var(--red); margin-top:0; margin-bottom:16px;">
      ⏰ <strong style="color:var(--text);">A regra mais importante:</strong> cada palpite de placar
      <strong style="color:var(--text);">fecha às 23h59 (horário de Brasília) da véspera do jogo</strong> —
      ou seja, na noite anterior. Depois disso, aquele palpite não pode mais ser alterado.
    </div>
    <ul class="rules-list">
      <li><strong>Exemplo:</strong> um jogo no dia 15, às 16h, fecha para palpites no dia <strong>14, às 23h59</strong>.</li>
      <li>Você pode <strong>criar e mudar</strong> o palpite quantas vezes quiser — até esse horário da véspera.</li>
      <li>Cada jogo tem seu próprio prazo (a véspera dele). Na tela de palpites, os jogos já fechados aparecem marcados como <strong>"Travado"</strong>.</li>
      <li>Os palpites de <strong>Campeão</strong> e <strong>Artilheiro</strong> fecham num <strong>prazo único</strong>, na véspera do primeiro jogo da Copa.</li>
      <li>Não deixe para a última hora: passada a véspera, não dá mais para palpitar aquele jogo.</li>
    </ul>
  `);
}

// ============================================================
// Helpers de render
// ============================================================
function section(id, body) {
  const { num, title } = SECTION_BY_ID[id];
  return `
    <section class="rules-section" id="${id}">
      <div class="rules-section-head">
        <span class="rules-section-num">${num}</span>
        <h2>${title}</h2>
      </div>
      <div class="rules-section-body">${body}</div>
    </section>
  `;
}

function tryParse(s) { try { return JSON.parse(s); } catch { return s; } }

function formatBRL(value) {
  return `R$ ${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function miniCard(icon, title, text) {
  return `
    <div class="rules-mini">
      <div class="rules-mini-ico">${icon}</div>
      <div class="rules-mini-title">${title}</div>
      <div class="rules-mini-text">${text}</div>
    </div>
  `;
}

// ============================================================
// Eventos — scroll suave da TOC
// ============================================================
function attachEventListeners() {
  const links = [...document.querySelectorAll('.rules-toc-link')];

  // Rolagem suave ao clicar no índice.
  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const id = link.getAttribute('href').slice(1);
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Scrollspy: destaca no índice a seção que está em foco na tela.
  const linkById = new Map(links.map(l => [l.getAttribute('href').slice(1), l]));
  const setActive = (id) => links.forEach(l => l.classList.toggle('active', l === linkById.get(id)));

  const observer = new IntersectionObserver((entries) => {
    // Pega a seção visível mais próxima do topo.
    const visible = entries
      .filter(e => e.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (visible) setActive(visible.target.id);
  }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });

  document.querySelectorAll('.rules-section').forEach(s => observer.observe(s));
}
