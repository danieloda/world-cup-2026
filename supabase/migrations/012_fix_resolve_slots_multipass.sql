-- ============================================================
-- Migration 012: Fix resolve_match_slots multi-pass
-- ============================================================
-- HISTÓRICO: Corrigiu Step 3 do resolve_match_slots pra fazer multi-pass
-- (loop até não haver mais updates) e usar query atualizada do DB ao invés
-- de snapshot do for loop.
--
-- INCORPORADO em 005_slot_resolution.sql (v2 consolidado).
-- Esta migration agora é NO-OP — a função já está corrigida pelo 005.
--
-- Safe rodar várias vezes (idempotente).

-- (No-op: o fix está em 005_slot_resolution.sql)
select 1 as migration_012_noop;
