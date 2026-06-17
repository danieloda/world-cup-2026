/**
 * Relatório legível de cada lacre de integridade — o artefato para mostrar a
 * NÃO TÉCNICOS o que travou e como conferir. Gerado por snapshot.js a cada
 * lacre novo, em integrity/reports/NNNN_AAAA-MM-DD.md, commitado pela mesma
 * GitHub Action e linkado na mensagem do Telegram.
 *
 * O relatório é DERIVADO — a prova são os bytes de snapshots/ + manifest.json
 * (hash encadeado). Ele não entra no hash; adulterá-lo não engana o verify.js.
 * Por isso este módulo é uma função PURA (dados → string): sem banco, sem fs,
 * sem rede — testável em tests/unit/integrity-report.test.js.
 *
 * Seleções aparecem com a MESMA tradução PT-BR do app (teamPt) — o snapshot
 * lacra os nomes canônicos do DB (inglês), o relatório só traduz a exibição.
 */
import { teamPt } from '../../src/js/util.js';

const BRT_OFFSET_MS = 3 * 3600000; // BRT = UTC-3 fixo (Brasil sem DST desde 2019)
const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const p2 = (n) => String(n).padStart(2, '0');

const STAGE_LABEL = {
  group: 'Grupos', r32: '32-avos', r16: 'Oitavas', qf: 'Quartas',
  sf: 'Semis', third: '3º Lugar', final: 'Final',
};

function brtParts(dateLike) {
  const d = new Date(new Date(dateLike).getTime() - BRT_OFFSET_MS);
  return {
    dow: DOW[d.getUTCDay()], day: d.getUTCDate(), mo: d.getUTCMonth() + 1,
    y: d.getUTCFullYear(), h: d.getUTCHours(), mi: d.getUTCMinutes(),
  };
}

/** "qua 10/06/2026 23:59 (BRT)" — data completa para o corpo do relatório. */
export function fmtBRT(dateLike) {
  const b = brtParts(dateLike);
  return `${b.dow} ${p2(b.day)}/${p2(b.mo)}/${b.y} ${p2(b.h)}:${p2(b.mi)} (BRT)`;
}

/** "qui 11/06 17:00" — compacta, para células de tabela (e telegram-picks.js). */
export function fmtShort(dateLike) {
  const b = brtParts(dateLike);
  return `${b.dow} ${p2(b.day)}/${p2(b.mo)} ${p2(b.h)}:${p2(b.mi)}`;
}

/** "2026-06-11" no relógio BRT — para o nome do arquivo do relatório. */
export function brtDateStamp(dateLike) {
  return new Date(new Date(dateLike).getTime() - BRT_OFFSET_MS).toISOString().slice(0, 10);
}

const GENESIS = '0'.repeat(64);
const teamOr = (t) => (t ? teamPt(t) : '*A definir*');
const teamPlain = (t) => (t ? teamPt(t) : 'A definir');

// Nomes vêm de texto digitado pelo usuário — neutraliza Markdown/HTML antes de
// pôr em célula de tabela (| quebraria a linha; [x](url) viraria link; etc.).
const mdCell = (s) => String(s ?? '')
  .replace(/\r?\n/g, ' ')
  .replace(/[\\`*_{}[\]<>|]/g, (c) => `\\${c}`);

/** "2×1" — com vencedor nos pênaltis quando houver: "1×1 · pên.: França". */
function fmtPred(p, m) {
  let s = `${p.pred_home}×${p.pred_away}`;
  if (p.pred_pen_winner && m) s += ` · pên.: ${teamPlain(m[`team_${p.pred_pen_winner}`])}`;
  return s;
}

/** Bloco <details> com uma tabela de 2 colunas (colapsado por padrão no GitHub). */
function detailsTable(summary, header, rows) {
  return [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    `| ${header[0]} | ${header[1]} |`,
    '|---|---|',
    ...rows,
    '',
    '</details>',
  ].join('\n');
}

/**
 * Monta o Markdown do relatório de um lacre.
 *
 * @param {object} args
 * @param {object} args.entry    Entrada do manifest recém-criada (seq, file,
 *                               taken_at, content_hash, prev_chain_hash,
 *                               chain_hash, counts).
 * @param {object} args.content  Conteúdo canônico do snapshot (locked_match_ids,
 *                               predictions, champion_picks, scorer_picks, results).
 * @param {Array}  args.matches  Linhas de matches (id, stage, match_date,
 *                               team_home, team_away) — para nomes e horários.
 * @param {object|null} args.prevContent  Conteúdo do snapshot ANTERIOR (null no
 *                               primeiro lacre) — define o que é "novo" neste.
 * @param {Date|null} args.csDeadline  Prazo de campeão/artilheiro, se definido.
 * @param {Function} args.predictionDeadline  A fórmula do prazo (injetada pelo
 *                               snapshot.js para não existir uma 3ª cópia dela).
 * @param {string} args.repoUrl  Ex.: https://github.com/danieloda/world-cup-2026
 * @param {string} [args.branch]
 * @returns {string} Markdown auto-contido (serve para encaminhar a qualquer um).
 */
export function buildReport({
  entry, content, matches, prevContent, csDeadline, predictionDeadline,
  repoUrl, branch = 'main',
}) {
  const byId = new Map(matches.map((m) => [m.id, m]));
  const prevSet = new Set(prevContent?.locked_match_ids ?? []);
  const newLocked = content.locked_match_ids.filter((id) => !prevSet.has(id));

  const predsByMatch = new Map();
  for (const p of content.predictions) {
    if (!predsByMatch.has(p.match_id)) predsByMatch.set(p.match_id, []);
    predsByMatch.get(p.match_id).push(p);
  }

  // Nome de usuário lacrado junto (nunca e-mail). Fallback: pseudônimo curto.
  const nameById = new Map((content.users ?? []).map((u) => [u.user_id, u.name]));
  const nameOf = (id) => nameById.get(id) || `Participante ${String(id).slice(0, 8)}…`;
  const playerById = new Map((content.players ?? []).map((p) => [p.id, p]));
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');

  const participants = new Set([
    ...content.predictions.map((p) => p.user_id),
    ...content.champion_picks.map((c) => c.user_id),
    ...content.scorer_picks.map((s) => s.user_id),
  ]).size;

  // Auditoria automática: TODO palpite lacrado tem updated_at <= prazo do jogo?
  // (updated_at está lacrado junto no snapshot — qualquer um recalcula isto.)
  //
  // INVARIANTE de que esta auditoria depende: predictions.updated_at = instante
  // da ÚLTIMA EDIÇÃO DO PALPITE (pred_home/pred_away/pred_pen_winner) — nunca
  // bumpado por escrita de sistema. Garantida pela migration 066: o trigger
  // touch_prediction_updated_at só move updated_at quando o conteúdo do palpite
  // muda (antes, o trigger compartilhado o bumpava também na escrita de
  // points_earned pelo scoring → falso positivo "gravado após o prazo" em TODO
  // jogo pontuado; ver integrity/reports/ERRATA_2026-06-17_falso-positivo-prazo.md).
  // Se reaparecer "late" em jogo já pontuado, suspeite de regressão dessa invariante.
  const late = [];
  for (const [matchId, preds] of predsByMatch) {
    const m = byId.get(matchId);
    if (!m) continue;
    const deadline = predictionDeadline(m.match_date);
    for (const p of preds) {
      if (new Date(p.updated_at) > deadline) {
        late.push({ user: p.user_id, matchId, at: p.updated_at, deadline });
      }
    }
  }
  if (csDeadline) {
    for (const [kind, picks] of [['campeão', content.champion_picks], ['artilheiro', content.scorer_picks]]) {
      for (const p of picks) {
        if (new Date(p.updated_at) > csDeadline) {
          late.push({ user: p.user_id, matchId: `pick de ${kind}`, at: p.updated_at, deadline: csDeadline });
        }
      }
    }
  }

  const stampedAt = fmtBRT(entry.taken_at);
  const snapshotUrl = `${repoUrl}/blob/${branch}/integrity/${entry.file}`;
  const manifestUrl = `${repoUrl}/blob/${branch}/integrity/manifest.json`;
  const historyUrl = `${repoUrl}/commits/${branch}/integrity`;
  const isGenesis = entry.prev_chain_hash === GENESIS;

  // ---- Seção: jogos que travaram NESTE lacre ----
  let newSection;
  if (newLocked.length === 0) {
    newSection = '_Nenhum jogo novo travou desde o lacre anterior — este lacre registra outra\n'
      + 'mudança nos dados lacrados (ex.: resultado lançado ou picks de campeão/artilheiro)._';
  } else {
    const rows = newLocked.map((id) => {
      const m = byId.get(id);
      if (!m) return `| #${id} | — | — | — | ${(predsByMatch.get(id) ?? []).length} | — |`;
      const preds = predsByMatch.get(id) ?? [];
      const deadline = predictionDeadline(m.match_date);
      const lastUpd = preds.length
        ? preds.map((p) => p.updated_at).sort().at(-1)
        : null;
      const lateHere = preds.some((p) => new Date(p.updated_at) > deadline);
      const lastCell = lastUpd ? `${fmtShort(lastUpd)} ${lateHere ? '⚠️' : '✅'}` : '—';
      return `| **${teamOr(m.team_home)} × ${teamOr(m.team_away)}** | ${STAGE_LABEL[m.stage] || m.stage} `
        + `| ${fmtShort(m.match_date)} | ${fmtShort(deadline)} | ${preds.length} | ${lastCell} |`;
    });
    // Palpite de cada participante, por jogo novo — nome de usuário do app
    // (nunca e-mail). Colapsado para o relatório continuar legível.
    const predTables = newLocked
      .filter((id) => (predsByMatch.get(id) ?? []).length)
      .map((id) => {
        const m = byId.get(id);
        const preds = predsByMatch.get(id);
        const rows2 = preds
          .map((p) => ({ name: nameOf(p.user_id), pred: fmtPred(p, m) }))
          .sort(byName)
          .map((r) => `| ${mdCell(r.name)} | ${r.pred} |`);
        const title = m ? `${teamPlain(m.team_home)} × ${teamPlain(m.team_away)}` : `Jogo #${id}`;
        return detailsTable(
          `<b>${title}</b> — abrir os ${preds.length} palpites lacrados`,
          ['Participante', 'Palpite'], rows2,
        );
      });

    newSection = [
      '| Jogo | Fase | Início | Prazo do palpite | Palpites lacrados | Último palpite recebido |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
      'Horários em Brasília (BRT). ✅ = todos os palpites do jogo foram registrados',
      '**antes** do prazo (o instante de cada palpite, `updated_at`, está lacrado junto).',
      ...(predTables.length ? [
        '',
        ...predTables,
        '',
        '_Publicado somente depois da trava: ninguém pode mais copiar ou mudar nada._',
      ] : []),
    ].join('\n');
  }

  // Picks de campeão/artilheiro: listados com nome UMA vez, no lacre em que
  // estreiam (nos seguintes só os totais — eles não podem mais mudar).
  const csIsNew = (content.champion_picks.length + content.scorer_picks.length) > 0
    && ((prevContent?.champion_picks?.length ?? 0) + (prevContent?.scorer_picks?.length ?? 0)) === 0;
  let csSection = '';
  if (csIsNew) {
    const blocks = [];
    if (content.champion_picks.length) {
      const rows = content.champion_picks
        .map((c) => ({ name: nameOf(c.user_id), pick: teamPlain(c.team) }))
        .sort(byName)
        .map((r) => `| ${mdCell(r.name)} | ${r.pick} |`);
      blocks.push(detailsTable(
        `<b>Campeão</b> — abrir os ${content.champion_picks.length} palpites lacrados`,
        ['Participante', 'Campeão'], rows,
      ));
    }
    if (content.scorer_picks.length) {
      const rows = content.scorer_picks
        .map((s) => {
          const pl = playerById.get(s.player_id);
          const pick = pl ? `${pl.name} (${teamPlain(pl.team)})` : `Jogador #${s.player_id}`;
          return { name: nameOf(s.user_id), pick };
        })
        .sort(byName)
        .map((r) => `| ${mdCell(r.name)} | ${mdCell(r.pick)} |`);
      blocks.push(detailsTable(
        `<b>Artilheiro</b> — abrir os ${content.scorer_picks.length} palpites lacrados`,
        ['Participante', 'Artilheiro'], rows,
      ));
    }
    csSection = `\n## Palpites de campeão e artilheiro (lacrados neste lacre)\n\n${blocks.join('\n\n')}\n`;
  }

  // ---- Seção: auditoria de prazo ----
  const auditSection = late.length === 0
    ? `✅ **Nenhum dos ${content.predictions.length} palpites lacrados foi registrado após o prazo do seu jogo**`
      + (content.champion_picks.length || content.scorer_picks.length
        ? ' — idem para os picks de campeão e artilheiro.'
        : '.')
    : [
      `⚠️ **${late.length} registro(s) com gravação APÓS o prazo** — exigem explicação do organizador:`,
      '',
      ...late.map((l) => `- usuário \`${String(l.user).slice(0, 8)}…\` em ${typeof l.matchId === 'number' ? `jogo #${l.matchId}` : l.matchId}: gravado ${fmtBRT(l.at)}, prazo era ${fmtBRT(l.deadline)}`),
    ].join('\n');

  // ---- Seção: campeão/artilheiro ----
  let csLine;
  if (content.champion_picks.length || content.scorer_picks.length) {
    csLine = `**Campeão:** ${content.champion_picks.length} picks lacrados · `
      + `**Artilheiro:** ${content.scorer_picks.length} picks lacrados`
      + (csDeadline ? ` (prazo: ${fmtBRT(csDeadline)})` : '');
  } else if (csDeadline) {
    csLine = `**Campeão/Artilheiro:** ainda abertos — travam em ${fmtBRT(csDeadline)} e entram no lacre seguinte.`;
  } else {
    csLine = '**Campeão/Artilheiro:** ainda sem prazo definido — entram num lacre futuro.';
  }

  return `# 🔒 Lacre de integridade #${entry.seq} — Bolão SBC 2026

**Carimbado em:** ${stampedAt}

**O que este documento prova:** todos os palpites listados abaixo estavam
travados neste instante e foram lacrados criptograficamente. Qualquer alteração
posterior — por participante, organizador ou quem opera o banco de dados —
quebra o lacre e fica visível a qualquer pessoa, para sempre.

## Jogos que travaram neste lacre

${newSection}
${csSection}
## Auditoria automática de prazo

${auditSection}

## Totais acumulados até este lacre

- Jogos com palpites travados: **${entry.counts.locked_matches}**${newLocked.length ? ` (${newLocked.length} novo(s) neste lacre)` : ''}
- Palpites lacrados: **${entry.counts.predictions}**
- Participantes com registros no lacre: **${participants}**
- ${csLine}
- Resultados oficiais já registrados: **${content.results.length}**

## O lacre criptográfico

| Campo | Valor |
|---|---|
| Arquivo lacrado (todos os palpites) | [\`${entry.file}\`](${snapshotUrl}) |
| Impressão digital do arquivo (SHA-256) | \`${entry.content_hash}\` |
| Lacre anterior | ${isGenesis ? '— (este é o primeiro lacre da corrente)' : `\`${entry.prev_chain_hash}\``} |
| **Lacre desta corrente** | **\`${entry.chain_hash}\`** |

Como funciona a corrente: \`lacre(n) = SHA-256(lacre(n-1) + impressão(n))\`.
Mudar **um único caractere** de qualquer palpite já lacrado muda a impressão
digital do arquivo, o que muda este lacre e **todos os seguintes** — não há
como esconder.

## Carimbos de tempo fora do alcance do organizador

1. **GitHub** — este relatório e o arquivo lacrado foram publicados no
   [histórico público do repositório](${historyUrl}). A data do commit é
   atribuída pelo GitHub, não por nós, e o histórico é público.
2. **Telegram** — o código do lacre acima foi postado no grupo do bolão no
   momento do carimbo, com a hora do próprio Telegram.

Para fraudar um palpite seria preciso reescrever, ao mesmo tempo, o banco de
dados, o histórico do GitHub e a mensagem antiga no Telegram de todo mundo.

## Como conferir

**Sem computador:** compare o código do lacre na mensagem "🔒 Snapshot de
integridade #${entry.seq}" do Telegram com o campo **Lacre desta corrente** acima e com o
[\`manifest.json\`](${manifestUrl}) publicado. Os três têm que ser idênticos.

**Com computador (prova matemática completa, sem precisar de senha):**

\`\`\`bash
git clone ${repoUrl}.git
cd ${repoUrl.split('/').pop()} && npm ci && npm run integrity:verify
\`\`\`

Saída \`🎉 Cadeia íntegra\` = nenhum palpite lacrado foi alterado desde o
primeiro lacre da corrente.

**O seu próprio palpite:** procure o seu nome nas tabelas deste relatório (o
app mostra os mesmos valores na tela de palpites travados). A versão técnica,
com cada placar e instante de envio, está no [arquivo lacrado](${snapshotUrl}).
Se bate com o que você enviou e a cadeia está íntegra, está provado que ninguém
mexeu.

## As três camadas de proteção

1. **A trava** — às 23h59 (Brasília) da véspera de cada jogo, o **banco de
   dados recusa** qualquer inclusão ou alteração de palpite daquele jogo
   (regra \`prediction_deadline\`, no servidor — não é o site que esconde o
   botão). Os palpites dos outros só ficam visíveis no apito inicial.
2. **A trilha** — toda escrita em palpites fica registrada numa trilha de
   auditoria interna (\`prediction_audit\`) que nem o administrador consegue
   editar ou apagar pela aplicação: quem mudou, quando, valor antigo e novo.
3. **O lacre (este documento)** — mesmo quem tem acesso direto ao banco não
   altera nada depois do carimbo sem quebrar a corrente pública de hashes.

## Limites, com honestidade

- O lacre prova imutabilidade **a partir do carimbo** (${stampedAt}). Entre o
  prazo de 23h59 e o carimbo há uma janela curta coberta pelas camadas 1 e 2,
  mas ainda não pelo lacre — por isso o carimbo roda toda madrugada, logo após
  os prazos do dia, e a coluna "Último palpite recebido" acima mostra que os
  registros chegaram **antes** do prazo.
- Participantes aparecem pelo **nome de usuário do app** (nunca o e-mail), por
  decisão do organizador. A associação nome ↔ palpite está dentro do arquivo
  lacrado, protegida pela mesma corrente de hashes.

---

_Relatório gerado automaticamente pelo lacre #${entry.seq}
([\`scripts/integrity/snapshot.js\`](${repoUrl}/blob/${branch}/scripts/integrity/snapshot.js)).
Ele é derivado dos dados lacrados: a prova são os arquivos de \`integrity/\`,
não este texto._
`;
}
