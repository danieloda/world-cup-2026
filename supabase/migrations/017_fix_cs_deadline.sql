-- ============================================================
-- Migration 017: Fix cs_deadline() — lia JSON errado
-- ============================================================
-- BUG: cs_deadline() usava `value->>'deadline_champion_scorer'` pra extrair o
-- deadline da tabela settings. Mas settings.value é um ESCALAR jsonb (string
-- "2026-06-11T02:59:00+00:00"), não um objeto. `->>'chave'` num escalar retorna
-- NULL → coalesce caía no default hardcoded SEMPRE.
--
-- Efeito: o deadline configurado via settings era IGNORADO. A função sempre
-- retornava 2026-06-11 02:59 (default). Admin não conseguia alterar o deadline.
-- (Em produção "funcionava" só porque o default == deadline real.)
--
-- FIX: usar `value #>> '{}'` que extrai o texto de um escalar jsonb corretamente.

create or replace function public.cs_deadline()
returns timestamptz language sql stable as $$
  select coalesce(
    (select (value #>> '{}')::timestamptz
       from public.settings
      where key = 'deadline_champion_scorer'),
    '2026-06-11 02:59:00+00'::timestamptz  -- fallback se a row não existir
  );
$$;
