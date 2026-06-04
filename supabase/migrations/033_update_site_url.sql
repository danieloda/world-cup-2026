-- ============================================================
-- Migration 033: Atualiza a URL de produção do site
-- ============================================================
-- Contexto: o domínio em produção mudou de
--   https://bolaobsbcopadomundo2026.netlify.app  (antigo)
-- para
--   https://superbolaocopa.netlify.app           (novo)
--
-- Afeta os CTAs dos alertas do Telegram (settings.site_url + _site_url()).
-- O frontend usa window.location.origin, então não depende disto.

-- Atualiza o valor já gravado (a 026 usa `on conflict do nothing`,
-- então o seed não sobrescreve sozinho).
update public.settings
   set value = '"https://superbolaocopa.netlify.app"'::jsonb,
       updated_at = now()
 where key = 'site_url';

-- Garante o registro caso ainda não exista.
insert into public.settings (key, value)
values ('site_url', '"https://superbolaocopa.netlify.app"'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- Atualiza o fallback embutido em _site_url() (usado se a setting sumir).
create or replace function public._site_url()
returns text language sql stable as $$
  select coalesce(
    nullif(trim(both '"' from (select value #>> '{}' from public.settings where key = 'site_url')), ''),
    'https://superbolaocopa.netlify.app'
  );
$$;
