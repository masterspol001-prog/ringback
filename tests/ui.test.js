// Static UI checks. No browser required: these catch the most common
// front-end breakage — JavaScript referencing a DOM id that does not exist,
// or an element id being duplicated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");

function read(name) {
  return readFileSync(join(PUBLIC, name), "utf8");
}

function idsIn(html) {
  const ids = [];
  const re = /\sid="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) ids.push(m[1]);
  return ids;
}

// Finds $("foo"), document.getElementById("foo"), and querySelector("#foo").
function referencedIds(script) {
  const refs = new Set();
  for (const m of script.matchAll(/\$\("([^"]+)"\)/g)) refs.add(m[1]);
  for (const m of script.matchAll(/getElementById\("([^"]+)"\)/g)) refs.add(m[1]);
  for (const m of script.matchAll(/querySelector\("#([^"]+)"\)/g)) refs.add(m[1]);
  for (const m of script.matchAll(/querySelectorAll?\("\.([a-zA-Z0-9_-]+)/g)) refs.add(`.${m[1]}`);
  return [...refs];
}

function scripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
}

  for (const page of ["index.html", "dashboard.html", "login.html", "hvac.html", "pay-success.html", "pay-cancel.html"]) {
  test(`${page}: no duplicate element ids`, () => {
    const ids = idsIn(read(page));
    const seen = new Set();
    const dupes = [];
    for (const id of ids) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(", ")}`);
  });

  test(`${page}: every referenced element id exists`, () => {
    const html = read(page);
    const present = new Set(idsIn(html));
    const missing = referencedIds(scripts(html)).filter(
      (id) => !id.startsWith(".") && !present.has(id)
    );
    assert.deepEqual(missing, [], `JS references missing ids: ${missing.join(", ")}`);
  });

  test(`${page}: ${page} has a title and viewport meta`, () => {
    const html = read(page);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /name="viewport"/);
  });
}

test("index.html: hero CTAs match the product spec", () => {
  const html = read("index.html");
  assert.match(html, /See How Much RingBack Could Recover/);
  assert.match(html, /Get RingBack Live in 48 Hours/);
  assert.match(html, /No contract/);
  assert.match(html, /Pay after you see it working/);
  assert.match(html, /You're already paying for the leads/);
  assert.match(html, /Don't lose them when you can't respond/);
  assert.match(html, /RingBack detected/);
  assert.match(html, /Reliability over AI/);
  assert.match(html, /Not an AI receptionist/);
  assert.match(html, /Potential opportunity is not guaranteed revenue/);
  assert.match(html, /One recovered job can pay for RingBack/);
});

test("index.html: ROI calculator includes recovery rate and model disclaimer", () => {
  const html = read("index.html");
  assert.match(html, /id="recovery"/);
  assert.match(html, /Estimated recovery rate/);
  assert.match(html, /This is a model, not a guaranteed result/);
  assert.match(html, /How is this calculated/);
  assert.match(html, /id="calcWhy"/);
  assert.match(html, /id="cost"/);
  assert.match(html, /id="ownerSnapshot"/);
  assert.match(html, /Illustrative ROI/);
  assert.doesNotMatch(html, /RingBack intercepts/);
  assert.doesNotMatch(html, /Auto-reply sent in 8 seconds/);
  assert.match(html, /Demo: reply sent in 8 seconds/);
  assert.match(html, /RingBack detected the missed call/);
  assert.match(html, /Demo availability/);
  assert.doesNotMatch(html, /Saturday, Sep 19/);
});

test("hvac.html: HVAC-first landing exists without fabricated proof", () => {
  const html = read("hvac.html");
  assert.match(html, /You're already paying for the leads/);
  assert.match(html, /Don't lose the AC job when you can't respond/);
  assert.match(html, /See How Much RingBack Could Recover/);
  assert.doesNotMatch(html, /testimonial/i);
  assert.doesNotMatch(html, /guaranteed ROI/i);
});

test("dashboard.html: estimated vs verified revenue is labeled", () => {
  const html = read("dashboard.html");
  assert.match(html, /id="sEstimated"/);
  assert.match(html, /id="sVerified"/);
  assert.match(html, /Your recovery/);
  assert.match(html, /VERIFIED revenue/);
  assert.match(html, /ESTIMATED pipeline \(booked, not won\)/);
  assert.match(html, /id="funnelPanel"/);
  assert.match(html, /id="funnelChips"/);
  assert.match(html, /Verified-revenue funnel/);
  assert.match(html, /Offered and selected are not bookings/);
  assert.match(html, /id="paidPanel"/);
  assert.match(html, /id="leaksPanel"/);
  assert.match(html, /id="recoverable"/);
  assert.match(html, /id="refBtn"/);
  assert.match(html, /id="lostReasons"/);
  assert.match(html, /id="alerts"/);
  assert.match(html, /data-field="lostReason"/);
  assert.match(html, /id="twilioPanel"/);
  assert.match(html, /id="outreachPanel"/);
  assert.match(html, /id="addProspectBtn"/);
  assert.match(html, /does not scrape Google Maps/);
  assert.match(html, /not verified/);
  assert.match(html, /demo — not verified/);
  assert.match(html, /Illustrative ROI/);
  assert.match(html, /id="sResponseShow"/);
  assert.match(html, /data-owner-msg/);
  assert.match(html, /Send as owner/);
  assert.match(html, /id="killSwitchBtn"/);
  assert.match(html, /Pause all automation/);
  assert.match(html, /id="recentRecovered"/);
  assert.match(html, /id="reliabilityPanel"/);
  assert.match(html, /id="reliabilityChips"/);
  assert.match(html, /id="onboardPanel"/);
  assert.match(html, /id="onboardChips"/);
  assert.match(html, /id="entitleChips"/);
  assert.match(html, /id="activateLiveBtn"/);
  assert.match(html, /id="deleteAccountBtn"/);
  assert.match(html, /Type DELETE/);
  assert.match(html, /id="exportAccountBtn"/);
  assert.match(html, /id="testRecoveryBtn"/);
  assert.match(html, /id="usagePanel"/);
  assert.match(html, /id="usageChips"/);
  assert.match(html, /id="quietPanel"/);
  assert.match(html, /id="quietSaveBtn"/);
  assert.match(html, /id="qhTz"/);
  assert.match(html, /data-field="invoiceRef"/);
});

test("dashboard.html: takeover and return-to-AI controls exist", () => {
  const html = read("dashboard.html");
  assert.match(html, /data-takeover/);
  assert.match(html, /data-resume/);
  assert.match(html, /Return to AI/);
  assert.match(html, /data-intel/);
});

test("dashboard.html: owner coach panel is present", () => {
  const html = read("dashboard.html");
  assert.match(html, /id="coachPanel"/);
  assert.match(html, /id="coach"/);
  assert.match(html, /Do this next/);
  assert.match(html, /\/api\/coach/);
  assert.match(html, /data-coach/);
  assert.match(html, /No invented prices/);
});

test("index.html: the plan CTA buttons carry data-plan values that match real plans", () => {
  const html = read("index.html");
  const plans = [...html.matchAll(/data-plan="([^"]+)"/g)].map((m) => m[1].toLowerCase());
  assert.ok(plans.length >= 3, "expected three plan CTAs");
  for (const p of plans) {
    assert.ok(["starter", "professional", "business"].includes(p), `unknown plan CTA: ${p}`);
  }
});

test("index.html: pricing numbers match the plans module", async () => {
  const { PLANS } = await import("../lib/plans.js");
  const html = read("index.html");
  for (const plan of PLANS) {
    assert.match(html, new RegExp(`\\$${plan.price}<small>`), `missing $${plan.price} for ${plan.name}`);
  }
});

test("index.html: demo covers home services and clinics", () => {
  const html = read("index.html");
  for (const trade of ["HVAC", "Plumbing", "Electrical", "Dental clinic", "Medical clinic", "Med spa"]) {
    assert.match(html, new RegExp(`value="${trade}"`), `demo trade missing: ${trade}`);
  }
  assert.match(html, /home services, contractors, and clinics/i);
});

test("index.html: all nine channels appear in the demo selector", () => {
  const html = read("index.html");
  for (const ch of ["missed_call", "sms", "whatsapp", "facebook", "instagram", "google_ads", "webchat", "web_form", "email"]) {
    assert.match(html, new RegExp(`value="${ch}"`), `channel option missing: ${ch}`);
  }
});

test("index.html: contact and trust claims avoid fabricated social proof", () => {
  const html = read("index.html");
  // Fabricated social proof: "500+ customers", "over 200 businesses", "trusted by 1000".
  // A founding-customer limit like "first 10 customers" is a real offer, not social proof.
  assert.doesNotMatch(html, /\b\d{2,}\+\s+(happy\s+)?(customers|clients|businesses)\b/i, "fabricated social-proof count");
  assert.doesNotMatch(html, /\b(over|more than|serving)\s+\d{2,}\s+(customers|clients|businesses)\b/i, "fabricated social-proof count");
  assert.doesNotMatch(html, /trusted by\s+(over\s+)?\d/i, "fabricated trust claim");
  assert.doesNotMatch(html, /\b\d(\.\d)?\s*\/\s*5\b/, "fabricated rating");
  assert.doesNotMatch(html, /testimonial/i, "testimonials must be real before they are shown");
  assert.doesNotMatch(html, /rated\s+#?1/i, "fabricated ranking claim");
});

test("dashboard.html: has pipeline, filters, export, and payment controls", () => {
  const html = read("dashboard.html");
  for (const id of ["pipeline", "q", "fStatus", "fBucket", "fChannel", "exportBtn", "payAmount", "payPlan", "payBtn", "logoutBtn", "tasks", "salesChips", "runFollowBtn", "salesExport"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing control: ${id}`);
  }
});

test("login.html: posts to the auth endpoint and is noindex", () => {
  const html = read("login.html");
  assert.match(html, /\/api\/auth\/login/);
  assert.match(html, /noindex/);
  assert.match(html, /autocomplete="current-password"/);
});

test("pay pages never claim a successful payment", () => {
  assert.match(read("pay-success.html"), /does not confirm/);
  assert.doesNotMatch(read("pay-success.html"), /payment succeeded|you are paid|welcome to professional/i);
  assert.match(read("pay-cancel.html"), /No payment was recorded/);
});

test("no page embeds a credential or API key", () => {
for (const page of ["index.html", "dashboard.html", "login.html", "hvac.html", "pay-success.html", "pay-cancel.html"]) {
    const html = read(page);
    assert.doesNotMatch(html, /sk-[A-Za-z0-9]{16,}/, `${page} looks like it contains an API key`);
    assert.doesNotMatch(html, /MCAI_|OPENAI_API_KEY|USER_LLM_API_KEY\s*[:=]\s*["'][^"']+["']/, `${page} references a credential`);
  }
});
