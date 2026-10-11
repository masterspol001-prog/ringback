# Market Research & Decision — RingBack

Date: 2026-09-14. Mission: find ONE real market, build the smallest useful thing, get the first legitimate payment.

Everything below is either a live query run today or explicitly labelled as a prior-session observation. Nothing is invented.

---

## 1. Market signals (sources)

Access notes: Google/DuckDuckGo HTML search and Upwork/Reddit returned bot challenges and were unusable. Google Trends returned HTTP 429 (IP rate-limited). These sources worked and were queried today:

| Source | Query / endpoint | Finding |
|---|---|---|
| Google Autocomplete | `automate lead*` | `automate leads`, `automate lead generation with ai`, `automate lead routing`, `how to automate lead qualification`, `automate lead follow up`, `automate lead management` |
| Google Autocomplete | `n8n vs*` | `n8n vs zapier`, `n8n vs make`, `n8n vs langflow`, `n8n vs activepieces`, `n8n vs node red` |
| Google Autocomplete | `automate whatsapp*` | `automate whatsapp messages n8n` surfaced inside top 10 |
| Google Autocomplete | `how to manage leads*` | `how to manage leads in excel`, `how to manage indiamart leads`, `how to manage leads in hubspot/salesforce/zoho` |
| Google Autocomplete | `missed call text back*` | `missed call text back software`, `... automation`, `... service`, `... ghl`, `... roi calculator`, `... software free` |
| Google Autocomplete | `hvac missed call*` | `hvac missed calls`, `hvac missed call text back` |
| Google Autocomplete | `connect crm to*` | `connect crm to meta ads`, `to facebook leads`, `to google ads`, `to website`, `to facebook` |
| Freelancer.com API | `projects/0.1/projects/active?query=...` | See tables below |
| HN Algolia API | `n8n automation` | Active launches, Udemy n8n masterclass, "Brinode" (build n8n automations by describing them) |
| HN Algolia API | `lead to CRM automation` | Engineers advertising "working systems for managing leads to CRM", n8n + Airtable + LLM stacks |
| Remotive API | `search=automation` | Only senior engineering roles (Lemon.io, A.Team) — weak signal for this niche |
| RemoteOK API | 99 postings scanned | `n8n`/`zapier`/`crm` = 0; `salesforce` = 6. Boards are not where this work lives |

### Live paid-gig evidence (Freelancer.com, queried today)

Active matching projects and median budgets:

| Query | Active projects | USD median | USD p90 | INR median | INR p90 | Median bids/job | Max bids |
|---|---|---|---|---|---|---|---|
| whatsapp automation | 358 | $170 | $4,000 | ₹7,000 | ₹25,000 | 30 | 359 |
| missed call | 440 | $320 | $4,000 | ₹7,000 | ₹25,000 | 32 | 245 |
| lead qualification | 438 | $140 | $500 | ₹7,250 | ₹25,000 | 12 | 305 |
| invoice automation | 243 | $200 | $4,000 | ₹7,000 | ₹56,250 | 42 | 359 |
| appointment booking | 174 | $500 | $4,000 | ₹7,000 | ₹25,000 | 40 | 318 |
| data entry automation | 1,272 | $50 | $500 | ₹7,000 | ₹25,000 | 33 | 331 |
| google sheets automation | 1,087 | $140 | $4,000 | ₹7,000 | ₹25,000 | 38 | 386 |
| real estate automation | 912 | $160 | $500 | ₹7,000 | ₹25,000 | 28 | 425 |
| n8n | 17 | $140 | $140 | ₹7,000 | ₹7,000 | 76 | 221 |
| goHighLevel | 13 | $140 | $500 | ₹25,000 | ₹25,000 | 60 | 251 |
| airtable | 5 | $500 | $500 | — | — | 73 | 277 |
| power automate | 178 | $140 | $500 | ₹7,000 | ₹25,000 | 30 | 285 |

Representative real postings (verbatim titles):

- `HVAC Missed-Call to WhatsApp Booking System Template` — INR 1,500–12,500, 40 bids
- `Automated Missed-Call Follow-up Recovery Solution` — INR 1,500–12,500, 24 bids
- `Automated WhatsApp Lead Workflow` — INR 1,500–12,500, 53 bids
- `CRM Automation System Development` — INR 1,500–12,500, 76 bids
- `n8n Data Automation & API Integration` — USD 15–25/hr, 155 bids
- `n8n Customer Onboarding Workflow` — USD 30–250, 212 bids
- `AI Automation Expert | n8n, AI Agents, APIs & CRM Automation` — USD 30–250, 67 bids
- `Facebook Rental Reply Bot` — GBP 20–250, 192 bids ("I run a car-rental page and I'm wasting too much time manually answering 'How much?' on public posts")
- `Gmail to Jobber Request Automation System` — USD 2–8/hr, 78 bids
- `Sales Operations CRM Setup` — INR 600–1,500, 13 bids

**The single most important number in this report: median 30–76 bids per generic automation job, peaking at 425.** Money is changing hands, but competing as "yet another AI automation freelancer" on marketplaces is a race to the bottom against hundreds of bidders, most with reviews and portfolios. That is a distribution problem, not a demand problem.

Prior-session observations (label: prior, not re-verified today): Upwatcher scrape of Upwork found 3,324 "AI automation" posts with median $29.50/hr, P75 $40, P90 $60, fixed median $150 / P90 $2,000; n8n 16.1% > Zapier 11.9% > Make 10.7%. DevSnipe found GoHighLevel 768 vs n8n 579.

---

## 2. Top 20 opportunities (ranked)

Scoring: demand 20, pain 15, existing spend 15, competition gap 10, reachability 10, price 10, recurring 10, feasibility 5, speed 5.

| # | Opportunity | Demand | Pain | Spend | Gap | Reach | Price | Recur | Feas | Speed | **Total** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Missed-call text-back + lead follow-up for home services | 18 | 14 | 14 | 8 | 8 | 8 | 9 | 5 | 5 | **89** |
| 2 | Reply bot for marketplace/social "how much?" comments (rentals, retail) | 15 | 13 | 11 | 8 | 8 | 7 | 8 | 5 | 5 | **80** |
| 3 | Instant response + booking for clinics (dental, physio) | 15 | 13 | 12 | 7 | 7 | 8 | 9 | 5 | 4 | **80** |
| 4 | Lead-to-CRM integration for agencies (white-label) | 15 | 12 | 13 | 6 | 7 | 9 | 9 | 4 | 4 | **79** |
| 5 | Review-request automation for local services | 15 | 11 | 12 | 5 | 8 | 6 | 8 | 5 | 5 | **75** |
| 6 | Web-form -> CRM instant routing for SMB | 14 | 11 | 12 | 5 | 7 | 7 | 8 | 5 | 5 | **74** |
| 7 | Real-estate lead instant response + showing booking | 15 | 12 | 12 | 5 | 7 | 8 | 8 | 4 | 3 | **74** |
| 8 | Appointment reminders + no-show recovery | 15 | 12 | 12 | 5 | 7 | 7 | 8 | 4 | 3 | **73** |
| 9 | WhatsApp lead qualification for Indian SMBs | 16 | 12 | 10 | 6 | 6 | 5 | 8 | 4 | 4 | **71** |
| 10 | Google Sheets / data-entry automation for ops teams | 18 | 10 | 10 | 3 | 6 | 4 | 6 | 5 | 5 | **67** |
| 11 | Invoice/receipt processing automation | 16 | 11 | 11 | 4 | 6 | 6 | 7 | 4 | 3 | **68** |
| 12 | Cold-email infrastructure + deliverability | 14 | 10 | 10 | 4 | 6 | 6 | 7 | 4 | 4 | **65** |
| 13 | AI receptionist / voice agent | 16 | 12 | 13 | 2 | 5 | 8 | 9 | 2 | 2 | **69** |
| 14 | Resume screening for recruiters | 12 | 9 | 10 | 4 | 5 | 6 | 7 | 4 | 4 | **61** |
| 15 | Social media content automation for agencies | 14 | 9 | 10 | 3 | 5 | 5 | 7 | 4 | 4 | **61** |
| 16 | E-commerce order/support automation | 14 | 10 | 11 | 3 | 5 | 6 | 7 | 3 | 3 | **62** |
| 17 | Local SEO / GBP posting automation | 13 | 9 | 10 | 4 | 6 | 5 | 6 | 3 | 3 | **59** |
| 18 | LinkedIn outreach automation for founders | 13 | 9 | 10 | 3 | 5 | 5 | 6 | 4 | 4 | **59** |
| 19 | GST invoice software for Indian SMBs | 16 | 11 | 8 | 2 | 5 | 3 | 5 | 4 | 3 | **57** |
| 20 | AI chatbot for websites | 15 | 9 | 10 | 2 | 4 | 4 | 6 | 4 | 4 | **58** |

---

## 3. Winner

**Missed-call text-back + instant lead follow-up for local service businesses (home services first).**

Build product name: **RingBack**. Tagline: "Every missed call becomes a booked job."

## 4. Why this won (evidence, not motivation)

- `missed call text back` is an established search category with commercial intent variants (`software`, `service`, `automation`, `ghl`, `roi calculator`) — people are actively shopping, not just curious.
- `hvac missed call text back` appears in autocomplete — a vertical-specific commercial query.
- Freelancer.com today: 440 live `missed call` projects, USD median $320, INR median ₹7,000, p90 $4,000 / ₹25,000. Businesses already pay for this.
- Two separate live postings ask for exactly this, one as a *template*: `HVAC Missed-Call to WhatsApp Booking System Template`, `Automated Missed-Call Follow-up Recovery Solution`.
- Adjacent, same-pain postings confirm breadth: `Facebook Rental Reply Bot`, `Automated WhatsApp Lead Workflow`, `CRM Automation System Development`.
- HN Algolia confirms a live ecosystem of people building lead-to-CRM systems on n8n + Airtable + LLMs.
- The pain is directly tied to revenue (a missed call is a missed job), the buyer is a business owner with a credit card, and the outcome is measurable in booked jobs.

## 5. Rejected before choosing (ruthless filter)

- **Generic "AI automation freelancer" on Upwork/Freelancer** — killed. 30–425 bidders per job. Distribution death for an unknown seller.
- **GST invoice software (India)** — killed. Autocomplete is dominated by `free download`, `free software`, `crack-adjacent` intent. Free tools own the market.
- **AI receptionist / voice agent** — killed. Commoditized, crowded, expensive to build, months to revenue.
- **Cold-email automation** — killed. Price floor ($15/hr) and deliverability risk.
- **Data-entry automation** — killed. 1,272 projects but USD median $50. Not worth the delivery cost.
- **Resume screening / applications** — killed. We already over-built in this space; no moat, buyers won't pay early.
- **Anything requiring app review, telephony licensing, or enterprise sales** — killed. Not a 48-hour MVP.

## 6. Customer (exact profile)

Home-service owner-operator or small team: HVAC, plumbing, roofing, electrical, cleaning, landscaping, pest control; 1–15 employees; $150k–$3M revenue; advertises on Google/Facebook; the owner answers the phone themselves while working. Secondary: dental/physio clinics, car rentals, real estate agents.

## 7. Pain (exact workflow)

Owner is on a job. Phone rings, no answer, no voicemail. Caller doesn't leave a message — they call the next company. The lead is gone and the owner never knows it existed. Same failure on web forms and Facebook lead ads: inquiry sits unread for 4–24 hours, by which time the customer booked someone else.

## 8. Competitors and the gap

- **Answering services** — $300–1,500/mo, new number, weeks of scripting, no follow-up.
- **All-in-one CRM platforms (Podium, GoHighLevel, etc.)** — $300–900/mo plus add-ons, self-serve configuration, meant for teams with a marketer.
- **Freelancers** — cheap but unaccountable, no monitoring, no follow-up.

**Gap:** an affordable, done-for-you, outcome-priced service for the micro-contractor who will never configure a platform. Under $200/mo, live in 48 hours, works with the number they already have, follow-up included.

## 9–10. Product and MVP (what was built)

`/workspace/ringback` — zero-dependency Node server + static front-end. Live now.

- Landing page with hero, interactive ROI calculator, multi-turn live demo, channels section, before/after, pricing, comparison table, FAQ, and a setup-request form (pre-sell).
- **Real reply engine** (`lib/engine.js`): intent classification (price, availability, booking, service area, hours, finance, warranty, general), channel-aware replies across 9 channels (missed call, SMS, WhatsApp, Facebook, Instagram, Google Ads, web chat, web form, email), urgency detection, 3-step timed follow-up, multi-turn continuation, and hot/warm/cold lead scoring. Deterministic — no LLM, no API key, no invented prices.
- **Optional AI drafting** (`lib/ai.js`), off by default: uses the operator's own `USER_LLM_*` credentials against any OpenAI-compatible endpoint, validates every draft, and rejects invented prices. Falls back to the deterministic engine on any failure.
- **Real webhooks**: `POST /api/missed-call`, `/api/whatsapp`, `/api/facebook`, `/api/instagram`, `/api/webchat`, `/api/google-ads`, unified `POST /api/message`, plus `/api/demo`, `/api/setup`.
- **Lead CRM** at `/dashboard`: pipeline (new/contacted/booked/lost), job value per lead, estimated revenue recovered, search and status/heat/channel filters, notes, 14-day volume chart, per-channel breakdown, and CSV export.
- **Accounts and access** (`lib/auth.js`): first admin from `RB_ADMIN_EMAIL`/`RB_ADMIN_PASSWORD`, scrypt password hashing, HttpOnly session cookies, login/logout/expiry. The CRM stays open while no admin exists so local demos never break; webhooks and the setup form stay public so leads never stop. `ADMIN_TOKEN` covers machine access.
- **Billing** (`lib/plans.js`, `lib/billing.js`): the three plans above, checkout built on the operator's **own** payment link (Stripe/PayPal/Razorpay/any HTTPS URL). RingBack never processes cards and never invents a URL — it reports `not_configured` until a real link is set. `POST /api/payments` records what came in.
- **Storage** (`lib/db.js`): `node:sqlite` on Node 22+ with a JSON fallback, tables for leads, setups, businesses, users, sessions, and payments, all behind a single data API in `lib/store.js`.
- Optional Twilio SMS sending, env-gated; simulated mode otherwise so demos never break.
- 110 passing tests across engine, AI validation, store/DB, HTTP API, auth, billing, and UI wiring (`npm test`).

Deliberately excluded: multi-tenant team roles, a marketplace app store listing, a mobile app, and Postgres (swap `lib/store.js` when a customer needs multi-user).

## 10b. Outreach kit (the part that earns the first payment)

- `outreach/README.md` — ICP, daily quota (25 personalized contacts/day), email/WhatsApp/call/voicemail scripts, objection handling, demo strategy, and kill criteria.
- `outreach/prospects.csv` — tracker with the funnel statuses.
- `outreach/scoreboard.mjs` (`npm run scoreboard`) — reads the CSV, prints the funnel with reply/interest/call/paid rates, per-channel breakdown, and a blunt verdict against the kill rule.

## 10c. Deploy

- `DEPLOY.md` plus `Dockerfile`, `fly.toml`, and `render.yaml`. The two things that matter: persist `RINGBACK_DATA_DIR` on a volume, and set your own admin credentials and payment link.

## 11. Price

Setup fee + recurring, priced against the value of one recovered job, not against $9/mo SaaS.

- **Starter — $99/mo** + $0 setup (first 10 customers): missed-call text-back, one channel, dashboard.
- **Professional — $199/mo** + $0 setup (first 10): calls + web + Facebook, 3-step follow-up, Sheets/CRM sync, lead scoring.
- **Business — $349/mo** + $149 setup: multi-location, custom replies, review requests, monthly report.
- SMS at cost (~$0.01/message). Founding-customer price locked for life. Cancel anytime.

## 12. Acquisition (₹0 ads)

1. **The ROI calculator is the top of funnel.** It is linkable, shareable in groups, and makes the loss tangible before any pitch.
2. **Founding-customer offer** (first 10, setup free, price locked) gives a real reason to reply now without faking scarcity or testimonials.
3. Direct outreach in communities where contractors already gather: r/HVAC, r/Plumbing, r/roofing, r/smallbusiness (follow each sub's promo rules), Facebook contractor/owner groups, local business associations, and LinkedIn to "owner" at 2–20-person trade companies.
4. Personalized email: reference their trade, their city, and the specific number on their site/GBP. One line of proof: the calculator link and the demo.
5. Partner channel: agencies and GHL resellers who have contractor clients but no delivery capacity — white-label us.
6. Marketplaces last, and narrowly: only post-gigs where the client is payment-verified and budget-stated. Do not run 200-bid races.

## 13. First 100 prospects

- Pull 60 from Google Maps: search "hvac near me" / "plumber near me" for 4–6 mid-size US metros, keep businesses with 20–300 reviews and a website with a contact form.
- Pull 25 from Facebook/Google ad activity: businesses running lead-gen ads (visible "Sponsored" posts) have measurable cost per lead, so a missed lead hurts more.
- Pull 15 agency partners: search "GoHighLevel agency", Clutch/GoodFirms "home services marketing", and LinkedIn "marketing agency for contractors".
- Qualify with: does the phone go unanswered after hours, is there a web form, do they advertise. Record name, phone, email, city, trade, ad-running flag.

## 14. 7-day execution plan

- **Day 1** — Product live (done). Build the 100-prospect list. Send the first 25 personalized emails + 10 agency notes.
- **Day 2** — Reply within 30 minutes to every response. Book calls. Follow up on all unanswered messages once. Send next 25.
- **Day 3** — Run calls with the live demo and calculator. Offer founding-customer terms to anyone who feels the pain. Send next 25.
- **Day 4** — Close the first paid pilot (card/paypal). Start setup the same day.
- **Day 5** — Deliver: connect number, load replies, test with the customer, go live.
- **Day 6** — Watch the first real leads, tune replies, request a testimonial from anyone with results.
- **Day 7** — Ask for one referral per live customer. Publish the first honest case note. Keep top of funnel at 25/day.

## 15. Build status

Live at `/workspace/ringback`. Run `npm start` (port 4000). Tests: `npm test` (55 passing). See `README.md` for endpoints and configuration.

## 16. Validation and kill criteria

Scoreboard: prospects contacted, replies, reply rate, calls booked, calls held, trials, paid pilots, one-time revenue, MRR, churn, acquisition source.

- Contact 50 qualified prospects and get **< 5% reply** → the message is wrong, not necessarily the market. Rewrite the hook (lead with the lost-revenue number and the demo), then test 50 more.
- Get replies but **no one will pay** → pricing/value proposition is wrong. Drop to a one-time $99 pilot or offer performance terms.
- People pay but **churn after month 1** → the product isn't visibly working. Add a monthly "jobs recovered" report.
- People want it but **acquisition stalls** → distribution is wrong. Shift to agency white-label and partner referrals.
- 100 qualified prospects, no replies, after two message rewrites → **stop**. The pain is real but this buyer isn't reachable by us this way; move to the #2 opportunity (social comment reply bots).

Honesty note: the realistic time to first payment is 1–3 weeks, not days.
