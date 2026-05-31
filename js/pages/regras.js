import { requireAuth } from '../auth.js';
import { renderShell } from '../sidebar.js';
import { supabase } from '../supabase.js';
import { stageMultiplier, championBonus, scorerBonus, scorePrediction, qualifierBonus } from '../scoring.js';

// ============================================================
// Regras & Pontuação
// Página 100% estática — todos os NÚMEROS vêm de js/scoring.js
// (módulo canônico, espelho de 003_scoring.sql). Assim a página
// de regras nunca diverge da engine real.
// ============================================================

let profile, stats;

// Fases na ordem do torneio. Multiplicadores vêm de stageMultiplier().
const STAGES = [
  { id: 'group', label: 'Grupos',     short: 'Grupos' },
  { id: 'r32',   label: '32-avos',    short: '32-avos' },
  { id: 'r16',   label: 'Oitavas',    short: 'Oitavas' },
  { id: 'qf',    label: 'Quartas',    short: 'Quartas' },
  { id: 'sf',    label: 'Semifinais', short: 'Semis' },
  { id: 'third', label: 'Disputa de 3º lugar', short: '3º lugar' },
  { id: 'final', label: 'Final',      short: 'Final' },
];

// Tiers de acerto por jogo (base, antes do multiplicador).
// A base sai da própria engine (scorePrediction em grupo = ×1).
const TIERS = [
  {
    base: scorePrediction(2, 1, null, 2, 1, null, 'group'),       // 5
    icon: '🎯', name: 'Placar exato',
    desc: 'Você cravou os dois placares (ex.: previu 2×1 e o jogo terminou 2×1).',
  },
  {
    base: scorePrediction(3, 1, null, 2, 0, null, 'group'),       // 3
    icon: '⚽', name: 'Vencedor + saldo de gols',
    desc: 'Acertou quem venceu (ou o empate) E a diferença de gols, mas não o placar exato (ex.: previu 3×1, deu 2×0).',
  },
  {
    base: scorePrediction(2, 0, null, 1, 0, null, 'group'),       // 2
    icon: '✓', name: 'Só o vencedor / empate',
    desc: 'Acertou quem venceu ou que seria empate, com saldo diferente (ex.: previu 2×0, deu 1×0).',
  },
  {
    base: scorePrediction(2, 0, null, 2, 3, null, 'group'),       // 1
    icon: '🥅', name: 'Gols de um lado',
    desc: 'Errou o vencedor, mas acertou em cheio quantos gols um dos times fez (ex.: previu 2×0, deu 2×3 — acertou os 2 da casa).',
  },
  {
    base: 0,
    icon: '✗', name: 'Errou tudo',
    desc: 'Nenhuma das condições acima.',
  },
];

// ============================================================
// Main
// ============================================================
try {
  const auth = await requireAuth();
  if (!auth) throw new Error('not authed');
  profile = auth.profile;

  const { data } = await supabase.from('v_pool_stats').select('*').single();
  stats = data ?? { finished_matches: 0, total_matches: 104, pct_played: 0, paid_users: 0 };

  const pageBody = await renderShell({ active: 'regras', profile, stats });
  pageBody.innerHTML = renderPage();
  pageBody.classList.add('fade-up');
  attachEventListeners();
} catch (err) {
  console.error('[regras] FATAL:', err);
  document.body.innerHTML = `
    <div style="padding:40px; max-width:720px; margin:40px auto; background:#181818; border-radius:12px; color:#fff; font-family:sans-serif;">
      <h1 style="color:#f15e6c">⚠️ Erro ao carregar Regras</h1>
      <pre style="background:#000; padding:16px; border-radius:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:#f15e6c;">${err.stack || err.message || err}</pre>
      <p style="margin-top:20px;"><a href="inicio.html" style="color:#f4c430">← Voltar ao Início</a></p>
    </div>
  `;
}

// ============================================================
// Render
// ============================================================
function renderPage() {
  return `
    <section class="hero">
      <div class="hero-kicker">Tudo que você precisa saber</div>
      <h1 class="hero-title">Regras & Pontuação</h1>
      <div class="hero-meta">
        <b>104 jogos</b><span class="sep"></span>
        3 formas de pontuar<span class="sep"></span>
        Quanto mais avança a Copa, mais valem os pontos
      </div>
    </section>

    <nav class="rules-toc">
      ${[
        ['como-funciona', 'Como funciona'],
        ['pontos-jogo', 'Pontos por jogo'],
        ['multiplicadores', 'Multiplicadores'],
        ['vaga', 'Regra da vaga'],
        ['penaltis', 'Empate no mata-mata'],
        ['campeao', 'Campeão'],
        ['artilheiro', 'Artilheiro'],
        ['classificado', 'Bônus de classificado'],
        ['desempate', 'Desempates'],
        ['prazos', 'Prazos & travas'],
      ].map(([id, label]) => `<a href="#${id}" class="rules-toc-link">${label}</a>`).join('')}
    </nav>

    ${renderComoFunciona()}
    ${renderPontosJogo()}
    ${renderMultiplicadores()}
    ${renderVaga()}
    ${renderPenaltis()}
    ${renderCampeao()}
    ${renderArtilheiro()}
    ${renderClassificado()}
    ${renderDesempate()}
    ${renderPrazos()}

    <div class="rules-foot">
      Dúvidas sobre alguma regra? Fale com a organização do bolão.
    </div>
  `;
}

// ---- 1) Como funciona ----
function renderComoFunciona() {
  return section('como-funciona', '1', 'Como funciona', `
    <p class="rules-p">
      Você ganha pontos de <strong>três formas</strong> que somam no seu total. Vence o bolão
      quem tiver mais pontos ao fim da Copa.
    </p>
    <div class="rules-cards3">
      ${miniCard('⚽', 'Palpites de placar', 'Você prevê o placar de cada um dos 104 jogos. Cada acerto vale pontos, multiplicados conforme a fase.')}
      ${miniCard('🏆', 'Bônus de Campeão', `Escolhe quem leva a taça. Acertou? <strong>+${championBonus(true)} pts</strong> de uma vez.`)}
      ${miniCard('🥇', 'Bônus de Artilheiro', 'Escolhe 1 jogador. Cada gol dele rende pontos extras que escalam com a fase.')}
    </div>
    <div class="rules-tip">
      💡 Os pontos dos jogos são <strong>recalculados automaticamente</strong> assim que a organização
      lança cada resultado — não precisa fazer nada.
    </div>
  `);
}

// ---- 2) Pontos por jogo ----
function renderPontosJogo() {
  const rows = TIERS.map(t => `
    <div class="rules-tier ${t.base === 0 ? 'zero' : ''}">
      <div class="rules-tier-pts">
        <span class="ico">${t.icon}</span>
        <span class="pts">${t.base}<small>pt${t.base === 1 ? '' : 's'}</small></span>
      </div>
      <div class="rules-tier-body">
        <div class="rules-tier-name">${t.name}</div>
        <div class="rules-tier-desc">${t.desc}</div>
      </div>
    </div>
  `).join('');

  return section('pontos-jogo', '2', 'Pontos por jogo', `
    <p class="rules-p">
      Cada palpite recebe a pontuação do <strong>melhor acerto que se encaixar</strong> —
      não acumula. Esses são os pontos-base da fase de grupos; nas fases seguintes eles são
      multiplicados (veja a seção abaixo).
    </p>
    <div class="rules-tiers">${rows}</div>
    <div class="rules-tip">
      💡 Repare: o <strong>placar exato</strong> (${TIERS[0].base} pts) já inclui o acerto do vencedor
      e do saldo — você sempre leva o maior valor possível, nunca a soma.
    </div>
  `);
}

// ---- 3) Multiplicadores ----
function renderMultiplicadores() {
  const head = STAGES.map(s => `<th>${s.short}</th>`).join('');

  const multRow = STAGES.map(s => {
    const m = stageMultiplier(s.id);
    return `<td class="mult-cell">×${fmt(m)}</td>`;
  }).join('');

  // Linhas: cada tier base × mult de cada fase
  const tierRows = TIERS.filter(t => t.base > 0).map(t => {
    const cells = STAGES.map(s => {
      const v = Math.round(t.base * stageMultiplier(s.id));
      const isMax = t.base === TIERS[0].base;
      return `<td class="${isMax ? 'hl' : ''}">${v}</td>`;
    }).join('');
    return `
      <tr>
        <td class="rules-matrix-label"><span class="ico">${t.icon}</span> ${t.name}</td>
        ${cells}
      </tr>
    `;
  }).join('');

  return section('multiplicadores', '3', 'Multiplicadores por fase', `
    <p class="rules-p">
      Quanto mais decisivo o jogo, mais ele vale. O placar de uma <strong>final</strong> vale
      <strong>×${fmt(stageMultiplier('final'))}</strong> o de um jogo de grupos — então a Copa
      fica em aberto até o fim e dá pra virar o jogo no mata-mata.
    </p>
    <div class="rules-table-wrap">
      <table class="rules-matrix">
        <thead>
          <tr><th class="rules-matrix-label">Fase →</th>${head}</tr>
        </thead>
        <tbody>
          <tr class="rules-matrix-mult">
            <td class="rules-matrix-label">Multiplicador</td>
            ${multRow}
          </tr>
          ${tierRows}
        </tbody>
      </table>
    </div>
    <div class="rules-tip">
      💡 Os valores na tabela já são os <strong>pontos finais</strong> de cada acerto por fase
      (base × multiplicador, arredondado). Ex.: placar exato na final = ${TIERS[0].base} × ${fmt(stageMultiplier('final'))} =
      <strong>${Math.round(TIERS[0].base * stageMultiplier('final'))} pts</strong>.
    </div>
  `);
}

// ---- 4) Regra da vaga ----
function renderVaga() {
  return section('vaga', '4', 'Regra da vaga (mata-mata)', `
    <p class="rules-p">
      No mata-mata você não aposta num time específico — você aposta no <strong>placar de uma vaga
      do chaveamento</strong> (ex.: "1º do Grupo A × 2º do Grupo B"). Seu palpite de gols vale para
      <strong>quem realmente se classificar naquela posição</strong>, mesmo que não seja o time que
      você imaginava.
    </p>
    <div class="rules-example">
      <div class="rules-example-head">Exemplo</div>
      <p>
        No jogo "1º do Grupo A × 2º do Grupo B" você achava que seria
        <strong>França × Argentina</strong> e apostou <strong>1 × 0</strong>.
        Na real, quem classificou nessas posições foi <strong>África do Sul × Nigéria</strong>.
      </p>
      <p class="rules-example-result">
        → Seu palpite passa a valer como <strong>África do Sul 1 × 0 Nigéria</strong> e é pontuado
        contra o resultado real desse jogo. Você ainda pode tirar placar exato, vencedor, etc.
      </p>
    </div>
    <div class="rules-tip">
      💡 Na tela <a href="palpites-mata.html">Mata-mata</a>, as bandeiras que aparecem nas vagas são
      apenas um guia visual baseado nos <em>seus</em> palpites — não afetam a pontuação.
    </div>
  `);
}

// ---- 5) Pênaltis ----
function renderPenaltis() {
  return section('penaltis', '5', 'Empate no mata-mata', `
    <p class="rules-p">
      Se você prevê um <strong>empate</strong> num jogo de mata-mata, escolha também
      <strong>quem passa nos pênaltis</strong>. Esse palpite define o "vencedor" do seu prognóstico
      para fins de pontuação.
    </p>
    <ul class="rules-list">
      <li>O <strong>placar do tempo normal</strong> é o que conta para o acerto de gols e saldo.</li>
      <li>Se você cravar o placar do tempo normal, leva o <strong>placar exato</strong> — mesmo que erre quem ganhou nos pênaltis.</li>
      <li>Na fase de grupos não há pênaltis: empate é empate.</li>
    </ul>
  `);
}

// ---- 6) Campeão ----
function renderCampeao() {
  return section('campeao', '6', 'Bônus de Campeão', `
    <p class="rules-p">
      Antes do prazo, você escolhe a seleção que acha que vai <strong>levantar a taça</strong>.
      Se acertar o campeão, ganha <strong>+${championBonus(true)} pontos</strong> de bônus (valor fixo,
      independente da fase).
    </p>
    <div class="rules-bignum">
      <span class="n">+${championBonus(true)}</span>
      <span class="l">pontos se acertar o campeão</span>
    </div>
    <div class="rules-tip">
      💡 É o palpite mais valioso do bolão — equivale a ${Math.round(championBonus(true) / TIERS[0].base)}
      placares exatos da fase de grupos. Vale a pena pensar bem.
    </div>
  `);
}

// ---- 7) Artilheiro ----
function renderArtilheiro() {
  const cells = STAGES.map(s => `
    <div class="rules-scorer-col">
      <div class="rules-scorer-stage">${s.short}</div>
      <div class="rules-scorer-val">+${scorerBonus(1, s.id)}</div>
      <div class="rules-scorer-per">por gol</div>
    </div>
  `).join('');

  return section('artilheiro', '7', 'Bônus de Artilheiro', `
    <p class="rules-p">
      Você escolhe <strong>1 jogador</strong> antes do prazo. Cada gol que ele marcar rende pontos
      extras — e, como nos placares, gols em fases mais adiantadas valem mais
      (<strong>+${scorerBonus(1, 'group')} por gol</strong> na fase de grupos, escalando até
      <strong>+${scorerBonus(1, 'final')} por gol</strong> na final).
    </p>
    <div class="rules-scorer-grid">${cells}</div>
    <div class="rules-tip">
      💡 Fórmula: <strong>nº de gols × ${scorerBonus(1, 'group')} × multiplicador da fase</strong>.
      Escolher um artilheiro de uma seleção que vai longe na Copa multiplica seus pontos.
    </div>
  `);
}

// ---- 8) Bônus de classificado (BPE/BP) ----
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
  const bpeRow = PH.map(p => `<td class="hl">${qualifierBonus(p.id, true)}</td>`).join('');
  const bpRow = PH.map(p => {
    const v = qualifierBonus(p.id, false);
    return `<td>${v === 0 ? '—' : v}</td>`;
  }).join('');

  return section('classificado', '8', 'Bônus de seleção classificada', `
    <p class="rules-p">
      Além do placar, você ganha pontos por <strong>acertar qual seleção chega a cada vaga do mata-mata</strong>
      — com base em quem os <em>seus palpites</em> fazem avançar. São dois tipos:
    </p>
    <ul class="rules-list">
      <li><strong>Posição exata (BPE):</strong> a seleção que você previu para aquela vaga é exatamente quem se classificou ali.</li>
      <li><strong>Time certo, vaga errada (BP):</strong> a seleção chegou àquela fase, mas em outra vaga. Vale <strong>metade</strong> do BPE.</li>
    </ul>
    <p class="rules-p">É cumulativo: um time que você acompanha corretamente fase após fase rende bônus em cada uma.</p>
    <div class="rules-table-wrap">
      <table class="rules-matrix">
        <thead>
          <tr><th class="rules-matrix-label">Fase →</th>${head}</tr>
        </thead>
        <tbody>
          <tr>
            <td class="rules-matrix-label">✓ Posição exata (BPE)</td>
            ${bpeRow}
          </tr>
          <tr>
            <td class="rules-matrix-label">~ Vaga errada (BP)</td>
            ${bpRow}
          </tr>
        </tbody>
      </table>
    </div>
    <div class="rules-tip">
      💡 Não há BP nos 32-avos (quase todo time está nessa fase, seria só sorte). E lembre:
      acertar o chaveamento é, por natureza, mais <strong>sorte</strong> do que habilidade — por isso esse bônus
      é propositalmente <strong>modesto</strong>, pra não passar por cima de quem cravou mais placares.
    </div>
  `);
}

// ---- 9) Desempate ----
function renderDesempate() {
  return section('desempate', '9', 'Critérios de desempate', `
    <div class="rules-two">
      <div class="rules-half">
        <div class="rules-half-title">Classificação dos grupos</div>
        <p class="rules-p">Para decidir quem avança quando os times empatam em pontos:</p>
        <ol class="rules-ord">
          <li>Pontos</li>
          <li>Saldo de gols</li>
          <li>Gols marcados (pró)</li>
          <li>Ranking FIFA (melhor posição passa)</li>
        </ol>
      </div>
      <div class="rules-half">
        <div class="rules-half-title">Ranking do bolão</div>
        <p class="rules-p">Para decidir o vencedor quando dois apostadores empatam em pontos:</p>
        <ol class="rules-ord">
          <li>Total de pontos</li>
          <li>Quantidade de placares exatos</li>
          <li>Quantidade de acertos de vencedor + saldo</li>
        </ol>
      </div>
    </div>
  `);
}

// ---- 10) Prazos ----
function renderPrazos() {
  return section('prazos', '10', 'Prazos & travas', `
    <ul class="rules-list">
      <li>Cada palpite de placar <strong>trava no apito inicial</strong> daquele jogo. Antes disso, pode editar à vontade — salva automático.</li>
      <li>Os palpites de <strong>Campeão</strong> e <strong>Artilheiro</strong> travam num prazo único, antes do início da Copa.</li>
      <li>Depois de travado, o palpite não pode mais ser alterado.</li>
      <li>As vagas do mata-mata viram times reais automaticamente assim que o último jogo de cada grupo é lançado.</li>
    </ul>
  `);
}

// ============================================================
// Helpers de render
// ============================================================
function section(id, num, title, body) {
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

function miniCard(icon, title, text) {
  return `
    <div class="rules-mini">
      <div class="rules-mini-ico">${icon}</div>
      <div class="rules-mini-title">${title}</div>
      <div class="rules-mini-text">${text}</div>
    </div>
  `;
}

// Formata multiplicador: 1.5 → "1,5", 2 → "2"
function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

// ============================================================
// Eventos — scroll suave da TOC
// ============================================================
function attachEventListeners() {
  document.querySelectorAll('.rules-toc-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const id = link.getAttribute('href').slice(1);
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}
