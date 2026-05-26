-- ============================================================
-- Migration 010: admin_confirm_test_emails()
-- ============================================================
-- O Supabase Auth tem "Confirm email" ON por padrao. Pra rodar E2E sem
-- precisar acessar caixa de email, esta funcao confirma emails de usuarios
-- que correspondem ao prefix de teste (test-XXX@testuser.com).
--
-- IMPORTANTE: Esta funcao toca em auth.users (schema do Supabase Auth).
-- Por seguranca, ela:
--   1. Aceita SOMENTE emails que correspondam ao padrao de teste
--   2. Tem guard de is_admin()
--   3. Loga via send_alert pra auditoria

create or replace function public.admin_confirm_test_emails(p_pattern text default 'test-%@testuser.com')
returns int
language plpgsql
security definer
as $$
declare
  v_updated int;
begin
  if not public.is_admin() then
    raise exception 'admin_confirm_test_emails: caller is not admin (RLS guard)';
  end if;

  -- Guard adicional: pattern PRECISA ter 'test' no inicio
  if p_pattern not like 'test-%' then
    raise exception 'admin_confirm_test_emails: pattern must start with "test-" (got %)', p_pattern;
  end if;

  -- Confirma users de teste que ainda nao foram confirmados
  -- NOTA: auth.users.confirmed_at eh generated column, nao pode UPDATE direto.
  -- So precisamos atualizar email_confirmed_at.
  update auth.users
     set email_confirmed_at = now()
   where email like p_pattern
     and email_confirmed_at is null;

  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    perform public.send_alert(
      'info',
      'admin_action',
      format('Admin confirmou %s emails de teste', v_updated),
      format('Pattern usado: %s', p_pattern),
      jsonb_build_object('updated', v_updated, 'pattern', p_pattern),
      0
    );
  end if;

  return v_updated;
end $$;

comment on function public.admin_confirm_test_emails is
'E2E test helper: confirma emails de usuarios de teste matching pattern. Admin-only. Pattern DEVE comecar com "test-".';

grant execute on function public.admin_confirm_test_emails(text) to authenticated;
