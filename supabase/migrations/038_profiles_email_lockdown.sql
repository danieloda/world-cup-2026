-- ============================================================
-- Migration 038: Lockdown do e-mail em profiles (M1 — parte 2)
-- ============================================================
-- ⚠️  VALIDAR NO STACK LOCAL ANTES DE PROD. Esta migration mexe em PRIVILÉGIOS
--     DE COLUNA do Postgres (não só RLS). Se a interação com os grants padrão do
--     Supabase divergir, pode afetar a leitura de profiles. Teste:
--       supabase db reset
--       node scripts/e2e/test-rls-hostile.js
--       + abrir login/sidebar/ranking/historico/admin e conferir que carregam.
--
-- Problema (M1): profiles_select_authenticated (using true) + grant de SELECT a
-- authenticated deixavam QUALQUER logado rodar `select email from profiles` e
-- colher o e-mail de todos os ~30 participantes (signup é aberto). RLS é
-- row-level, não esconde coluna — então a correção é privilégio de COLUNA.
--
-- O app já foi adaptado pra não depender de profiles.email (e-mail próprio vem da
-- sessão; admin lê via RPC abaixo), então estas mudanças são forward-safe.

-- ============================================================
-- 1) Privilégio de coluna: authenticated NÃO lê email
-- ============================================================
-- Remove o SELECT de tabela inteira e reconcede coluna a coluna, sem email.
-- (anon não tem policy de SELECT em profiles, então nem chega a ler linhas;
--  revogamos por higiene.)
revoke select on public.profiles from anon, authenticated;

grant select (id, full_name, avatar_url, is_admin, paid, paid_at, created_at)
  on public.profiles to authenticated;

-- email continua GRAVÁVEL pelo próprio (policies de insert/update inalteradas);
-- só deixa de ser legível por SELECT de qualquer linha.
-- Views (v_leaderboard etc.) e funções SECURITY DEFINER rodam como dono → não
-- são afetadas por este revoke.

-- ============================================================
-- 2) admin_list_profiles() — e-mails só para admin, via RPC gated
-- ============================================================
create or replace function public.admin_list_profiles()
returns table (
  id         uuid,
  full_name  text,
  email      text,
  avatar_url text,
  is_admin   boolean,
  paid       boolean,
  paid_at    timestamptz,
  created_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select id, full_name, email, avatar_url, is_admin, paid, paid_at, created_at
  from public.profiles
  where public.is_admin()   -- gate: não-admin recebe 0 linhas
  order by created_at;
$$;

grant execute on function public.admin_list_profiles() to authenticated;
