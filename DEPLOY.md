# Deploying RingBack

RingBack is a single Node process with no dependencies and a SQLite file. Any host that can run a container or a Node 22 process will work.

Two things to get right:
1. **Persist the database.** Point `RINGBACK_DATA_DIR` at a mounted volume, or you lose your leads on every deploy.
2. **Set your own credentials.** At minimum an admin login. Everything else (SMS, AI, payments) is optional.

---

## What to set

| Variable | Required | Why |
|---|---|---|
| `HOST` | In containers: `0.0.0.0` | The default binds to loopback, which is unreachable from outside the container |
| `PORT` | Usually provided by the host | RingBack reads it |
| `RINGBACK_DATA_DIR` | Yes on a server | Where the SQLite file lives. Mount a volume here |
| `RB_ADMIN_EMAIL` + `RB_ADMIN_PASSWORD` | Yes | Creates the first admin on boot. Password must be at least 8 characters |
| `RB_SECURE_COOKIES=1` | Yes behind HTTPS | Marks the session cookie Secure |
| `RB_PAYMENT_LINK_*`, `RB_PAYPAL_ME`, or `RB_RAZORPAY_LINK` | For taking money | Your own payment link. One Razorpay.me handle covers every plan. RingBack never processes cards |
| `RB_BILLING_MODE` | Optional | `test` or `live`. Unset: sandbox/test URLs are test |
| `RB_PUBLIC_URL` | Optional | Public origin so checkout can advertise `/pay/success` and `/pay/cancel`. Those pages never mark a shop paid |
| `TWILIO_*` | For real SMS | Without them, SMS is simulated so demos still work. Point Twilio SMS webhook at `/api/twilio/sms` and missed-call/status at `/api/twilio/voice` |
| `USER_LLM_*` | For AI replies | Your own key against any OpenAI-compatible endpoint |

**How auth behaves:** RingBack is open while no admin exists, so a fresh local run is frictionless. The moment an admin account exists (or `RB_ENFORCE_AUTH=1`), the CRM requires a session. Webhooks and the setup form stay public either way.

Generate a strong password:

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

---

## Option A: Fly.io

```bash
fly launch --no-deploy --copy-config --name your-ringback-app
fly volumes create ringback_data --size 1 --region sin
fly secrets set RB_ADMIN_EMAIL=you@example.com RB_ADMIN_PASSWORD='your-long-password'
fly secrets set RB_PAYMENT_LINK_PROFESSIONAL='https://buy.stripe.com/xxxx'
fly deploy
```

Edit `fly.toml` first to set `app` and `primary_region`. `sin` (Singapore) is the closest region to India.

## Option B: Render.com

Push to GitHub, then **New > Blueprint**, pick the repo, and fill in the secrets Render prompts for. `render.yaml` provisions the persistent disk and env vars.

## Option C: Any VPS with Docker

```bash
docker build -t ringback .
docker run -d --name ringback \
  -p 80:8080 \
  -v /var/lib/ringback:/data \
  -e RB_ADMIN_EMAIL=you@example.com \
  -e RB_ADMIN_PASSWORD='your-long-password' \
  -e RB_SECURE_COOKIES=1 \
  --restart unless-stopped \
  ringback
```

Put a TLS-terminating reverse proxy (Caddy or Nginx) in front for HTTPS.

## Option D: Bare Node with systemd

```ini
[Unit]
Description=RingBack
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ringback
Environment=HOST=0.0.0.0
Environment=PORT=8080
Environment=RINGBACK_DATA_DIR=/var/lib/ringback
Environment=RB_ADMIN_EMAIL=you@example.com
Environment=RB_ADMIN_PASSWORD=your-long-password
Environment=RB_SECURE_COOKIES=1
ExecStart=/usr/bin/node server.js
Restart=always
User=ringback

[Install]
WantedBy=multi-user.target
```

---

## After deploying

1. Open `/health` and confirm `storage.engine` is `sqlite`.
2. Open `/login` and sign in with your admin credentials.
3. Send a test lead and confirm it appears on `/dashboard`:
   ```bash
   curl -X POST https://your-domain/api/missed-call \
     -H 'Content-Type: application/json' \
     -d '{"from":"+15125550198","name":"Smoke Test"}'
   ```
4. Point Twilio SMS inbound at `/api/twilio/sms` and missed-call / no-answer status at `/api/twilio/voice`. JSON webhooks can still use `/api/missed-call` and `/api/leads`.
5. Open `/health` and confirm `billing.ready` and `smsStatus` match what you configured. `/pay/success` must not say the shop is paid.
6. Back up `ringback.db` on a schedule. With SQLite, copying the file (plus `-wal`) is a valid backup.

## Data and privacy

Lead records contain a name, phone number, message, and reply. Do not log message bodies, and set a retention policy before you have real customers. The database file is the only place this data lives.
