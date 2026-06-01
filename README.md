# Bolão Copa 2026

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
5. Set publish directory: `/`
6. Deploy

### Option B: Vercel

1. Import from GitHub
2. Set environment variables
3. Build command: `npm run build:config`
4. Output directory: `.`
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
├── index.html              # World Cup simulator
├── login.html              # Authentication
├── inicio.html             # Dashboard
├── palpites-grupos.html    # Group stage: predictions + standings + best thirds + results (tabbed)
├── palpites-mata.html      # Knockout predictions
├── campeao-artilheiro.html # Champion & top scorer picks
├── grupos.html             # Redirect → palpites-grupos.html#classificacao (legacy deep-link)
├── terceiros.html          # Redirect → palpites-grupos.html#terceiros (legacy deep-link)
├── ranking.html            # Leaderboard
├── admin.html              # Admin panel
├── js/
│   ├── config.js           # Generated (gitignored)
│   ├── config.example.js   # Template
│   ├── supabase.js         # Supabase client
│   ├── auth.js             # Authentication helpers
│   ├── util.js             # Shared utilities
│   ├── scoring.js          # Scoring logic (JS port)
│   └── pages/              # Page-specific modules
├── css/
│   └── app.css             # Main stylesheet
├── supabase/
│   ├── migrations/         # Database schema
│   └── seed/               # Initial data
├── tests/
│   ├── unit/               # Vitest unit tests
│   └── e2e/                # Playwright E2E tests
└── scripts/
    └── build-config.js     # Config generator
```

## Scoring System

| Result | Base Points |
|--------|-------------|
| Exact score | 5 pts |
| Winner + goal diff | 3 pts |
| Winner only | 2 pts |
| One side correct | 1 pt |
| Miss | 0 pts |

### Stage Multipliers

| Stage | Multiplier |
|-------|------------|
| Groups | 1.0x |
| Round of 32 | 1.5x |
| Round of 16 | 2.0x |
| Quarterfinals | 3.0x |
| Semifinals | 4.0x |
| 3rd Place | 2.0x |
| Final | 5.0x |

### Bonuses

- **Champion pick**: +50 pts if correct
- **Top scorer pick**: +2 pts × stage_mult per goal

## Security

- Row Level Security (RLS) on all tables
- Predictions auto-lock at match kickoff
- Admin privileges enforced at database level
- No secrets in git (config.js is gitignored)

## License

MIT
