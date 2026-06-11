# Ratiobo — Portfolio intelligence

Portfolio tracker for equities, crypto, and precious metals. Next.js frontend
backed by Supabase (Postgres, auth, scheduled market data sync).

## What's inside

- `app/dashboard` — portfolio summary cards + holdings table, reading the
  `holdings_valued` view (live cost basis, value, net gain)
- `app/accounts` — list and add accounts (dropdown driven by `account_types`)
- `app/holdings/new` — add a holding (dropdown driven by `asset_types`)
- `app/transactions/new` — record buys/sells/dividends/interest
  (dropdown driven by `transaction_types`; unit-affecting types update
  the holding quantity automatically)
- `app/login` — email/password sign in and sign up via Supabase Auth

The backend (tables, lookup tables, the `holdings_valued` view, the
`sync-market-data` edge function, and the 15-minute price cron) already
lives in the Supabase project — nothing here needs to be deployed for that.

## Deploy in three steps

### 1. Push to GitHub

Create a new repository at https://github.com/new (name it `ratiobo`,
private is fine). Then from this folder:

```bash
git init
git add .
git commit -m "Ratiobo initial build"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ratiobo.git
git push -u origin main
```

(If you don't have git locally, GitHub's web UI also allows uploading
the folder contents directly — "uploading an existing file" on the
empty repo page.)

### 2. Import to Vercel

1. Go to https://vercel.com/new and import the `ratiobo` repository.
2. Framework preset: **Next.js** (auto-detected). Leave build settings alone.
3. Add two environment variables (values are in `.env.local.example`):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Click **Deploy**.

### 3. Tell Supabase about your Vercel URL

In the Supabase dashboard: **Authentication → URL Configuration** — set
*Site URL* to your Vercel URL (e.g. `https://ratiobo.vercel.app`). This
makes auth redirects work.

That's it. Sign up with a fresh email on the live site and start adding
accounts and holdings. New symbols you add are picked up by the price
sync automatically on the next 15-minute cycle.

> Note: the seeded test data belongs to the test user
> (`test@ratiobo.dev`); your new sign-up starts with a clean, empty
> portfolio — that's row level security working as intended.

## Local development (optional)

```bash
cp .env.local.example .env.local
npm install
npm run dev
```

Then open http://localhost:3000.

## Environment variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key — safe in the browser; row level security enforces per-user data isolation |
