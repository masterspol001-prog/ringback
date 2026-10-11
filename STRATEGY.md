# RingBack — revenue recovery, first 10 customers

Positioning: we recover missed revenue for local service businesses. We do not sell AI.

Launch niche: HVAC. After-hours volume, high job value, callers who will not voicemail, and a tight emergency vocabulary. Plumbing and electrical reuse the same loop after ten HVAC shops prove recovered jobs.

Do not spend on ads until the metrics below are true.

## Homepage (shipped)

1. Hero — "Stop losing jobs when you miss the phone." CTAs: Calculate My Lost Revenue, Watch a Live Demo.
2. ROI calculator — missed calls, job value, close rate, recovery rate. Model, not a guarantee.
3. Live demo + owner snapshot (intent, urgency, estimated value, next action).
4. How it works — respond, qualify/book, follow up, report estimated vs verified dollars.
5. Before / after Monday morning.
6. Competitive table — recover revenue vs answer calls vs CRM capture. No competitor-bashing.
7. Trust — numbers, SMS STOP, emergencies, unknowns, data, no fake badges.
8. Pricing experiment — Starter $99 missed-call recovery; Professional $199 growth; Business $349 multi-location. Change in `lib/plans.js` after customer interviews.
9. Setup in 48 hours. First 10 shops: setup free. No card to talk.
10. HVAC page at `/hvac`. Other vertical pages wait.

## Dashboard architecture (shipped)

Headline is dollars, not inbox count.

- Estimated revenue = booked, not yet won.
- Verified revenue = owner marked won.
- Recovered (compat) = estimated + verified so v1 reports stay green.
- Qualified, follow-ups active, missed calls, ROI vs $199 model cost.
- Lead card: name, phone, source, intent, service, location, heat + reasons, transcript, value, status, appointment, follow-up, takeover.

## MVP priority

P0 (this build): missed-call SMS, qualification, booking offer, 4h/24h/72h follow-up, STOP, emergency escalate without technical claims, estimated vs verified dashboard, HVAC landing, calculator, demo snapshot, setup form, referrals, funnel events.

P1 (after 10 paying HVAC shops): live inbound answering, Google Calendar, Jobber/Housecall Pro, custom follow-up wording in settings UI, voicemail drop.

P2: ServiceTitan, HubSpot, Salesforce, voice recording, reviews, reactivation, payments, white-label, extra vertical sites.

Do not build yet: dozens of integrations, ads, fake testimonials, guaranteed ROI, extra AI features, clinic/real-estate push, keep-alive tools.

## Onboarding (48 hours)

1. Shop name, number, trade, hours, area, booking link, emergency yes/no, approved FAQs.
2. Forward unanswered calls. Test with one fake missed call.
3. Owner watches dashboard: estimated vs verified labeled.
4. 14-day proof window. Pay when a recovered conversation is visible — not before.

## Pricing experiment

Keep three prices in `lib/plans.js`. Sell Professional ($199) as default. If three HVAC owners say $199 is above one recovered job, hold. If they stall on $199, trial Starter. Do not guess a fourth tier.

## Analytics events

`page_view`, `demo_start`, `demo_complete`, `cta_click`, `calculator_used`, `trial_start`, `setup_request`, `number_connected`, `lead_recovered`, `booking`, `paid_conversion`, `referral_sent`.

Must prove before ads: 20+ HVAC conversations from outbound, 5+ demos completed, 3+ numbers connected, 10+ recovered conversations, 3+ jobs marked won with verified dollars > monthly fee, CAC not measured yet so do not buy traffic.

## First 100 customers (only after 10)

1–10: owner outbound HVAC, 25 contacts/day via `outreach/`, personalized demo, 14-day proof, collect verified jobs.  
11–30: referrals from those shops + one HVAC Google LSA / FB group test under $200 only if 3 shops paid.  
31–100: one paid HVAC channel that already converted a trial, then plumbing.

## 90 days

Days 1–14: talk to 50 HVAC owners, 10 live demos, 3 numbers connected.  
Days 15–45: 10 paying or in-proof shops; every dashboard shows estimated vs verified.  
Days 46–90: double-down on whatever produced a paid shop. No second vertical, no ads scale.

## Technical

Zero-dep Node 18+. SQLite / JSON. Deterministic receptionist. Optional `USER_LLM_*`. Honest integration states. Rate-limit + webhook fail closed. Funnel collection `analytics_events`.

## Security / compliance

Session cookie. STOP / do-not-contact. No invented prices. No recording by default. Export/delete. No sale of leads. Escalate emergencies to a human.

## Risks to validate

1. Owners will not forward the number — test with 5 installs.  
2. SMS does not recover HVAC jobs — require 3 won jobs before any ad spend.  
3. $199 is wrong — interview, do not invent a new SKU.  
4. After-hours liability — never claim dispatch; escalate.

Scoreboard: paying shops, verified recovered dollars, not features shipped.
