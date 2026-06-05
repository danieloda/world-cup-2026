-- ============================================================
-- Migration 041: group_completeness vira "lembrete de jogos travando"
-- ============================================================
-- ANTES (026): cron_alert_group_completeness mandava o progresso de TODOS os
-- usuários nos palpites de grupo (✅/🟡/🔴), todo dia, mesmo que faltassem
-- semanas pro 1º jogo. Virava ruído.
--
-- AGORA: só cobra quem NÃO palpitou jogos PRÓXIMOS de travar, em 2 níveis:
--   🚨 URGENTE  → jogos que travam HOJE 23h59 (jogos de amanhã)
--   ⚠️ ATENÇÃO → jogos que travam AMANHÃ 23h59 (jogos de depois de amanhã)
-- Lista, por pessoa, os NOMES dos jogos que faltam palpitar.
-- Se ninguém está pendente nessas janelas, NÃO manda nada (silencioso).
--
-- Mantém o MESMO nome de função (cron_alert_group_completeness) e a MESMA
-- chave de heartbeat ('group_completeness') pra não mexer no cron nem no
-- dead-man-switch da 026. Só o corpo muda.
-- ============================================================

create or replace function public.cron_alert_group_completeness()
returns void
language plpgsql
security definer
as $$
declare
  v_today      date := (now() at time zone 'America/Sao_Paulo')::date;
  v_urgent     text := '';
  v_warn       text := '';
  v_n_urgent   int  := 0;
  v_n_warn     int  := 0;
  v_body       text;
  v_title      text;
  r record;
begin
  -- ── 🚨 URGENTE: travam HOJE 23h59 ──────────────────────────
  -- Para cada usuário, junta os jogos (nome) que ele ainda não palpitou
  -- e cujo prazo cai HOJE (BRT).
  for r in
    select pr.full_name,
           string_agg(m.team_home || ' x ' || m.team_away, ', '
                      order by m.match_date) as games
    from public.profiles pr
    join public.matches m
      on not m.finished
     and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date = v_today
     and not exists (
           select 1 from public.predictions p
           where p.user_id = pr.id and p.match_id = m.id
         )
    group by pr.id, pr.full_name
    order by pr.full_name asc
    limit 100
  loop
    if v_n_urgent = 0 then
      v_urgent := E'\n\n🚨 TRAVA HOJE ÀS 23H59 — ainda sem palpite:';
    end if;
    v_urgent := v_urgent || E'\n• ' || r.full_name || ' — ' || r.games;
    v_n_urgent := v_n_urgent + 1;
  end loop;

  -- ── ⚠️ ATENÇÃO: travam AMANHÃ 23h59 ───────────────────────
  for r in
    select pr.full_name,
           string_agg(m.team_home || ' x ' || m.team_away, ', '
                      order by m.match_date) as games
    from public.profiles pr
    join public.matches m
      on not m.finished
     and (public.prediction_deadline(m.match_date) at time zone 'America/Sao_Paulo')::date = v_today + 1
     and not exists (
           select 1 from public.predictions p
           where p.user_id = pr.id and p.match_id = m.id
         )
    group by pr.id, pr.full_name
    order by pr.full_name asc
    limit 100
  loop
    if v_n_warn = 0 then
      v_warn := E'\n\n⚠️ TRAVA AMANHÃ ÀS 23H59 — ainda sem palpite:';
    end if;
    v_warn := v_warn || E'\n• ' || r.full_name || ' — ' || r.games;
    v_n_warn := v_n_warn + 1;
  end loop;

  -- Nada pendente nas duas janelas → silêncio (mas marca o run pro heartbeat).
  if v_n_urgent = 0 and v_n_warn = 0 then
    perform public.mark_cron_run('group_completeness');
    return;
  end if;

  -- Título reflete o nível mais alto presente.
  if v_n_urgent > 0 then
    v_title := '🚨 Palpites travando — não deixe pra última hora!';
  else
    v_title := '⚠️ Palpites travando amanhã';
  end if;

  v_body := 'Lembrete: cada jogo trava às 23h59 da véspera.'
            || v_urgent || v_warn
            || E'\n\nAinda dá tempo — é só abrir e palpitar. 👇';

  perform public.send_alert(
    'info',
    'group_completeness',
    v_title,
    v_body,
    jsonb_build_object(
      'cta_url', public._site_url(), 'cta_label', 'Fazer meus palpites',
      'urgent_count', v_n_urgent, 'warn_count', v_n_warn
    ),
    0
  );

  perform public.mark_cron_run('group_completeness');
end $$;

comment on function public.cron_alert_group_completeness is
'Cron diário 09h BRT. Cobra SÓ quem não palpitou jogos próximos de travar, em 2 níveis: 🚨 trava hoje 23h59, ⚠️ trava amanhã 23h59 (lista os jogos por pessoa). Silencioso se ninguém pendente.';
