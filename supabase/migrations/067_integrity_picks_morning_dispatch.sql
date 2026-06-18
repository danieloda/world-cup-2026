-- 067_integrity_picks_morning_dispatch.sql
--
-- O ALERTA de palpites recém-lacrados agora sai DE MANHÃ — não na trava (00:10
-- BRT). Motivo: na trava o ranking sai velho. Os jogos de madrugada (kickoff até
-- ~01h BRT) ainda estão em campo às 00:10 e o bônus de artilheiro é AO VIVO; só
-- de manhã o v_leaderboard reflete TUDO do dia anterior (jogos + artilheiro +
-- campeão + classificados) e bate 100% com o site.
--
-- A trava/lacre/relatório/revelação CONTINUAM às 00:10 BRT (migração 062). Esta
-- migração só ACORDA a mesma Action de manhã, reusando a função de dispatch da
-- 062 (cron_dispatch_integrity_snapshot). O snapshot.js dedupa o snapshot (nada
-- novo a carimbar) e só EMITE o alerta, com três guardas (ver maybeEmitPicks):
--   1. janela 4h–12h BRT,  2. todos os jogos já apurados,  3. anúncio-único.
-- As fixtures NÃO têm jogo entre 02h e 12h BRT (último kickoff 01h BRT; 1º jogo
-- do dia 13h BRT), então a manhã é o ponto seguro: depois de tudo, antes do 1º.
--
-- Risco mínimo: SÓ cron.schedule (idempotente por nome) — NÃO toca grants nem
-- funções (diferente do footgun de re-colar migrações antigas). cron.schedule
-- agenda em UTC, igual aos demais crons do projeto (026 / 062).
--
-- KEEP IN SYNC: scripts/integrity/snapshot.js (maybeEmitPicks — janela/gate),
-- scripts/integrity/post-picks.js (anúncio-único), integrity-snapshot.yml.

-- 12:00 UTC = 09:00 BRT — janela matinal, bem depois dos jogos de madrugada.
select cron.schedule(
  'integrity_picks_morning',
  '0 12 * * *',
  $cmd$ select public.cron_dispatch_integrity_snapshot(); $cmd$
);

-- 14:00 UTC = 11:00 BRT — rede de segurança caso o admin apure o último jogo
-- tarde (ainda antes do 1º jogo do dia, 13h BRT). O anúncio-único impede alerta
-- dobrado: se as 09:00 já enviaram, o run das 11:00 vê "nada novo" e silencia.
select cron.schedule(
  'integrity_picks_morning_backup',
  '0 14 * * *',
  $cmd$ select public.cron_dispatch_integrity_snapshot(); $cmd$
);
