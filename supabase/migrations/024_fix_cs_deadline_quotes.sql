-- ============================================================
-- Migration 024: cs_deadline() tolerante a valor duplo-codificado
-- ============================================================
-- BUG: o admin (admin.js) salvava deadline_champion_scorer com JSON.stringify
-- numa coluna jsonb (que o supabase-js já serializa) → DUPLO-codificava. O jsonb
-- virava uma string escalar cujo TEXTO inclui aspas: "2026-06-11T02:59:00.000Z".
-- Aí `value #>> '{}'` devolvia `"2026-..."` (com aspas) e o `::timestamptz`
-- estourava — quebrando a RLS de champion_picks/top_scorer_picks que usa cs_deadline().
--
-- FIX no app: admin.js passa a gravar valores NATIVOS (sem JSON.stringify).
-- FIX defensivo aqui: remover aspas das pontas antes do cast, para tolerar
-- qualquer valor já gravado torto em produção.

create or replace function public.cs_deadline()
returns timestamptz language sql stable as $$
  select coalesce(
    (select trim(both '"' from (value #>> '{}'))::timestamptz
       from public.settings
      where key = 'deadline_champion_scorer'),
    '2026-06-11 02:59:00+00'::timestamptz  -- fallback se a row não existir
  );
$$;
