-- ============================================================
-- Migration 013: Fix uniqueness Step 2 (terceiros)
-- ============================================================
-- HISTÓRICO: Corrigiu greedy de terceiros (mesmo time atribuido a multiplos
-- slots compostos). Substituido por backtracking real no 014.
--
-- INCORPORADO em 005_slot_resolution.sql (v2 consolidado) que já usa o
-- backtracking final.
--
-- NO-OP.

select 1 as migration_013_noop;
