-- ============================================================
-- Migration 055: reorganiza os alertas de trava (group_lock_24h / 3d)
-- ============================================================
-- O layout da 053 era por PESSOA ("• Fulano — Jogo A, Jogo B"), o que repetia o
-- nome de cada jogo em dezenas de linhas (com ~67 usuários, "Brasil x Sérvia"
-- aparecia em quase todas). Pedido: listar os JOGOS uma vez no topo e, embaixo,
-- só QUEM ainda não palpitou (cada nome 1x). Bem menos ruído.
--
-- Estrutura nova das 2 mensagens:
--   • group_lock_24h: jogos que travam HOJE (lista única) + quem está pendente.
--   • group_lock_3d : jogos agrupados por DIA de trava + quem está pendente.
-- Só lista jogos que AINDA têm alguém sem palpite (jogo 100% palpitado não polui).
-- Pessoa = quem está sem palpite em ≥1 jogo da janela (some o "qual jogo" por
-- pessoa; quem quer o detalhe abre o app pelo link). CREATE OR REPLACE — não
-- mexe em trigger/agendamento. Idempotente.

create or replace function public.cron_alert_group_completeness()
returns void
language plpgsql
security definer
as $$
declare
  v_today  date := (now() at time zone 'America/Sao_Paulo')::date;
  v_games  text;
  v_people text;
  v_n      int;
  v_cur    date;
  r record;
begin
  -- ===== MSG 1: TRAVAM HOJE ÀS 23H59 (≤24h) =====
  -- Jogos (uma vez) que travam hoje e AINDA têm alguém pendente.
  v_games := '';
  for r in
    select m.team_home, m.team_away
    from public.matches m
    where not m.finished and m.status <> 'void'
      and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date = v_today
      and exists (
        select 1 from public.profiles pr
        where not exists (
          select 1 from public.predictions p
          where p.user_id = pr.id and p.match_id = m.id))
    order by m.match_date asc, m.id asc
  loop
    v_games := v_games || E'\n⚽ ' || r.team_home || ' x ' || r.team_away;
  end loop;

  -- Pessoas (uma vez) sem palpite em ≥1 desses jogos.
  v_people := ''; v_n := 0;
  for r in
    select pr.full_name
    from public.profiles pr
    where exists (
      select 1 from public.matches m
      where not m.finished and m.status <> 'void'
        and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date = v_today
        and not exists (
          select 1 from public.predictions p
          where p.user_id = pr.id and p.match_id = m.id))
    order by pr.full_name asc
  loop
    v_people := v_people || E'\n• ' || r.full_name;
    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    perform public.send_alert(
      'info', 'group_lock_24h',
      '🚨 Palpites travam HOJE às 23h59',
      'Estes jogos fecham hoje à meia-noite:' || v_games
        || E'\n\nQuem ainda não palpitou:' || v_people
        || E'\n\n👉 Dá tempo: abra e palpite antes das 23h59.',
      jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Fazer meus palpites', 'count', v_n),
      0
    );
  end if;

  -- ===== MSG 2: TRAVAM EM 1 A 3 DIAS — jogos agrupados por DIA de trava =====
  v_games := ''; v_cur := null;
  for r in
    select (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date as lock_date,
           m.team_home, m.team_away
    from public.matches m
    where not m.finished and m.status <> 'void'
      and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date
          between v_today + 1 and v_today + 3
      and exists (
        select 1 from public.profiles pr
        where not exists (
          select 1 from public.predictions p
          where p.user_id = pr.id and p.match_id = m.id))
    order by lock_date asc, m.match_date asc, m.id asc
  loop
    if v_cur is null or r.lock_date <> v_cur then
      v_games := v_games || E'\n\n📅 Trava ' || to_char(r.lock_date, 'DD/MM')
                 || case when r.lock_date = v_today + 1 then ' (amanhã)' else '' end || ':';
      v_cur := r.lock_date;
    end if;
    v_games := v_games || E'\n⚽ ' || r.team_home || ' x ' || r.team_away;
  end loop;

  -- Pessoas (uma vez) sem palpite em ≥1 jogo da janela de 1–3 dias.
  v_people := ''; v_n := 0;
  for r in
    select pr.full_name
    from public.profiles pr
    where exists (
      select 1 from public.matches m
      where not m.finished and m.status <> 'void'
        and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date
            between v_today + 1 and v_today + 3
        and not exists (
          select 1 from public.predictions p
          where p.user_id = pr.id and p.match_id = m.id))
    order by pr.full_name asc
  loop
    v_people := v_people || E'\n• ' || r.full_name;
    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    perform public.send_alert(
      'info', 'group_lock_3d',
      '⏳ Palpites travando nos próximos dias',
      'Cada jogo trava às 23h59 da véspera.' || v_games
        || E'\n\nQuem ainda não palpitou:' || v_people
        || E'\n\n👉 Não deixe acumular — palpite com antecedência.',
      jsonb_build_object('cta_url', public._site_url(), 'cta_label', 'Fazer meus palpites', 'count', v_n),
      0
    );
  end if;

  perform public.mark_cron_run('group_completeness');
end $$;

comment on function public.cron_alert_group_completeness is
'Cron diário 09h BRT. 2 msgs: jogos que travam HOJE / em 1–3 dias (listados 1x no topo, agrupados por dia no 3d) + lista única de quem ainda não palpitou. Silenciosa se ninguém pendente.';
