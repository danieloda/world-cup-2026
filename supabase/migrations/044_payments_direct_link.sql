-- ============================================================
-- Migration 044: link direto no alerta de pagamentos
-- ============================================================
-- Pedido: no daily_payments, em vez do botão "Entrar no bolão", mostrar o LINK
-- DIRETO (https://superbolaocopa.netlify.app) como texto clicável.
--
-- A edge function (telegram-alert) renderiza context.cta_url/cta_label como
-- [label](url). Não dá pra mudar o rendering sem redeploy da edge, então o
-- truque é usar o próprio URL como label → vira [https://...](https://...),
-- ou seja, o endereço aparece visível e clicável no lugar do "botão".
--
-- A URL vem de _site_url() (já = superbolaocopa, ajustada na 033). Reaproveita
-- a versão da 043 (sem cap + premiação); muda só o cta_label e a frase final.

create or replace function public.cron_alert_daily_payments()
returns void
language plpgsql
security definer
as $$
declare
  v_total int;
  v_paid  int;
  v_fee   numeric;
  v_pot   numeric;
  v_pix   text;
  v_body  text;
  v_pix_line text := '';
  v_split jsonb;
  v_p1 numeric; v_p2 numeric; v_p3 numeric;
  r record;
begin
  select count(*) into v_total from public.profiles;
  select count(*) into v_paid  from public.profiles where paid;
  select coalesce((value #>> '{}')::numeric, 100) into v_fee
    from public.settings where key = 'fee_amount';
  v_fee := coalesce(v_fee, 100);
  v_pot := v_paid * v_fee;
  v_pix := public._pix_key();

  v_body := format('💰 PAGAMENTOS: %s de %s em dia · caixa R$ %s',
                   v_paid, v_total, public._fmt_int(v_pot));

  -- Quem já pagou (TODOS)
  if v_paid > 0 then
    v_body := v_body || E'\n\n✅ JÁ PAGARAM (' || v_paid || '):';
    for r in
      select full_name from public.profiles where paid
      order by full_name asc
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  end if;

  -- Quem falta pagar (TODOS)
  if v_paid < v_total then
    v_body := v_body || E'\n\n⏳ FALTAM PAGAR (' || (v_total - v_paid) || '):';
    for r in
      select full_name from public.profiles where not paid
      order by full_name asc
    loop
      v_body := v_body || E'\n• ' || r.full_name;
    end loop;
  else
    v_body := v_body || E'\n\n🎉 Todo mundo já pagou!';
  end if;

  if v_pix <> '' then
    v_pix_line := format(E'\n\n💸 Inscrição R$ %s · PIX: %s',
                         public._fmt_int(v_fee), v_pix);
  else
    v_pix_line := format(E'\n\n💸 Inscrição R$ %s', public._fmt_int(v_fee));
  end if;
  v_body := v_body || v_pix_line;

  -- Premiação ESTIMADA com a caixa atual (prize_split × caixa). Cresce a cada pagamento.
  if v_pot > 0 then
    select value into v_split from public.settings where key = 'prize_split';
    v_p1 := v_pot * coalesce((v_split->>'first')::numeric,  70) / 100;
    v_p2 := v_pot * coalesce((v_split->>'second')::numeric, 20) / 100;
    v_p3 := v_pot * coalesce((v_split->>'third')::numeric,  10) / 100;
    v_body := v_body
      || E'\n\n🏆 PREMIAÇÃO ESTIMADA (com a caixa atual):'
      || E'\n🥇 1º lugar — R$ ' || public._fmt_int(v_p1)
      || E'\n🥈 2º lugar — R$ ' || public._fmt_int(v_p2)
      || E'\n🥉 3º lugar — R$ ' || public._fmt_int(v_p3)
      || E'\n(quanto mais gente pagar, maior o prêmio 💸)';
  end if;

  v_body := v_body || E'\n\n👉 Ainda não está no bolão? Entre pelo link abaixo:';

  perform public.send_alert(
    'info',
    'daily_payments',
    format('💰 Pagamentos do bolão — %s', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM')),
    v_body,
    jsonb_build_object(
      'cta_url',   public._site_url(),
      'cta_label', public._site_url(),  -- label = URL → mostra o link direto, não "botão"
      'paid', v_paid, 'total', v_total, 'pot', v_pot
    ),
    0
  );

  perform public.mark_cron_run('daily_payments');
end $$;
