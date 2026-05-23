-- ============================================================
-- Bolão Copa 2026 — Initial settings
-- ============================================================

insert into public.settings (key, value) values
  ('pool_name', '"Bolão Copa 2026"'::jsonb),
  ('fee_amount', '100'::jsonb),
  ('deadline_champion_scorer', '"2026-06-11T02:59:00+00:00"'::jsonb),  -- 10/jun 23:59 BRT
  ('prize_split', '{"first": 70, "second": 20, "third": 10}'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();
