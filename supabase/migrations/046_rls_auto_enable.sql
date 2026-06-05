-- ============================================================
-- Migration 046: back-fill do rls_auto_enable + event trigger ensure_rls
-- ============================================================
-- DRIFT: a função public.rls_auto_enable() e o event trigger ensure_rls existiam
-- SÓ em produção — foram criados à mão no SQL Editor e nunca commitados. Um banco
-- recriado apenas a partir de supabase/migrations/ NÃO teria essa rede de
-- segurança. Esta migration versiona o que já está vivo, byte-fiel ao
-- pg_get_functiondef de produção (corpo inalterado).
--
-- O QUE FAZ: a cada `CREATE TABLE` (e `CREATE TABLE AS` / `SELECT INTO`) no schema
-- public, o event trigger dispara em ddl_command_end e liga RLS automaticamente na
-- tabela nova — "deny-by-default" estrutural, na mesma linha do hardening da 034.
-- Falha de forma defensiva (RAISE LOG, nunca aborta o DDL) e ignora schemas de
-- sistema.
--
-- IDEMPOTENTE: create or replace na função; drop-if-exists + create no event
-- trigger (CREATE EVENT TRIGGER não tem IF NOT EXISTS). Pode rodar de novo sem dano.
--
-- LOCKDOWN: revoga EXECUTE do public/anon/authenticated. O event trigger dispara em
-- contexto de dono (não depende de grant), então o lockdown não o quebra — só tira
-- a função da superfície de RPC do PostgREST, onde ela nunca deveria ter aparecido.
-- ============================================================

create or replace function public.rls_auto_enable()
 returns event_trigger
 language plpgsql
 security definer
 set search_path to 'pg_catalog'
as $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- não é uma RPC de usuário: tira da superfície do PostgREST e de quem chama
revoke all on function public.rls_auto_enable() from public, anon, authenticated;

-- recria o event trigger de forma idempotente (não há IF NOT EXISTS p/ event trigger)
drop event trigger if exists ensure_rls;
create event trigger ensure_rls
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();
