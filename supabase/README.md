# Supabase — SBC 2026

Setup do banco de dados em Supabase para o SBC 2026.

## O que tem aqui

```
supabase/
├── migrations/
│   ├── 001_schema.sql                       — tabelas (profiles, matches, predictions, etc.)
│   ├── 002_rls.sql                          — Row Level Security
│   ├── 003_scoring.sql                      — funções de pontuação + views de ranking
│   ├── 004_profile_self_signup.sql          — permite auto-criação de profile
│   ├── 005_slot_resolution.sql              — resolve slots do mata-mata (v2 consolidado)
│   ├── 006_avatar.sql                       — adiciona coluna avatar_url
│   ├── 007_alerts.sql                       — alert_log + send_alert + triggers Telegram
│   ├── 008_admin_reset.sql                  — admin_reset_matches (E2E helper)
│   ├── 009_admin_reset_picks.sql            — admin_reset_picks (E2E helper)
│   ├── 010_admin_confirm_test_emails.sql    — confirm test emails (E2E helper)
│   ├── 011_fix_alert_trigger_order.sql      — historico/no-op (incorporado em 007)
│   ├── 012_fix_resolve_slots_multipass.sql  — historico/no-op (incorporado em 005)
│   ├── 013_fix_thirds_uniqueness.sql        — historico/no-op (incorporado em 005)
│   └── 014_thirds_backtracking.sql          — historico/no-op (incorporado em 005)
└── seed/
    ├── 01_matches.sql      — 104 jogos da Copa 2026
    ├── 02_players.sql      — ~50 candidatos a artilheiro
    ├── 03_settings.sql     — config inicial (taxa, deadline, prêmios)
    └── players_full.sql    — 1380 jogadores completos (todos os 48 times)
```

**Ordem de aplicação:** rode em ordem numérica (001 → 014). Migrations 011-014 são
NO-OPs porque os fixes foram incorporados em 005 (consolidado). Rodá-las é seguro
(idempotentes) — útil pra preservar histórico de DBs já com elas aplicadas.

## Passo 1 — Criar projeto Supabase

1. Acesse https://supabase.com → **New project**
2. Escolha:
   - **Name**: `bolao-copa-2026`
   - **Database password**: gere uma forte e guarde
   - **Region**: `South America (São Paulo)` ou próxima
   - **Plan**: Free (suficiente)
3. Aguarde provisionar (~2 min)

## Passo 2 — Rodar as migrations

Vá em **SQL Editor** (ícone `<>` no menu lateral) e rode os arquivos **nesta ordem**:

1. `migrations/001_schema.sql` → **Run**
2. `migrations/002_rls.sql` → **Run**
3. `migrations/003_scoring.sql` → **Run**
4. `migrations/004_profile_self_signup.sql` → **Run**
5. `migrations/005_slot_resolution.sql` → **Run**
6. `migrations/006_avatar.sql` → **Run**

Cada um deve dar **Success. No rows returned**.

## Passo 3 — Rodar o seed

Mesmo lugar (SQL Editor):

1. `seed/01_matches.sql` → carrega os 104 jogos
2. `seed/02_players.sql` → carrega ~50 jogadores candidatos
3. `seed/03_settings.sql` → carrega configurações iniciais

### Verificar que deu certo

```sql
select stage, count(*) from public.matches group by stage order by stage;
-- Deve retornar:
-- final: 1, group: 72, qf: 4, r16: 8, r32: 16, sf: 2, third: 1

select count(*) from public.players;
-- Deve retornar: 51

select * from public.settings;
-- Deve retornar 4 linhas
```

## Passo 4 — Criar o primeiro usuário (admin)

1. Vá em **Authentication → Users → Add user → Create new user**
2. Email: `seu-email@gmail.com`, senha forte
3. **Auto Confirm User**: ligado
4. Clique em **Create user** e copie o `User UID` que aparecer

Volte ao **SQL Editor** e rode (substituindo `<SEU_UID>` e `<SEU_NOME>`):

```sql
insert into public.profiles (id, full_name, email, is_admin, paid, paid_at)
values (
  '<SEU_UID>',
  '<SEU_NOME>',
  'seu-email@gmail.com',
  true,    -- admin
  true,    -- pago (admin não precisa pagar)
  now()
);
```

## Passo 5 — Pegar as credenciais para o frontend

Vá em **Project Settings → API**:
- `Project URL` → vai virar `SUPABASE_URL` no frontend
- `anon public` (a primeira key) → vai virar `SUPABASE_ANON_KEY`

⚠️ A `service_role` key **NUNCA** vai no frontend — só backend, se houver.

## Como funciona o lock dos palpites (resumo)

- **Palpites de jogo**: as policies RLS bloqueiam INSERT/UPDATE em `predictions` se `match_date <= now()`. Cada jogo trava no apito inicial automaticamente — não precisa cron.
- **Campeão & Artilheiro**: travam em `2026-06-10T23:59 BRT` (ou o valor da setting `deadline_champion_scorer`).
- **Pontuação**: quando o admin marca um jogo como `finished=true`, um trigger recomputa os pontos de todas as predictions daquele jogo automaticamente.

## Como re-rodar tudo do zero

Se quiser zerar e recomeçar:

```sql
drop schema public cascade;
create schema public;
grant all on schema public to postgres, anon, authenticated, service_role;
```

Depois rode novamente migrations + seed.

## Próximos passos

Depois do setup do Supabase, voltar ao [README principal](../README.md) para conectar o frontend.
