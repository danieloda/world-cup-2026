-- ============================================================
-- Migration 047: Captura de erros do cliente (observabilidade)
-- ============================================================
-- Ponto 6 do hardening pré-lançamento. Hoje o "detector de bug" é o usuário —
-- com bolão pago, o primeiro a ver cada bug é quem reclama. Esta tabela recebe
-- erros não tratados do frontend (window.onerror / unhandledrejection) para o
-- admin enxergar problemas ANTES do boca-a-boca, sem vendor externo.
--
-- KEEP IN SYNC: src/js/error-reporter.js (quem grava) + auth.js (instala no
-- requireAuth). Anon (login/signup) NÃO é capturado de propósito (RLS exige
-- authenticated); o valor está no app logado.

create table if not exists public.client_errors (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null,            -- 'error' | 'unhandledrejection' | 'fatal' (catch de página → tela de erro)
  message     text not null,
  stack       text,
  url         text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_client_errors_created on public.client_errors(created_at desc);
create index if not exists idx_client_errors_user    on public.client_errors(user_id);

-- ============================================================
-- RLS: INSERT só o próprio (user_id = auth.uid()); SELECT só admin.
-- Sem UPDATE/DELETE de propósito → append-only via API (admin poda via service
-- role). Mesmo padrão de prediction_audit (035).
-- ============================================================
alter table public.client_errors enable row level security;

drop policy if exists "client_errors_insert_self" on public.client_errors;
create policy "client_errors_insert_self"
  on public.client_errors for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "client_errors_select_admin" on public.client_errors;
create policy "client_errors_select_admin"
  on public.client_errors for select
  to authenticated
  using (public.is_admin());

grant insert, select on public.client_errors to authenticated;
grant usage on sequence public.client_errors_id_seq to authenticated;
