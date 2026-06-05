# SBC 2026

A World Cup 2026 betting pool application with real-time scoring, leaderboards, and admin management.

## Tech Stack

- **Frontend**: Vanilla JavaScript (ES6 modules), HTML5, CSS3
- **Backend**: Supabase (PostgreSQL + Auth + Row Level Security)
- **No build required**: Serve static files directly

## Quick Start

### 1. Set up Supabase

Follow the detailed instructions in [`supabase/README.md`](supabase/README.md):

1. Create a Supabase project
2. Run migrations (001-006)
3. Load seed data (matches, players, settings)
4. Create admin user

### 2. Configure the frontend

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your Supabase credentials
# Get these from: Supabase Dashboard → Project Settings → API

# Generate config.js
npm run build:config
```

### 3. Run locally

```bash
npm run dev
# Opens at http://localhost:3000
```

## Deployment

### Option A: Netlify (Recommended)

1. Push to GitHub
2. Connect repo to Netlify
3. Set environment variables in Netlify UI:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
4. Add build command: `npm run build:config`
5. Set publish directory: `src`
6. Deploy

### Option B: Vercel

1. Import from GitHub
2. Set environment variables
3. Build command: `npm run build:config`
4. Output directory: `src`
5. Deploy

### Option C: Any Static Host

1. Run `npm run build:config` locally
2. Upload all files (including generated `js/config.js`)
3. Ensure HTTPS is enabled (required for Supabase auth)

## Scripts

```bash
npm run setup          # Install deps + generate config
npm run dev            # Start local dev server
npm run build:config   # Generate js/config.js from .env

npm test               # Run unit tests
npm run test:watch     # Watch mode
npm run test:coverage  # With coverage report
npm run test:e2e       # Run E2E tests (requires config.js)
npm run test:all       # Run all tests
```

## Project Structure

```
├── src/                        # Web root (Netlify publish dir)
│   ├── index.html              # World Cup simulator
│   ├── login.html              # Authentication
│   ├── inicio.html             # Dashboard
│   ├── palpites-grupos.html    # Group stage: predictions + standings + best thirds + results (tabbed)
│   ├── palpites-mata.html      # Knockout predictions
│   ├── campeao-artilheiro.html # Champion & top scorer picks
│   ├── grupos.html             # Redirect → palpites-grupos.html#classificacao (legacy deep-link)
│   ├── terceiros.html          # Redirect → palpites-grupos.html#terceiros (legacy deep-link)
│   ├── ranking.html            # Leaderboard
│   ├── admin.html              # Admin panel
│   ├── js/
│   │   ├── config.js           # Generated (gitignored)
│   │   ├── config.example.js   # Template
│   │   ├── supabase.js         # Supabase client
│   │   ├── auth.js             # Authentication helpers
│   │   ├── util.js             # Shared utilities
│   │   ├── scoring.js          # Scoring logic (JS port)
│   │   └── pages/              # Page-specific modules
│   ├── css/
│   │   └── app.css             # Main stylesheet
│   └── assets/                 # Images, icons, avatars, JSON data
├── supabase/
│   ├── migrations/             # Database schema
│   └── seed/                   # Initial data
├── tests/
│   ├── unit/                   # Vitest unit tests
│   └── e2e/                    # Playwright E2E tests
├── scripts/
│   ├── build-config.js         # Config generator
│   ├── data/                   # API ingestion / sync (fetch-*, sync-*)
│   ├── alerts/                 # Telegram alert tooling
│   ├── maintenance/            # Reset / seed ops
│   ├── lib/                    # Shared script helpers
│   ├── dev/                    # Dev utilities
│   └── e2e/                    # Manual E2E harness
└── docs/
    └── design/                 # Logo / brand explorations (not deployed)
```

## Scoring System

**Additive model** (migration 022 — *not* "best tier"). Each correct component of a
prediction adds up:

| Component | Awarded when | Points |
|-----------|--------------|--------|
| **AG** (goals/side) | each side whose goal count is exactly right (0, 1 or 2 sides) | `+ag` per side |
| **AVE** (result) | correct winner/draw (knockout draw decided by `pen_winner`) | `+ave` |
| **DG** (goal diff) | correct goal difference (includes 0-diff draws) | `+dg` |

Exact score = `2·ag + ave + dg`. Weights per stage:

| Stage | AG | AVE | DG | Exact |
|-------|----|-----|----|-------|
| Groups | 1 | 4 | 1 | 7 |
| Round of 32 | 1 | 6 | 1 | 9 |
| Round of 16 | 3 | 12 | 1 | 19 |
| Quarterfinals | 5 | 20 | 2 | 32 |
| Semifinals | 8 | 32 | 2 | 50 |
| 3rd Place | 4 | 16 | 1 | 25 |
| Final | 12 | 48 | 4 | 76 |

### Bonuses

- **Champion pick**: +40 pts if correct (decided only at the final)
- **Top scorer pick**: +2 pts × stage multiplier per goal — the multiplier
  (`1.0 / 1.5 / 2.0 / 3.0 / 4.0 / 2.0 / 5.0` for group→final) applies **only** here.
- **Qualified team** (BPE/BP): points per knockout slot you call right, per phase
  (migration 021/022).

Source of truth: `supabase/migrations/022_additive_scoring.sql`, mirrored in
`src/js/scoring.js` and `scripts/e2e/lib/scoring.js` (keep the three in sync).

## Security

- Row Level Security (RLS) on all tables — the only real trust boundary
- Predictions lock at **23h59 (BRT) the day before** each match (not at kickoff);
  rivals' predictions only become visible at kickoff
- Admin privileges enforced at the database level (RLS), never just in JS
- Every write to predictions/picks/results is logged to an append-only
  `prediction_audit` trail (migration 035)
- No secrets in git (`config.js` is gitignored; only the publishable/anon key
  reaches the browser)
- No secrets in git (config.js is gitignored)

## License

MIT
