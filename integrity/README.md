# Trilha de integridade dos palpites

Prova, **sem confiar no operador do banco**, que os palpites do bolão não foram
alterados depois de travados. É a defesa contra contestação de prêmio (achado
**H3** da auditoria de segurança).

## Como funciona

1. Uma **GitHub Action** (`.github/workflows/integrity-snapshot.yml`) roda
   diariamente. Para cada jogo cujo prazo de palpite já passou (véspera 23h59
   BRT), ela exporta **todos os palpites travados** num JSON **canônico**
   (chaves ordenadas → bytes determinísticos) em `snapshots/`.
2. Calcula o `content_hash = SHA-256(arquivo)` e **encadeia** com o snapshot
   anterior:
   ```
   chain_hash(n) = SHA-256( chain_hash(n-1) || content_hash(n) )
   chain_hash(0) = 000…000   (genesis)
   ```
3. Registra tudo em `manifest.json` e **commita no GitHub** (o histórico do
   GitHub é o carimbo de tempo de terceiro) e posta o `chain_hash` no Telegram.

Alterar **qualquer** palpite de um snapshot já carimbado muda o `content_hash`
daquele snapshot e **quebra toda a cadeia** a partir dali — detectável por
qualquer pessoa.

## Como verificar (qualquer participante)

Não precisa de banco nem de senha — só do repositório:

```bash
npm run integrity:verify
```

Recomputa os hashes a partir dos arquivos commitados e confirma que:
- cada `snapshots/NNNN_*.json` bate com o `content_hash` do manifest;
- o encadeamento é contínuo, sem buracos.

Saída `🎉 Cadeia íntegra` = nada foi adulterado. Qualquer divergência aponta o
snapshot exato que não fecha.

## Relatório legível por lacre (`reports/`)

Cada lacre novo gera também `reports/NNNN_AAAA-MM-DD.md` — um relatório em
português, **auto-contido**, feito para mostrar a não técnicos: quais jogos
travaram (nome, fase, horário e prazo em BRT), o **palpite de cada participante
pelo nome de usuário do app** (tabelas colapsáveis; e-mail NUNCA sai do banco —
guard em `integrity-guards.test.js`), uma auditoria automática de prazo (todo
`updated_at` lacrado ≤ deadline do jogo), os hashes da corrente, os carimbos de
tempo de terceiros e o passo a passo de verificação. O link do relatório é
postado no Telegram junto com o `chain_hash`.

Os nomes de usuário (`profiles.full_name`) e os jogadores citados em picks são
**lacrados dentro do snapshot** (`users`/`players`, content v3) — a associação
nome ↔ palpite também é protegida pela corrente, não só exibida.

O relatório é **derivado**, não é a prova: a prova são os bytes de `snapshots/`
+ `manifest.json`. Adulterar um relatório não engana o `integrity:verify` — e
tudo o que ele afirma é recalculável por qualquer um a partir do snapshot.

## Conferir o seu próprio palpite

Caminho fácil: procure o seu nome nas tabelas do relatório do lacre
(`reports/`). Caminho técnico: abra o snapshot em `snapshots/`, ache seu
`user_id` em `users` (pelo seu nome) e confira `pred_home`/`pred_away`/
`pred_pen_winner` nos seus palpites. Se bate com o que você enviou e a cadeia
está íntegra, está provado que o valor não mudou desde aquele carimbo.

## Limites (honestos)

- O conteúdo vem do banco via `service_role`. A garantia é de **imutabilidade
  pós-carimbo**: a partir do momento em que um palpite entra num snapshot
  commitado, ele não pode mais ser alterado sem quebrar a cadeia. Adulteração
  *antes* do primeiro snapshot daquele palpite não é coberta — por isso a Action
  roda cedo (logo após cada prazo).
- Hoje a âncora de terceiro é o **histórico do GitHub + Telegram** (timestamps
  fora do alcance de quem opera o banco). Um upgrade futuro é assinar cada
  `chain_hash` com chave GPG/OIDC do organizador.
- A camada interna complementar é a tabela `prediction_audit` (migration 035),
  que registra toda escrita em palpites — visível só ao admin.
