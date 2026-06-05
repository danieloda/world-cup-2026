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

## Conferir o seu próprio palpite

Abra o snapshot mais recente em `snapshots/` (ou qualquer um após o prazo do
jogo), procure o seu `user_id` + `match_id` e confira `pred_home`/`pred_away`/
`pred_pen_winner`. Se bate com o que você enviou e a cadeia está íntegra, está
provado que o valor não mudou desde aquele carimbo.

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
