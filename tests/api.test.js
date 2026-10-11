import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 4200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(tmpdir(), `ringback-api-${Date.now()}.db`);

let child;

async function waitForHealth(base, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return true;
    } catch {
      // keep waiting
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not become healthy");
}

function spawnEnv(extra = {}) {
  return {
    ...process.env,
    RB_PAYMENT_LINK: "",
    RB_PAYPAL_ME: "",
    RB_RAZORPAY_LINK: "",
    RB_STRIPE_LINK: "",
    RB_PAYMENT_LINK_STARTER: "",
    RB_PAYMENT_LINK_PROFESSIONAL: "",
    RB_PAYMENT_LINK_BUSINESS: "",
    RB_BILLING_MODE: "",
    ADMIN_TOKEN: "",
    RINGBACK_OUTREACH_CSV: join(tmpdir(), `rb-api-outreach-${Date.now()}.csv`),
    ...extra,
  };
}

before(async () => {
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: spawnEnv({ PORT: String(PORT), RINGBACK_DB: DB }),
    stdio: "ignore",
  });
  await waitForHealth(BASE);
});

after(() => {
  if (child && !child.killed) child.kill("SIGTERM");
});

async function post(path, body, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    body: JSON.stringify(body),
    ...init,
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json, headers: r.headers };
}

test("twilio connect is honest when unconfigured", async () => {
  const d = await (await fetch(`${BASE}/api/connect/twilio`)).json();
  assert.equal(d.ok, true);
  assert.equal(d.ready, false);
  assert.equal(d.mode, "simulated");
  assert.equal(d.webhooks.smsPath, "/api/twilio/sms");
  assert.equal(d.webhooks.voicePath, "/api/twilio/voice");
  assert.ok(Array.isArray(d.next) && d.next.length >= 3);
});

test("connect number never claims the carrier was flipped", async () => {
  const empty = await (await fetch(`${BASE}/api/connect/number`)).json();
  assert.equal(empty.ok, true);
  assert.equal(empty.connected, false);
  assert.ok(empty.missing.includes("twilio"));
  assert.equal(empty.guide.flippedByRingBack, false);
  assert.ok(Array.isArray(empty.carriers) && empty.carriers.length >= 4);

  const saved = await post("/api/connect/number", {
    businessId: "shop-num",
    shopPhone: "+15125550142",
    ownerPhone: "+15125550199",
    carrier: "verizon",
    forwarded: true,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.saved.shopPhone, "+15125550142");
  assert.equal(saved.json.saved.forwarded, true);
  assert.equal(saved.json.connected, false);
  assert.ok(saved.json.missing.includes("twilio"));
  assert.ok(saved.json.guide.steps.some((s) => /unanswered and busy/i.test(s)));

  const reread = await (await fetch(`${BASE}/api/connect/number?businessId=shop-num`)).json();
  assert.equal(reread.saved.ownerPhone, "+15125550199");
  assert.equal(reread.forwarded, true);
});

test("after-hours missed call pings the owner without claiming a sent text", async () => {
  await post("/api/settings", {
    businessId: "night-hvac",
    hours: "Mon-Sat, 7am-7pm",
    notifications: { phone: "+15125550111" },
  });
  const created = await post("/api/missed-call", {
    businessId: "night-hvac",
    from: "+15125550122",
    name: "No Cool Night",
    message: "AC out at 11pm, hot",
    at: "2026-09-21T23:00:00",
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.lead.afterHours, true);
  assert.equal(created.json.hours.afterHours, true);
  const ping = created.json.ownerPing;
  assert.ok(ping);
  assert.equal(ping.target, "+15125550111");
  assert.equal(ping.sent, false);
  assert.equal(ping.simulated, true);
  assert.equal(ping.reason, "twilio_not_configured");
  assert.ok(created.json.events.includes("owner_ping"));
  const note = created.json.notification;
  assert.ok(note);
  assert.equal(note.kind, "after_hours");
});

test("outreach saves a typed shop and returns a draft without sending", async () => {
  const { status, json } = await post("/api/outreach", {
    business: "Test HVAC Co",
    owner_name: "Alex",
    city: "Austin",
    email: "alex@test-hvac.example",
    phone: "5125550199",
  });
  assert.equal(status, 201);
  assert.equal(json.ok, true);
  assert.equal(json.sent, false);
  assert.equal(json.draft.sent, false);
  assert.match(json.draft.body, /Test HVAC Co|Alex/);
  const list = await (await fetch(`${BASE}/api/outreach`)).json();
  assert.ok(list.count >= 1);
});

test("demo seed is labeled and does not count as verified dollars", async () => {
  const seeded = await post("/api/demo/seed", {});
  assert.equal(seeded.status, 201);
  assert.equal(seeded.json.demo, true);
  assert.match(seeded.json.note || "", /not count as verified/i);
  const d = await (await fetch(`${BASE}/api/leads`)).json();
  assert.equal(d.stats.demoRevenue >= 680, true);
  assert.equal(d.stats.verifiedRevenue, 0);
  const demoLead = (d.leads || []).find((l) => l.businessId === "demo-plumbing" && l.status === "won");
  assert.ok(demoLead);
  assert.equal(demoLead.demo, true);
});

test("marking a lead won without an invoice is refused", async () => {
  const created = await post("/api/message", { name: "No Invoice", phone: "+15125550133", message: "Need AC repair" });
  const id = created.json.lead.id;
  const bad = await post(`/api/leads/${id}/revenue`, { status: "won" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "invoice_amount_required");
  const zero = await post(`/api/leads/${id}/revenue`, { status: "won", amount: 0 });
  assert.equal(zero.status, 400);
  const ok = await post(`/api/leads/${id}/revenue`, { status: "won", amount: 725 });
  assert.equal(ok.status, 201);
  const d = await (await fetch(`${BASE}/api/leads/${id}`)).json();
  assert.equal(d.lead.confirmedRevenue, 725);
  const stats = await (await fetch(`${BASE}/api/report`)).json();
  assert.ok(stats.headline.verifiedRevenue >= 725);
});

test("health reports sms, ai, billing, auth, and storage", async () => {
  const r = await fetch(`${BASE}/health`);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(typeof d.sms, "boolean");
  assert.equal(typeof d.ai.ready, "boolean");
  assert.equal(typeof d.billing.ready, "boolean");
  assert.equal(d.billing.mode, "not_configured");
  assert.equal(d.smsStatus.mode, "simulated");
  assert.equal(typeof d.auth.enforced, "boolean");
  assert.equal(d.storage.engine, "sqlite");
});

test("channels catalog is exposed", async () => {
  const d = await (await fetch(`${BASE}/api/channels`)).json();
  assert.ok(d.channels.length >= 8);
  assert.ok(d.channels.some((c) => c.id === "whatsapp"));
  assert.ok(d.statuses.includes("new"));
  assert.ok(d.statuses.includes("booked"));
  assert.ok(d.statuses.includes("won"));
  assert.ok(Array.isArray(d.trades));
});

test("plans endpoint exposes three priced plans", async () => {
  const d = await (await fetch(`${BASE}/api/plans`)).json();
  assert.equal(d.plans.length, 3);
  assert.equal(d.plans.find((p) => p.id === "professional").price, 199);
  assert.equal(typeof d.billing.ready, "boolean");
});

test("billing status is honest when unconfigured", async () => {
  const d = await (await fetch(`${BASE}/api/billing/status`)).json();
  assert.equal(d.ready, false);
  assert.deepEqual(d.providers, []);
});

test("checkout refuses to invent a payment URL", async () => {
  const d = await (await fetch(`${BASE}/api/billing/checkout?plan=professional`)).json();
  assert.equal(d.ok, false);
  assert.equal(d.reason, "not_configured");
  assert.ok(d.fallback.email);
});

test("pay return pages never claim the shop is paid", async () => {
  const success = await fetch(`${BASE}/pay/success`);
  assert.equal(success.status, 200);
  assert.match(await success.text(), /does not confirm/);
  const cancel = await fetch(`${BASE}/pay/cancel`);
  assert.equal(cancel.status, 200);
  assert.match(await cancel.text(), /No payment was recorded/);
  const json = await (await fetch(`${BASE}/pay/success`, { headers: { Accept: "application/json" } })).json();
  assert.equal(json.paid, false);
});

test("twilio inbound SMS continues an open lead by phone", async () => {
  const first = await post("/api/missed-call", {
    from: "+15125550911",
    name: "Twilio Loop",
    message: "AC is out",
  });
  assert.equal(first.status, 201);
  const reply = await post("/api/twilio/sms", {
    From: "+15125550911",
    Body: "1200 Barton Springs, tonight",
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.json.lead.id, first.json.lead.id);
  assert.equal(reply.json.created, false);
});

test("twilio inbound SMS without a prior lead creates one", async () => {
  const r = await post("/api/twilio/sms", { From: "+15125550912", Body: "Need heat today" });
  assert.equal(r.status, 201);
  assert.equal(r.json.lead.channel, "sms");
  assert.equal(r.json.delivery.simulated, true);
});

test("duplicate Twilio MessageSid is idempotent", async () => {
  const first = await post("/api/twilio/sms", { From: "+15125550913", Body: "Need AC", MessageSid: "SMidempotent1" });
  assert.equal(first.status, 201);
  const second = await post("/api/twilio/sms", { From: "+15125550913", Body: "Need AC", MessageSid: "SMidempotent1" });
  assert.equal(second.status, 200);
  assert.equal(second.json.lead.id, first.json.lead.id);
  assert.equal(second.json.delivery.reason, "duplicate_webhook");
});

test("onboarding and entitlements are exposed", async () => {
  const onboarding = await (await fetch(`${BASE}/api/onboarding?businessId=demo`)).json();
  assert.equal(onboarding.ok, true);
  assert.ok(["setup_requested", "configuration_in_progress", "ready_for_testing", "live"].includes(onboarding.onboarding.state));
  assert.equal(onboarding.onboarding.live, false);
  const entitlements = await (await fetch(`${BASE}/api/entitlements?businessId=demo`)).json();
  assert.equal(entitlements.ok, true);
  assert.equal(entitlements.limits.smsPerMonth, 500);
  const activate = await post("/api/onboarding/activate", { businessId: "demo" });
  assert.equal(activate.status, 400);
  assert.equal(activate.json.error, "not_ready");
});

test("account export requires businessId and stays tenant-scoped", async () => {
  const created = await post("/api/message", { businessId: "shop-api-export", name: "Ex", phone: "+15125550916", message: "Need AC" });
  assert.equal(created.status, 201);
  const missing = await fetch(`${BASE}/api/account/export`);
  assert.equal(missing.status, 400);
  const r = await fetch(`${BASE}/api/account/export?businessId=shop-api-export`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition") || "", /attachment/);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.businessId, "shop-api-export");
  assert.ok((body.leads || []).some((l) => l.id === created.json.lead.id));
});

test("test missed-call recovery is simulated and not verified revenue", async () => {
  const r = await post("/api/onboarding/test", { businessId: "shop-api-test", phone: "+15555550100", name: "Test caller" });
  assert.equal(r.status, 201);
  assert.equal(r.json.test, true);
  assert.equal(r.json.simulated, true);
  assert.equal(r.json.delivery.simulated, true);
  assert.notEqual(r.json.delivery.status, "sent");
  assert.match(r.json.note || "", /not a live text/i);
  assert.equal(r.json.lead.confirmedRevenue == null || r.json.lead.confirmedRevenue === 0, true);
});

test("Twilio status callback is a receipt and does not create a lead", async () => {
  const before = await (await fetch(`${BASE}/api/leads`)).json();
  const receipt = await post("/api/twilio/sms", { MessageSid: "SMunmatched1", MessageStatus: "delivered" });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.json.receipt, true);
  assert.equal(receipt.json.status, "delivered");
  assert.equal(receipt.json.matched, false);
  const failed = await post("/api/twilio/sms", { SmsSid: "SMunmatched2", SmsStatus: "undelivered", ErrorCode: "30003" });
  assert.equal(failed.status, 200);
  assert.equal(failed.json.status, "undelivered");
  const after = await (await fetch(`${BASE}/api/leads`)).json();
  assert.equal(after.leads.length, before.leads.length);
});

test("won revenue stores invoiceRef", async () => {
  const created = await post("/api/message", { name: "Invoice Ref", phone: "+15125550918", message: "Need AC repair" });
  const id = created.json.lead.id;
  const ok = await post(`/api/leads/${id}/revenue`, { status: "won", amount: 810, invoiceRef: "INV-810" });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.invoiceRef, "INV-810");
  assert.equal(ok.json.lead.invoiceRef, "INV-810");
  assert.equal(ok.json.revenue.invoiceRef, "INV-810");
});

test("settings persist quiet hours and timeZone", async () => {
  const saved = await post("/api/settings", {
    businessId: "shop-quiet",
    timeZone: "America/Chicago",
    quietHours: { enabled: true, startMin: 22 * 60, endMin: 7 * 60 },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.business.timeZone, "America/Chicago");
  assert.equal(saved.json.business.quietHours.startMin, 22 * 60);
  const d = await (await fetch(`${BASE}/api/settings?businessId=shop-quiet`)).json();
  assert.equal(d.quietHours.startClock, "22:00");
  assert.equal(d.quietHours.endClock, "07:00");
  assert.equal(d.timeZone, "America/Chicago");
});

test("account deletion requires confirm and protects demo", async () => {
  const created = await post("/api/message", { businessId: "shop-api-del", name: "Del", phone: "+15125550914", message: "Need AC" });
  assert.equal(created.status, 201);
  const missing = await fetch(`${BASE}/api/account`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: "shop-api-del" }),
  });
  assert.equal(missing.status, 400);
  const demo = await fetch(`${BASE}/api/account`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: "demo", confirm: "DELETE" }),
  });
  assert.equal(demo.status, 403);
  const ok = await fetch(`${BASE}/api/account`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId: "shop-api-del", confirm: "DELETE" }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.leadsDeleted >= 1, true);
});

test("value endpoint returns the framing math", async () => {
  const d = await (await fetch(`${BASE}/api/value?missedCallsPerWeek=20&jobValue=600`)).json();
  assert.equal(d.ok, true);
  assert.equal(d.inputs.missedCallsPerWeek, 20);
  assert.equal(d.inputs.jobValue, 600);
  assert.ok(d.value.recoveredPerMonth > 0);
});

test("value endpoint treats closeRate as a percentage when given a whole number", async () => {
  const asPercent = await (await fetch(`${BASE}/api/value?missedCallsPerWeek=20&jobValue=600&closeRate=30`)).json();
  const asFraction = await (await fetch(`${BASE}/api/value?missedCallsPerWeek=20&jobValue=600&closeRate=0.3`)).json();
  assert.equal(asPercent.inputs.closeRate, 0.3);
  assert.equal(asPercent.value.recoveredPerMonth, asFraction.value.recoveredPerMonth);
  // A whole-number rate must not be multiplied by 30.
  assert.ok(asPercent.value.recoveredPerMonth < 20 * 4.33 * 600, "recovered must stay below the total pipeline");
});

test("value endpoint defaults the plan cost to the Starter price", async () => {
  const d = await (await fetch(`${BASE}/api/value?missedCallsPerWeek=20&jobValue=600`)).json();
  assert.equal(d.value.planCost, 99);
  const pro = await (await fetch(`${BASE}/api/value?missedCallsPerWeek=20&jobValue=600&plan=professional`)).json();
  assert.equal(pro.value.planCost, 199);
});

test("landing, dashboard, and login render", async () => {
  for (const [path, marker] of [["/", /RingBack/], ["/dashboard", /Lead CRM/], ["/login", /Sign in/]]) {
    const r = await fetch(`${BASE}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(await r.text(), marker, path);
  }
});

test("unknown path returns 404", async () => {
  assert.equal((await fetch(`${BASE}/nope-not-here`)).status, 404);
});

test("demo endpoint never persists and classifies intent", async () => {
  const { status, json } = await post("/api/demo", { message: "how much to fix my AC, urgent", channel: "sms" });
  assert.equal(status, 200);
  assert.ok(["price", "repair"].includes(json.intent));
  assert.equal(json.urgent, true);
  assert.equal(json.followUp.length, 3);
  assert.ok(json.ownerSnapshot);
  assert.equal(json.ownerSnapshot.urgency, "hot");
  assert.equal(json.ownerSnapshot.severity, "urgent");
});

test("demo snapshot location is Austin not a sentence fragment", async () => {
  const { status, json } = await post("/api/demo", {
    message: "I'm in Austin. Can somebody come tonight?",
    channel: "sms",
    biz: "HVAC",
    ai: "false",
  });
  assert.equal(status, 200);
  assert.ok(json.ownerSnapshot);
  const loc = json.ownerSnapshot.location || "";
  assert.match(loc, /Austin/i);
  assert.doesNotMatch(loc, /somebody|Can somebody/i);
  assert.equal(json.ownerSnapshot.severity, "urgent");
  assert.notEqual(json.ownerSnapshot.bookingState, "confirmed");
});

test("value endpoint returns a model disclaimer", async () => {
  const d = await (await fetch(`${BASE}/api/value?missedCallsPerWeek=12&jobValue=450&recoveryRate=30`)).json();
  assert.equal(d.ok, true);
  assert.match(d.disclaimer, /model/i);
});

test("analytics accepts funnel events and rejects unknown types", async () => {
  const ok = await post("/api/analytics", { type: "page_view", path: "/", label: "home" });
  assert.equal(ok.status, 201);
  const bad = await post("/api/analytics", { type: "not_a_real_event" });
  assert.equal(bad.status, 400);
});

test("hvac landing renders", async () => {
  const r = await fetch(`${BASE}/hvac`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /HVAC/);
});

test("referral requires business and email", async () => {
  assert.equal((await post("/api/referral", { business: "X" })).status, 400);
  const { status, json } = await post("/api/referral", { business: "ABC HVAC", email: "owner@abc.test", name: "Sam" });
  assert.equal(status, 201);
  assert.ok(json.referral.id);
});

test("whatsapp webhook records a whatsapp lead", async () => {
  const { status, json } = await post("/api/whatsapp", {
    name: "Priya",
    phone: "+15125550111",
    message: "Can you send a quote on WhatsApp?",
  });
  assert.equal(status, 201);
  assert.equal(json.lead.channel, "whatsapp");
  assert.equal(json.lead.channelLabel, "WhatsApp");
  assert.ok(json.lead.id.startsWith("lead_"));
});

test("every channel route tags the lead with its own source", async () => {
  const routes = {
    "/api/missed-call": "missed_call",
    "/api/facebook": "facebook",
    "/api/instagram": "instagram",
    "/api/webchat": "webchat",
    "/api/google-ads": "google_ads",
  };
  for (const [path, source] of Object.entries(routes)) {
    const { status, json } = await post(path, { name: "T", message: "hello there" });
    assert.equal(status, 201, path);
    assert.equal(json.lead.source, source, path);
  }
});

test("unified message endpoint honors the channel field", async () => {
  const { status, json } = await post("/api/message", {
    name: "Sam",
    message: "Do you serve Round Rock?",
    channel: "facebook",
  });
  assert.equal(status, 201);
  assert.equal(json.lead.channel, "facebook");
  assert.equal(json.lead.intent, "service_area");
});

test("multi-turn history changes the reply", async () => {
  const first = await post("/api/demo", { message: "how much", channel: "sms" });
  const later = await post("/api/demo", {
    message: "AC repair in Austin tomorrow",
    channel: "sms",
    history: [{ role: "in", text: "how much" }, { role: "out", text: "what do you need" }],
  });
  assert.ok(first.json.reply.length > 10);
  assert.equal(first.json.followUp.length, 3);
  assert.notEqual(first.json.reply, later.json.reply);
});

test("missing lead fields are rejected", async () => {
  assert.equal((await post("/api/leads", {})).status, 400);
});

test("leads persist and are listed", async () => {
  await post("/api/missed-call", { from: "+15125550199", name: "Dana" });
  const d = await (await fetch(`${BASE}/api/leads`)).json();
  assert.ok(d.leads.length >= 1);
  assert.ok(d.leads.some((l) => l.source === "missed_call"));
  assert.ok(d.leads[0].reply.length > 10);
});

test("a lead can be moved to booked with a job value and notes", async () => {
  const created = await post("/api/message", { name: "Jo", message: "book me", channel: "sms" });
  const id = created.json.lead.id;
  const r = await fetch(`${BASE}/api/leads/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "booked", jobValue: 720, notes: "Booked Tue 2pm" }),
  });
  const d = await r.json();
  assert.equal(d.lead.status, "booked");
  assert.equal(d.lead.jobValue, 720);
  assert.equal(d.lead.notes, "Booked Tue 2pm");
});

test("updating a missing lead returns 404", async () => {
  const r = await fetch(`${BASE}/api/leads/lead_missing`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "booked" }),
  });
  assert.equal(r.status, 404);
});

test("coach queue ranks open recoveries without inventing prices", async () => {
  await post("/api/missed-call", { from: "+15125550901", name: "Casey", message: "AC is out, emergency, no cool air" });
  const d = await (await fetch(`${BASE}/api/coach`)).json();
  assert.equal(d.ok, true);
  assert.ok(Array.isArray(d.items));
  assert.ok(d.items.length >= 1);
  const top = d.items[0];
  assert.ok(["now", "today", "soon"].includes(top.priority));
  assert.ok(top.script.call);
  assert.ok(top.script.sms);
  assert.doesNotMatch(top.script.call, /\$\d/);
  assert.doesNotMatch(top.script.sms, /\$\d/);
  assert.equal(d.polished, false);
});

test("lead GET includes coach scripts", async () => {
  const created = await post("/api/message", { name: "Riley", phone: "+15125550902", message: "Need furnace repair on Oak St tomorrow", channel: "sms" });
  const id = created.json.lead.id;
  const d = await (await fetch(`${BASE}/api/leads/${id}`)).json();
  assert.equal(d.ok, true);
  assert.ok(d.coach);
  assert.equal(d.coach.leadId, id);
  assert.ok(d.coach.script.sms.length > 8);
  assert.doesNotMatch(d.coach.script.sms, /\$\d/);
});

test("report summarizes the pipeline, rates, and recovered revenue", async () => {
  const d = await (await fetch(`${BASE}/api/report`)).json();
  assert.equal(d.ok, true);
  assert.ok(d.headline.leadsCaptured >= 1);
  assert.ok(d.headline.booked >= 1);
  assert.ok(d.headline.estimatedRevenue >= 720);
  assert.equal(typeof d.rates.replyRate, "number");
  assert.ok(d.byChannel.missed_call >= 1);
});

test("tasks and sales report endpoints are honest", async () => {
  const tasks = await (await fetch(`${BASE}/api/tasks`)).json();
  assert.equal(tasks.ok, true);
  assert.ok(Array.isArray(tasks.tasks));
  const report = await (await fetch(`${BASE}/api/report`)).json();
  assert.ok(report.sales);
  assert.equal(typeof report.sales.scoreboard.verifiedRevenue, "number");
  assert.ok(Array.isArray(report.sales.blockers));
  const txt = await fetch(`${BASE}/api/report.txt`);
  assert.equal(txt.status, 200);
  const body = await txt.text();
  assert.match(body, /Verified recovered/);
  assert.match(body, /Paying shops recorded/);
});

test("report exposes a dense 14-day window ending today", async () => {
  const d = await (await fetch(`${BASE}/api/report`)).json();
  assert.ok(Array.isArray(d.last14Days), "last14Days must be an array");
  assert.equal(d.last14Days.length, 14);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(d.last14Days[13].date, today, "the last point must be today");
  const dates = d.last14Days.map((p) => p.date);
  for (const date of dates) assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted, "dates must be ascending");
  for (const p of d.last14Days) assert.equal(typeof p.count, "number");
});

test("CSV export returns a downloadable file", async () => {
  const r = await fetch(`${BASE}/api/leads/export`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/csv/);
  assert.match(r.headers.get("content-disposition") || "", /attachment/);
  assert.match((await r.text()).split("\n")[0], /^id,createdAt,status/);
});

test("setup requests are captured and can be advanced", async () => {
  const { status, json } = await post("/api/setup", {
    business: "Test Roofing",
    email: "owner@testroofing.com",
    trade: "Roofing",
    plan: "Professional",
    channels: ["missed_call", "facebook"],
  });
  assert.equal(status, 201);
  assert.ok(json.setup.id.startsWith("setup_"));

  const patched = await fetch(`${BASE}/api/setups/${json.setup.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "contacted" }),
  });
  const pd = await patched.json();
  assert.equal(pd.setup.status, "contacted");

  const list = await (await fetch(`${BASE}/api/setups`)).json();
  assert.ok(list.setups.some((s) => s.business === "Test Roofing"));
});

test("setup requires business and email", async () => {
  assert.equal((await post("/api/setup", { name: "no email" })).status, 400);
});

test("payments can be recorded and are listed", async () => {
  const created = await post("/api/payments", {
    amount: 199,
    plan: "professional",
    provider: "manual",
    reference: "txn_123",
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.payment.amount, 199);
  assert.equal(created.json.payment.plan, "professional");

  const list = await (await fetch(`${BASE}/api/payments`)).json();
  assert.ok(list.payments.some((p) => p.reference === "txn_123"));
});

test("payments reject a non-positive amount", async () => {
  assert.equal((await post("/api/payments", { amount: -5 })).status, 400);
  assert.equal((await post("/api/payments", { amount: "abc" })).status, 400);
});

test("recording a payment against a setup marks it paid", async () => {
  const s = await post("/api/setup", { business: "Paid Co", email: "pay@co.com", plan: "Starter" });
  await post("/api/payments", { amount: 99, plan: "starter", setupId: s.json.setup.id });
  const list = await (await fetch(`${BASE}/api/setups`)).json();
  const found = list.setups.find((x) => x.id === s.json.setup.id);
  assert.equal(found.status, "paid");
});

test("auth is reported as open when no user exists", async () => {
  const d = await (await fetch(`${BASE}/api/auth/me`)).json();
  assert.equal(d.authenticated, false);
  assert.equal(d.auth.enforced, false);
});

// ---------------------------------------------------------------- enforced auth

test("with an admin configured, the CRM requires a session and login works", async () => {
  const port2 = PORT + 500;
  const base2 = `http://127.0.0.1:${port2}`;
  const db2 = join(tmpdir(), `ringback-auth-api-${Date.now()}.db`);
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: spawnEnv({
      PORT: String(port2),
      RINGBACK_DB: db2,
      RB_ADMIN_EMAIL: "owner@ringback.test",
      RB_ADMIN_PASSWORD: "supersecret123",
    }),
    stdio: "ignore",
  });

  try {
    await waitForHealth(base2);

    const health = await (await fetch(`${base2}/health`)).json();
    assert.equal(health.auth.enforced, true);
    assert.equal(health.auth.users, 1);

    // Unauthenticated API access is refused with JSON.
    const denied = await fetch(`${base2}/api/leads`, { headers: { Accept: "application/json" } });
    assert.equal(denied.status, 401);

    // Unauthenticated dashboard access redirects to the login page.
    const page = await fetch(`${base2}/dashboard`, { redirect: "manual" });
    assert.equal(page.status, 302);
    assert.match(page.headers.get("location") || "", /\/login/);

    // Wrong password fails.
    const badRes = await fetch(`${base2}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@ringback.test", password: "wrong" }),
    });
    assert.equal(badRes.status, 401);

    // Correct password sets a session cookie.
    const okRes = await fetch(`${base2}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@ringback.test", password: "supersecret123" }),
    });
    assert.equal(okRes.status, 200);
    const cookie = okRes.headers.get("set-cookie") || "";
    assert.match(cookie, /rb_session=/);
    assert.match(cookie, /HttpOnly/);

    // The cookie grants access to the CRM.
    const authed = await fetch(`${base2}/api/leads`, { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(authed.status, 200);
    const authedBody = await authed.json();
    assert.ok(Array.isArray(authedBody.leads));

    // Public webhooks still work without a session.
    const hook = await fetch(`${base2}/api/missed-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "+15125550000", name: "Public" }),
    });
    assert.equal(hook.status, 201);

    // Logging out revokes access.
    const logoutRes = await fetch(`${base2}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: cookie.split(";")[0] },
    });
    assert.equal(logoutRes.status, 200);
    const afterLogout = await fetch(`${base2}/api/leads`, {
      headers: { cookie: cookie.split(";")[0], Accept: "application/json" },
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    if (proc && !proc.killed) proc.kill("SIGTERM");
  }
});
