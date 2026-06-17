# 📌 Errata de integridade — o aviso "gravado APÓS o prazo" era FALSO POSITIVO

**Data:** 17/06/2026 · **Lacres afetados:** #7 a #15 (relatórios `0007`–`0015`) ·
**Veredito:** nenhum palpite foi alterado depois do prazo. O aviso foi um **erro
do próprio relatório**, já corrigido (migration 066). Esta errata explica em
detalhe o que aconteceu, prova que os palpites estão intactos e descreve a correção.

---

## 1. TL;DR (resumo de uma respirada)

- Os relatórios #7–#15 exibiram um aviso vermelho do tipo **"⚠️ N registro(s) com
  gravação APÓS o prazo — exigem explicação do organizador"** (N crescendo de 152
  até 1510).
- **Não houve nenhuma alteração de palpite após o prazo.** O aviso confundiu duas
  coisas diferentes: *"o usuário editou o palpite"* e *"o sistema calculou os
  pontos daquele palpite"*.
- Sempre que um **resultado** é lançado, o sistema **grava os pontos** (`points_earned`)
  em cada palpite daquele jogo. Essa gravação — feita pelo motor de pontuação,
  depois do jogo — estava, por um efeito colateral, **carimbando a data**
  `updated_at` do palpite. Como o jogo já acabou, esse carimbo é sempre **depois
  do prazo**. A auditoria lia esse carimbo e gritava "gravado após o prazo".
- **Prova:** em cada jogo já pontuado, **todos os ~76 palpites têm exatamente o
  mesmo `updated_at`, idêntico ao microssegundo** — assinatura de uma única
  gravação em lote (a pontuação), e não de 76 pessoas editando. Cruzando com a
  **trilha de auditoria** (que guarda toda escrita desde sempre), o instante
  **real** de cada palpite está **dias antes** do prazo.
- **Correção (migration 066):** `updated_at` volta a significar só "última edição
  do palpite" e os carimbos afetados foram restaurados para o instante real,
  recuperado da trilha. Depois da correção: **0** registros após o prazo.

---

## 2. O que os relatórios mostraram

A partir do lacre **#7** (12/06), a seção *"Auditoria automática de prazo"* passou
a acusar registros após o prazo, com a contagem crescendo a cada novo jogo pontuado:

| Lacre | Data | "Registros após o prazo" |
|---|---|---|
| #6  | 11/06 | ✅ nenhum (ainda sem jogo pontuado) |
| #7  | 12/06 | ⚠️ 152 |
| #8  | 13/06 | ⚠️ 302 |
| #9  | 14/06 | ⚠️ 530 |
| #10 | 14/06 | ⚠️ 605 |
| #11 | 15/06 | ⚠️ 829 |
| #12 | 15/06 | ⚠️ 902 |
| #13 | 16/06 | ⚠️ 1202 |
| #14 | 17/06 | ⚠️ 1433 |
| #15 | 17/06 | ⚠️ 1510 |

Repare no padrão: **cada jogo novo pontuado somava ~76 ao total** (≈ o número de
participantes). Em 17/06 havia **20 jogos** finalizados × ~76 palpites = **1510** —
exatamente o total de palpites já pontuados. Ou seja: **100% dos palpites de jogos
já pontuados** caíam no aviso, e **nenhum** palpite de jogo ainda aberto. Isso por
si só já diz que o gatilho era a **pontuação**, não a edição.

---

## 3. Causa raiz (a mecânica, em detalhe)

Cada palpite (tabela `predictions`) tem uma coluna `updated_at`. A auditoria do
lacre (`scripts/integrity/report.js`) faz uma checagem simples e honesta:

> para cada palpite lacrado, `updated_at` tem que ser **menor ou igual** ao prazo
> daquele jogo (23h59 BRT da véspera). Se for maior, marca como "gravado após o
> prazo".

O problema está em **quem move o `updated_at`**. Havia um gatilho de banco
**compartilhado** (`touch_updated_at`, de `001_schema.sql`) que fazia
`updated_at = agora()` em **qualquer** alteração da linha — inclusive em
alterações que **não são do usuário**.

E existe uma alteração de sistema rotineira: quando um **resultado** é lançado, o
gatilho `on_match_finished` chama `recompute_prediction_points`
(`003_scoring.sql`), que roda:

```sql
update public.predictions
set points_earned = score_prediction(...)   -- calcula os pontos do palpite
where match_id = <jogo que acabou> ...
```

Esse `update` (legítimo — é a pontuação) disparava o gatilho compartilhado e
**carimbava `updated_at = agora()`**. Como a pontuação acontece **depois** do jogo
(logo, depois do prazo), **todo palpite pontuado passava a ter `updated_at` após o
prazo**. A auditoria, lendo essa coluna, concluía "gravado após o prazo" para
todos eles — um **falso positivo** em massa.

Em uma frase: **a coluna que a auditoria usava como "hora da última edição do
palpite" era, na verdade, sobrescrita pela hora em que o sistema calculou os
pontos.**

---

## 4. A prova de que os palpites estão intactos

Três evidências independentes, todas verificáveis por qualquer participante.

### 4.1 O carimbo é único por jogo (assinatura de gravação em lote)

Dentro de cada snapshot lacrado, para **cada jogo já pontuado**, os ~76 palpites
têm `updated_at` **idêntico ao microssegundo**. Exemplo do jogo #1 no lacre #15:
todos os 76 palpites com `2026-06-12T15:57:06.073941+00:00`. Setenta e seis pessoas
não digitam no mesmo microssegundo — isso é **uma** instrução de `update` (a
pontuação) tocando as 76 linhas de uma vez. Já os jogos **ainda abertos** têm
dezenas de `updated_at` **distintos**: são as edições reais, espalhadas no tempo.

### 4.2 A trilha de auditoria mostra o instante REAL — dias antes do prazo

A trilha `prediction_audit` (`035_audit_trail.sql`) é uma tabela **append-only**
que registra **toda** escrita em palpites desde que foi criada — quem, quando,
valor antigo e novo — e **nem o administrador edita ou apaga** pela aplicação.
Cruzando cada palpite com o **último evento em que o conteúdo do palpite
(`pred_home`/`pred_away`/`pred_pen_winner`) realmente mudou**, o instante real de
cada um está **bem antes** do prazo. Amostra real (instante atual corrompido →
instante real recuperado · prazo):

```
#5248 jogo  1:  12/06 15:57 (pontuação)  →  08/06 11:56 (edição real)  | prazo 11/06 02:59
#5247 jogo 13:  14/06 00:06 (pontuação)  →  27/05 19:56 (edição real)  | prazo 13/06 02:59
#5260 jogo  7:  12/06 21:00 (pontuação)  →  28/05 18:30 (edição real)  | prazo 12/06 02:59
```

### 4.3 Verificação automatizada sobre os dados reais (read-only)

O script `scripts/integrity/verify-deadline-fix.mjs` recalcula, para **todos** os
palpites pontuados, o instante real de edição a partir da trilha e compara com o
prazo. Resultado contra a base de produção em 17/06:

```
Palpites totais:            4372
Palpites pontuados:         1510
Linhas de trilha (preds):   5991

HOJE marcados "após o prazo" (updated_at > prazo):  1510
DEPOIS do backfill (instante real > prazo):         0   ✅

Instante recuperado da trilha (edição real):  1184
Sem trilha → fallback created_at:             326
```

Tradução: dos 1510 "acusados", **nenhum** foi de fato gravado após o prazo. 1184
tiveram o instante real recuperado da trilha; os outros 326 (palpites criados
antes de a trilha existir) caem no `created_at` — a hora em que a linha foi criada,
que **nunca é alterada** — e mesmo essa hora está, em todos, antes do prazo.

### 4.4 Por que isso nunca foi uma brecha

Mesmo sem o lacre, três camadas independentes impediam edição após o prazo, e
seguem **intactas**:

1. **A trava (RLS `predictions_update_own_before_deadline`, `023`):** o banco
   **recusa** insert/update de palpite de um jogo depois das 23h59 da véspera. Não
   é o site escondendo o botão — é regra de servidor.
2. **A trilha (`prediction_audit`, `035`):** toda escrita fica registrada de forma
   imutável via aplicação — é dela que recuperamos os instantes reais acima.
3. **O lacre (hash encadeado + GitHub + Telegram):** prova de que o conteúdo
   lacrado não mudou desde cada carimbo.

O bug afetou **apenas o texto de uma das auditorias** do relatório, derivada de uma
coluna mal escolhida. Não afetou pontuação, ranking, nem o conteúdo dos palpites.

---

## 5. A correção (migration 066)

`supabase/migrations/066_prediction_updated_at_content_only.sql`, em três partes
atômicas:

1. **Gatilho específico de palpites.** Novo `touch_prediction_updated_at`: só move
   `updated_at` quando **o conteúdo do palpite** (`pred_home`/`pred_away`/
   `pred_pen_winner`) muda. A escrita de `points_earned` pela pontuação **não**
   mexe mais em `updated_at`. (O gatilho compartilhado `touch_updated_at` continua
   igual para as outras tabelas — campeão/artilheiro/configurações — que só o
   usuário escreve e nunca tiveram o problema.)

2. **Restauração (backfill).** Para cada palpite já pontuado, `updated_at` volta
   ao **instante real da última edição**, recuperado da trilha `prediction_audit`
   (com fallback para `created_at` quando não há trilha). É a operação validada na
   seção 4.3.

3. **Autoverificação (fail-closed).** Ao final, a migration **aborta sozinha**
   (desfaz tudo) se sobrar **qualquer** palpite pontuado com `updated_at` ainda
   após o prazo. Ou cura 100%, ou não muda nada — não há meio-termo silencioso.

Além disso, `scripts/integrity/report.js` ganhou um comentário documentando a
**invariante** ("`updated_at` = última edição do palpite, nunca escrita de
sistema") para impedir regressão futura.

> **Por que os relatórios #7–#15 continuam com o aviso?** Cada snapshot é selado e
> imutável — reescrevê-lo quebraria a corrente de hashes (justamente a prova de
> que não mexemos em nada). Então os lacres antigos **permanecem como estão**, e
> esta errata fica ao lado deles como explicação permanente. Do **próximo lacre em
> diante**, a auditoria volta a marcar ✅.

---

## 6. Sobre o erro do app no mesmo dia (não relacionado)

No mesmo período houve **1 erro de 1 usuário** no Telegram de erros:
`[palpites-grupos] TypeError: Load failed`. É **independente** deste assunto:
"Load failed" é a mensagem do Safari/WebKit para um **`fetch` que falhou na rede**
(conexão caiu/oscilou) durante o carregamento inicial da página. A página tratou
o erro (mostrou a tela de erro) e o registrou. Não é defeito de código nem tem
relação com a integridade dos palpites — foi um soluço de rede pontual.

---

## 7. Como conferir você mesmo

- **A prova matemática do lacre (sem senha):**
  ```bash
  git clone https://github.com/danieloda/world-cup-2026.git
  cd world-cup-2026 && npm ci && npm run integrity:verify
  ```
  `🎉 Cadeia íntegra` = nenhum palpite lacrado foi alterado desde o primeiro lacre.

- **A correção do falso positivo:** leia
  `supabase/migrations/066_prediction_updated_at_content_only.sql` e rode
  `node scripts/integrity/verify-deadline-fix.mjs` (read-only) para reproduzir os
  números da seção 4.3.

---

## 8. Selo público do lacre limpo (#16)

A migration 066 foi aplicada em produção em **17/06/2026**. A verificação
read-only contra a base passou de **1510 → 0** registros após o prazo, e o lacre
seguinte foi gerado já com a auditoria **limpa**:

> ✅ **Nenhum dos 1818 palpites lacrados foi registrado após o prazo do seu jogo**
> — idem para os picks de campeão e artilheiro.

| Campo | Valor |
|---|---|
| Lacre | **#16** — carimbado 17/06/2026 11:57 (BRT) |
| Relatório | [`integrity/reports/0016_2026-06-17.md`](https://github.com/danieloda/world-cup-2026/blob/main/integrity/reports/0016_2026-06-17.md) |
| Snapshot lacrado | [`integrity/snapshots/0016_…`](https://github.com/danieloda/world-cup-2026/tree/main/integrity/snapshots) |
| Impressão (SHA-256) | `ae3fb03ad28870fc34760a744a66d7c0d092b437770726ac673b26f1efe6ef94` |
| **Lacre desta corrente** | **`a48cf00606a82c0bb0ef416bdb157584f3e4ec5362e759b80370517e11b0d181`** |

`npm run integrity:verify` → `🎉 Cadeia íntegra (16 snapshot(s))`: a corrente dos
#1–#15 (com os carimbos antigos) segue válida e imutável, e o #16 a continua já
com a coluna `updated_at` significando o que a auditoria sempre quis dizer — o
instante da última edição do palpite.

> **Nota sobre a trilha:** o próprio backfill da 066 ficou registrado em
> `prediction_audit` (a trilha cresceu de 5991 → 7504 linhas). Ou seja, a correção
> do organizador também é auditável — nada foi feito "por baixo dos panos".

---

_Documento derivado — a prova são os bytes de `integrity/snapshots/` + a corrente
de hashes em `integrity/manifest.json`, e a trilha imutável `prediction_audit`.
Esta errata não entra no hash; adulterá-la não engana o `verify`._
