-- ============================================================
-- Migration 014: Backtracking real pro Step 2
-- ============================================================
-- HISTÓRICO: Implementou backtracking recursivo via PL/pgSQL pra resolver
-- slots compostos 3X/Y/Z (terceiros qualificados).
--
-- INCORPORADO em 005_slot_resolution.sql (v2 consolidado) que já tem:
--   - _backtrack_thirds()
--   - try_assign_thirds()
--   - resolve_match_slots() chamando o backtracking
--
-- NO-OP — todas as funções estão no 005.

select 1 as migration_014_noop;
