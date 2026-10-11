# Outreach Playbook

The product is done. Nothing in this folder earns money by existing. This is the part that does.

**The one rule:** you are not selling "AI." You are selling *"the job you lost last Tuesday because nobody called back."*

---

## ICP (who to contact)

Highest intent, easiest to reach, and clearly bleeding missed calls:

| Trade | Why they miss calls | Where to find them |
|---|---|---|
| HVAC | Emergency volume, one-person office | Google Maps "near me", Yelp |
| Plumbing | Calls while on a job, hands dirty | Google Maps, Nextdoor |
| Roofing | Storm spike, high ticket | Google Maps, Facebook groups |
| Cleaning | Quotes by phone, busy mornings | Google Maps, Thumbtack |
| Dental | Front desk at lunch | Google Maps, Zocdoc |
| Locksmith / towing | 24/7, after-hours gap | Google Maps |
| Landscaping / pest | Seasonal bursts | Google Maps |

Filter for: **20+ reviews, 4.0+ rating, a phone number, and no live chat on the site.** Those are the ones who answer the phone themselves.

---

## Daily quota

25 new contacts per day. Every day. Roughly 3 hours:

- 15 first-touch messages (email or WhatsApp/form)
- 5 phone calls to the same people later that day or next morning
- 5 follow-ups to day-2 and day-3 non-responders

Do this for 30 days. That is 750 contacts. At a realistic 8-15% reply rate that is 60-110 conversations. You need **one** to pay.

Track everything in `prospects.csv`. Add one shop at a time from the dashboard (Add one HVAC prospect) or type the row yourself. RingBack drafts the email. It does not scrape Maps and it does not send.

Run:

```bash
npm run scoreboard
```

---

## Scripts

Send manually. Personalized, one at a time. Bulk-blasting is spam and it burns the list.

### Email / WhatsApp — first touch

> Subject: `{{business}} — missed call at {{time}}`
>
> Hi {{name}},
>
> I called {{business}} yesterday afternoon and got voicemail — no one called me back.
>
> I found a few more recent reviewers saying the same thing, so I don't think it was a one-off.
>
> Every missed call is someone who was ready to spend money right then. Most of them just call the next company on the list.
>
> I built a small tool that texts them back within seconds, asks what they need, and queues them for you. Want me to set it up on your number for 14 days free? You'll see the leads it saves in a dashboard.
>
> If not, no worries — here's the honest version of this email so you can judge it yourself: {{demo_link}}
>
> {{your name}}
> {{phone}}

Then **actually call them** a few hours later. The email is the warm-up; the call is the close.

### Cold call — opening 15 seconds

> "Hi, is this {{name}} at {{business}}? ... I'll be quick — I called yesterday around 2pm and got voicemail, no callback. I'm not selling you ads or a new phone system. I set up a small tool that texts missed callers back within seconds so they don't call your competitor instead. Two other {{trade}} shops in {{city}} are using it. Can I show you what it would've sent that guy, in 3 minutes?"

If they say "how much": give the number immediately. Starter is $99/month plus a one-time $149 setup. Do not dance.

### Voicemail (under 20 seconds)

> "Hi {{name}}, {{your name}} here. Quick one — I called and got voicemail, which is exactly the problem I solve. I set up text-back for missed calls for {{trade}} shops. I'll try again this afternoon, or call me at {{phone}}."

### Objections

**"I already have voicemail / an answering service."**
> "Voicemail is where leads go to die — you're returning calls the next day, after they've already hired someone. And answering services are $300-800 a month and they read a script. This texts back in 5 seconds and books the job."

**"Too expensive."**
> "One HVAC job is $400-800. If this saves you one job a month it's paid for itself 4x over. That's the whole test — 14 days, look at the dashboard, if it doesn't save a single lead you pay nothing."

**"Is this AI?"**
> "The replies are written from your trade — what you do, your hours, your prices, your rules. If you connect your own AI key it drafts in your voice, but the default is a deterministic engine that never makes up prices. Either way you approve the templates before anything goes out."

**"Send me info."** (the polite no)
> "Sure — I'll send it now. But so I'm not wasting your time: is the missed-call thing even a real problem for you, or do most people leave a voicemail and wait?"

**"Why are you based in India?"**
> "Because that's where I am. The tool runs on your number and your leads stay in your dashboard — I never touch them. You're paying for response speed, not my time zone."

---

## Demo strategy (your unfair advantage)

Never ask someone to imagine it. Show it:

1. Open `{{demo_link}}?biz={{business}}&ch=missed_call`. It is pre-filled with their business name.
2. Paste the exact message a real missed caller would send: *"Hi, my AC stopped cooling, how soon can someone come out?"*
3. Hit send. Show the reply. Show the follow-up sequence. Show the hot/warm/cold label.
4. Then: "This is what every missed call gets, in about five seconds. Want it on your line for 14 days?"

That is a 3-minute demo with zero signup and zero setup. It closes.

---

## Kill criteria

Check the scoreboard weekly. Be honest with yourself.

- **50+ contacted, under 5% reply** → the message is broken, not the market. Rewrite the hook, test 50 more.
- **100+ contacted, zero calls booked** → wrong ICP or wrong offer. Switch to a different trade.
- **3 weeks in, zero payments** → the DIY tool beats paying you. Either bundle setup + management as a done-for-you service at a higher price, or move to the next opportunity.
- **Ready to quit?** Go do the 30-day test properly first. Most people quit at 20 contacts, not 500.

---

## Scoreboard

```bash
npm run scoreboard
```

Reads `prospects.csv` and prints the funnel with a verdict. Status values:

`new` → `contacted` → `replied` → `interested` → `call_booked` → `paid`
(use `lost` or `skip` to close them out)

Fill in `channel` (`email`, `whatsapp`, `call`, `form`) so you can see which one actually works.
