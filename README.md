# RingBack

Turn missed calls into booked jobs. Instant lead response and follow-up for local service businesses.

RingBack replies to every missed call, website form, and social lead in seconds, asks one qualifying question, pushes the customer to book, and follows up three times. It captures and scores every lead in a small CRM. Sold as a done-for-you setup (48 hours) with a monthly plan.

## Run it

```bash
cd ringback
cp .env.example .env      # optional; sensible defaults work without it
npm start
```

Open `http://127.0.0.1:4000/`.

- Marketing site, ROI calculator, multi-turn live demo, pricing, FAQ, setup form: `/`
- Lead CRM (pipeline, search/filter, statuses, notes, revenue recovered, CSV export): `/dashboard`
- Admin login: `/login`
- Health and integration status: `/health`

Zero dependencies. Node 18+. Node 22+ for the SQLite engine (falls back to JSON automatically).

## What's included

**Reply engine** (`lib/engine.js`) — deterministic, no LLM key required.
- Intent classification: price, availability, booking, service area, hours, finance, warranty, general
- Channel-aware voice for 9 channels (missed call, SMS, WhatsApp, Facebook, Instagram, Google Ads, web chat, web form, email)
- Urgency detection that flags emergencies
- 3-step timed follow-up sequence
- Hot / warm / cold lead scoring with human-readable reasons
- Multi-turn: later replies drop the intro pitch and continue the conversation

**Optional AI drafting** (`lib/ai.js`) — off by default.
- Uses any OpenAI-compatible endpoint via your own `USER_LLM_*` credentials
- Validates every draft and rejects invented prices, empty, or oversized replies
- Falls back to the deterministic engine on any failure, so a bad key never breaks a live lead
- RingBack never reads platform or runtime credential variables; you supply the key

**Lead CRM** (`lib/store.js`, `/dashboard`)
- Pipeline: new → contacted → booked → lost
- Job value per lead and estimated revenue recovered
- Search, status/heat/channel filters, notes, CSV export
- 14-day volume chart and per-channel breakdown

**Storage** (`lib/db.js`)
- `node:sqlite` when available (default on Node 22+), with a JSON file fallback
- Tables for leads, setups, businesses, users, sessions, payments
- Single data API in `lib/store.js`; swap it for Postgres when you need multi-user

**Accounts and access** (`lib/auth.js`)
- First admin created from `RB_ADMIN_EMAIL` / `RB_ADMIN_PASSWORD`, or via `/api/auth/register`
- scrypt password hashing, HttpOnly session cookies, logout and session expiry
- The CRM is open while no admin exists (frictionless local demo) and locked down once one does, or when `RB_ENFORCE_AUTH=1`
- Webhooks and the setup form stay public so leads never stop flowing
- Machine access via `ADMIN_TOKEN` (bearer header or `?token=`)

**Billing** (`lib/plans.js`, `lib/billing.js`)
- Plans: Starter $99/mo, Professional $199/mo, Business $349/mo, plus a $149 one-time setup
- Uses **your own** payment links (Stripe, PayPal, Razorpay, or any HTTPS link). RingBack never processes cards
- Records payments and reports collected vs. monthly recurring value

## API (the actual product)

```bash
# Missed call -> instant text-back
curl -X POST http://localhost:4000/api/missed-call \
  -H 'Content-Type: application/json' \
  -d '{"from":"+15125550198","name":"Alex"}'

# Channel webhooks
curl -X POST http://localhost:4000/api/whatsapp   -H 'Content-Type: application/json' -d '{"name":"Priya","phone":"+15125550111","message":"Can you quote?"}'
curl -X POST http://localhost:4000/api/facebook   -H 'Content-Type: application/json' -d '{"name":"Sam","message":"Do you serve Round Rock?"}'
curl -X POST http://localhost:4000/api/instagram  -H 'Content-Type: application/json' -d '{"name":"Lee","message":"How much for a deep clean?"}'
curl -X POST http://localhost:4000/api/webchat    -H 'Content-Type: application/json' -d '{"message":"Are you open Sunday?"}'
curl -X POST http://localhost:4000/api/google-ads -H 'Content-Type: application/json' -d '{"name":"Kim","phone":"+15125550123","message":"Need a roof inspection"}'

# Any channel, one endpoint
curl -X POST http://localhost:4000/api/message \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alex","message":"How much?","channel":"facebook","history":[{"role":"in","text":"hi"},{"role":"out","text":"Hello"}]}'

# Preview a reply without saving anything
curl -X POST http://localhost:4000/api/demo \
  -H 'Content-Type: application/json' \
  -d '{"message":"How much to fix my AC?","channel":"sms"}'

# Plans and ROI
curl http://localhost:4000/api/plans
curl "http://localhost:4000/api/value?missedCalls=20&avgJobValue=450&closeRate=30"

# CRM (auth required once an admin exists)
curl http://localhost:4000/api/leads
curl http://localhost:4000/api/leads/LEAD_ID
curl -X PATCH http://localhost:4000/api/leads/LEAD_ID \
  -H 'Content-Type: application/json' \
  -d '{"status":"booked","jobValue":780,"notes":"Booked Tue 2pm"}'
curl http://localhost:4000/api/leads/export
curl http://localhost:4000/api/report
curl http://localhost:4000/api/channels

# Auth
curl -X POST http://localhost:4000/api/auth/register -H 'Content-Type: application/json' -d '{"email":"owner@acme.com","password":"a-long-password"}'
curl -c cookies.txt -X POST http://localhost:4000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"owner@acme.com","password":"a-long-password"}'
curl -b cookies.txt http://localhost:4000/api/auth/session
curl -b cookies.txt -X POST http://localhost:4000/api/auth/logout

# Billing
curl http://localhost:4000/api/billing/status
curl "http://localhost:4000/api/billing/checkout?plan=Professional"
curl -X POST http://localhost:4000/api/payments -H 'Content-Type: application/json' -d '{"business":"Acme HVAC","plan":"Professional","amount":199}'
curl http://localhost:4000/api/payments

# Pre-sell
curl -X POST http://localhost:4000/api/setup \
  -H 'Content-Type: application/json' \
  -d '{"business":"Acme HVAC","email":"owner@acme.com","plan":"Professional"}'
curl http://localhost:4000/api/setups
```

Point Twilio, CallRail, GoHighLevel, Zapier, Make, or n8n at these endpoints.

## Configuration

Copy `.env.example` to `.env`. Everything except `HOST`/`PORT` is optional for a local run.

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 4000) |
| `HOST` | Bind address (default `127.0.0.1`; set `0.0.0.0` in containers) |
| `ADMIN_TOKEN` | Optional; machine access to the CRM via bearer header or `?token=` |
| `RB_ADMIN_EMAIL` / `RB_ADMIN_PASSWORD` | Creates the first admin on boot and turns on auth |
| `RB_ENFORCE_AUTH` | Force auth on (`1`) or off (`0`) regardless of whether users exist |
| `RB_SECURE_COOKIES` | Set `1` behind HTTPS to mark the session cookie Secure |
| `RB_SESSION_DAYS` | Session lifetime in days (default 7) |
| `RB_PAYMENT_LINK*`, `RB_PAYPAL_ME`, `RB_RAZORPAY_LINK`, `RB_STRIPE_LINK` | Your own payment links; any one enables checkout |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | Optional; enables real outbound SMS. Without them SMS runs in simulated mode |
| `USER_LLM_API_KEY` / `USER_LLM_BASE_URL` / `USER_LLM_MODEL` | Optional; enables AI drafting. You supply your own key |
| `USER_LLM_TIMEOUT_MS` | Optional; AI request timeout (default 12000) |
| `RINGBACK_DATA_DIR` | Directory for the SQLite file (default `./data`) |
| `RINGBACK_DB` | Override the database path (used by tests) |

Never commit real credentials. RingBack never reads platform or runtime credential variables.

## Tests

```bash
npm test
```

110 tests across the reply engine, AI validation, store/DB, HTTP API, auth, billing, and UI wiring.

## Selling it

The product is built. Revenue comes from the outreach in `outreach/`.

```bash
npm run scoreboard
```

Fill `outreach/prospects.csv`, work the daily quota, and read the scoreboard verdict. `outreach/README.md` has the ICP, the scripts, the objections, and the kill criteria.

## Deploy

See `DEPLOY.md`. It covers Fly.io, Render, Docker, and systemd, plus the two things that matter: persist the database and set your own credentials.

## Stack

Zero-dependency Node HTTP server, static front-end, deterministic reply engine, `node:sqlite` store with JSON fallback. Chosen because the MVP had to be reliable, cheap, and live in 48 hours. Swap `lib/store.js` for Postgres when a customer needs multi-user access.

See `RESEARCH.md` for the market evidence, scoring, and acquisition plan.
