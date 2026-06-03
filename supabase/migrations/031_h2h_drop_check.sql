-- ============================================================
-- Migration 031: remove o CHECK (team_a < team_b) de team_h2h
-- ============================================================
-- O par canônico é definido pela ordenação de STRING do JavaScript
-- (por unidade de código UTF-16), usada de forma idêntica pelo script
-- de seed (fetch-h2h-pairs.js) e pelo front (palpites-mata fetchH2HPair).
-- Os dois concordam entre si — mas a collation do Postgres ordena
-- diferente em pares como "USA" vs "Uruguay" (locale-aware: 'USA' > 'Uruguay'),
-- fazendo o CHECK rejeitar a linha que o app considera válida.
--
-- O PK (team_a, team_b) já garante unicidade do par; o CHECK era só um
-- guarda e causava esse falso-positivo. Removemos.

alter table public.team_h2h drop constraint if exists team_h2h_check;
