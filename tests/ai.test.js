import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDraft, aiReady, aiStatus, polishOwnerScript } from "../lib/ai.js";
import { coachLead, coachQueue, polishCoachItem, COACH_VERSION } from "../lib/coach.js";

const BIZ = {
  name: "Acme Plumbing",
  trade: "plumbing",
  bookingUrl: "https://cal.com/acme/visit",
  offer: "free estimates",
};

test("aiReady is false without USER_LLM_* env", () => {
  const saved = { ...process.env };
  delete process.env.USER_LLM_API_KEY;
  delete process.env.USER_LLM_BASE_URL;
  assert.equal(aiReady(), false);
  assert.equal(aiStatus().ready, false);
  Object.assign(process.env, saved);
});

test("validateDraft rejects empty output", () => {
  const r = validateDraft("   ", BIZ);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty");
});

test("validateDraft rejects overly long output", () => {
  const r = validateDraft("x".repeat(900), BIZ);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "too_long");
});

test("validateDraft blocks invented dollar amounts", () => {
  const r = validateDraft("Sure, that job is $450 plus parts.", BIZ);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invented_price");
});

test("validateDraft allows amounts the business itself published", () => {
  const biz = { ...BIZ, offer: "spring special $79 tune-up" };
  const r = validateDraft("Yes, we have a spring special $79 tune-up available this week.", biz);
  assert.equal(r.ok, true);
});

test("validateDraft warns when the booking link is missing", () => {
  const r = validateDraft("We can come out tomorrow to take a look.", BIZ);
  assert.equal(r.ok, true);
  assert.equal(r.warning, "missing_booking_link");
});

test("validateDraft passes a good reply containing the booking link", () => {
  const r = validateDraft("Happy to help. Book here: https://cal.com/acme/visit", BIZ);
  assert.equal(r.ok, true);
  assert.equal(r.warning, undefined);
});

test("polishOwnerScript is a no-op without USER_LLM_*", async () => {
  const saved = { ...process.env };
  delete process.env.USER_LLM_API_KEY;
  delete process.env.USER_LLM_BASE_URL;
  const r = await polishOwnerScript({ text: "Call them back about the AC.", business: BIZ });
  assert.equal(r.used, false);
  assert.equal(r.reason, "not_configured");
  assert.equal(r.text, "Call them back about the AC.");
  Object.assign(process.env, saved);
});

const HVAC = { name: "Northwind Heating & Air", trade: "HVAC", bookingUrl: "https://cal.com/northwind/service-call" };

test("coach ranks an urgent missed call as now and writes a call script", () => {
  const item = coachLead({
    lead: {
      id: "lead_1",
      name: "Alex Rivera",
      phone: "+15125550198",
      status: "new",
      urgent: true,
      source: "missed_call",
      message: "AC is out, house is 90 degrees",
      qualification: { service: "AC repair", area: "Austin" },
      score: { bucket: "hot", score: 90, reasons: ["urgent language"] },
    },
    business: HVAC,
  });
  assert.equal(item.priority, "now");
  assert.equal(item.kind, "call");
  assert.equal(item.version, COACH_VERSION);
  assert.match(item.script.call, /Alex/);
  assert.match(item.script.call, /Northwind/);
  assert.doesNotMatch(item.script.call, /\$\d/);
  assert.doesNotMatch(item.script.sms, /\$\d/);
});

test("coach asks for the missing address instead of inventing one", () => {
  const item = coachLead({
    lead: {
      id: "lead_2",
      name: "Sam",
      phone: "+15125550111",
      status: "engaged",
      qualification: { service: "furnace repair" },
      score: { bucket: "warm", score: 40 },
    },
    business: HVAC,
  });
  assert.ok(item.missing.includes("address"));
  assert.match(item.script.sms, /address/i);
  assert.doesNotMatch(item.script.sms, /\$\d/);
});

test("coach skips won leads and ranks booked below urgent", () => {
  const queue = coachQueue({
    leads: [
      { id: "won", name: "Done", status: "won", qualification: { service: "AC" } },
      { id: "booked", name: "Pat", phone: "+1", status: "booked", qualification: { service: "tune-up", area: "Austin", timing: "Tue" }, score: { bucket: "warm" } },
      { id: "hot", name: "Alex", phone: "+1", status: "new", urgent: true, source: "missed_call", qualification: { service: "no AC", area: "Austin" }, score: { bucket: "hot" } },
    ],
    business: HVAC,
  });
  assert.equal(queue.length, 2);
  assert.equal(queue[0].leadId, "hot");
  assert.equal(queue[0].priority, "now");
  assert.equal(queue[1].leadId, "booked");
  assert.equal(queue[1].kind, "confirm");
});

test("follow-up tasks surface booked jobs and due SMS without inventing prices", async () => {
  const { followUpTasks, salesReport } = await import("../lib/tasks.js");
  const tasks = followUpTasks({
    leads: [
      { id: "lead_b", name: "Pat", phone: "+15125550100", status: "booked" },
      { id: "lead_u", name: "Alex", phone: "+15125550101", status: "new", urgent: true, qualification: { service: "AC repair" } },
    ],
    getFollowUps: (lead) => lead.id === "lead_u"
      ? [{ id: "job_1", status: "pending", step: 1, runAt: "2000-01-01T00:00:00.000Z", text: "Still need help with AC repair? Reply YES." }]
      : [],
  });
  assert.ok(tasks.some((t) => t.kind === "mark_won" && t.leadId === "lead_b"));
  assert.ok(tasks.some((t) => t.kind === "follow_up" && !/\$\d/.test(t.text)));
  const report = salesReport({ stats: { verifiedRevenue: 0, estimatedRevenue: 450, recovered: 450, planCost: 199, estimatedRoi: 2.3, verifiedRoi: 0, total: 2, byStatus: { booked: 1, won: 0 }, missedCallsHandled: 1 }, payments: [] });
  assert.equal(report.scoreboard.payingShops, 0);
  assert.ok(report.blockers.some((b) => /No payment recorded/.test(b)));
  assert.doesNotMatch(JSON.stringify(report), /\$\d{2,}/);
});

test("polishCoachItem stays deterministic without a key", async () => {
  const item = coachLead({
    lead: { id: "lead_3", name: "Jo", status: "qualified", qualification: { service: "AC repair", area: "Austin", timing: "today" }, phone: "+1" },
    business: HVAC,
  });
  const polished = await polishCoachItem(item, HVAC);
  assert.equal(polished.engine, "deterministic");
  assert.equal(polished.polish.used, false);
  assert.equal(polished.script.sms, item.script.sms);
});
