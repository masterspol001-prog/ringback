import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the store on a throwaway DB before importing it.
const dbFile = join(tmpdir(), `ringback-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.RINGBACK_DB = dbFile;

const store = await import("../lib/store.js");

function sampleLead(over = {}) {
  return {
    id: store.nextId("lead"),
    businessId: "biz1",
    name: "Alex",
    phone: "+15125550198",
    message: "Need a quote for a new AC",
    source: "web_form",
    channel: "sms",
    intent: "price",
    reply: "Thanks for reaching out...",
    followUp: [],
    score: { score: 30, bucket: "warm", reasons: [] },
    status: "new",
    notes: "",
    jobValue: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

test("addLead assigns an id and defaults", () => {
  const lead = store.addLead(sampleLead({ id: store.nextId("lead") }));
  assert.ok(lead.id.startsWith("lead_"));
  assert.equal(lead.status, "new");
});

test("listLeads filters by business", () => {
  store.addLead(sampleLead({ businessId: "biz2" }));
  const b1 = store.listLeads("biz1");
  const b2 = store.listLeads("biz2");
  assert.ok(b1.length >= 1);
  assert.ok(b2.length >= 1);
  assert.ok(b1.every((l) => l.businessId === "biz1"));
});

test("updateLead changes status, notes, and job value", () => {
  const lead = store.addLead(sampleLead({}));
  const updated = store.updateLead(lead.id, { status: "booked", notes: "Called back", jobValue: 680 });
  assert.equal(updated.status, "booked");
  assert.equal(updated.notes, "Called back");
  assert.equal(updated.jobValue, 680);
  assert.ok(updated.updatedAt);
});

test("updateLead rejects unknown status but keeps other fields", () => {
  const lead = store.addLead(sampleLead({}));
  const updated = store.updateLead(lead.id, { status: "banana", notes: "kept" });
  assert.equal(updated.status, "new");
  assert.equal(updated.notes, "kept");
});

test("updateLead returns null for a missing id", () => {
  assert.equal(store.updateLead("lead_does_not_exist", { status: "booked" }), null);
});

test("findOpenLeadByPhone matches last 10 digits and skips closed leads", () => {
  const open = store.addLead(sampleLead({ phone: "+1 (512) 555-0444", businessId: "bizphone" }));
  store.addLead(sampleLead({ phone: "+15125550444", businessId: "bizphone", status: "won" }));
  const found = store.findOpenLeadByPhone("512-555-0444", "bizphone");
  assert.equal(found.id, open.id);
  store.updateLead(open.id, { status: "lost" });
  assert.equal(store.findOpenLeadByPhone("5125550444", "bizphone"), null);
});

test("updateLead clamps absurd job values", () => {
  const lead = store.addLead(sampleLead({}));
  const updated = store.updateLead(lead.id, { jobValue: 99_000_000 });
  assert.equal(updated.jobValue, 1_000_000);
});

test("stats computes pipeline, buckets, channels, and recovered revenue", () => {
  const biz = "bizstats";
  const hot = store.addLead(sampleLead({ businessId: biz, score: { score: 80, bucket: "hot", reasons: [] } }));
  store.addLead(sampleLead({ businessId: biz, score: { score: 40, bucket: "warm", reasons: [] }, source: "missed_call" }));
  store.updateLead(hot.id, { status: "booked", jobValue: 500 });

  const s = store.stats(biz);
  assert.equal(s.total, 2);
  assert.equal(s.replied, 2);
  assert.equal(s.byBucket.hot, 1);
  assert.equal(s.byBucket.warm, 1);
  assert.equal(s.byStatus.booked, 1);
  assert.equal(s.recovered, 0);
  assert.equal(s.estimatedRevenue, 500);
  assert.equal(s.verifiedRevenue, 0);
  assert.equal(s.byChannel.missed_call, 1);
});

test("stats uses the default job value when none is set", () => {
  const biz = "bizdefault";
  const lead = store.addLead(sampleLead({ businessId: biz }));
  store.updateLead(lead.id, { status: "booked" });
  assert.equal(store.stats(biz).estimatedRevenue, store.DEFAULT_JOB_VALUE);
  assert.equal(store.stats(biz).recovered, 0);
});

test("toCsv produces a header and one row per lead with escaped fields", () => {
  const biz = "bizcsv";
  store.addLead(sampleLead({ businessId: biz, name: 'A, "B"', message: "line1\nline2" }));
  const csv = store.toCsv(biz);
  const lines = csv.split("\n");
  assert.match(lines[0], /^id,createdAt,status,bucket/);
  assert.match(csv, /"A, ""B"""/);
});

test("setup records are stored and listed", () => {
  const setup = store.addSetup({ id: store.nextId("setup"), business: "Test Co", email: "a@b.com" });
  assert.ok(store.listSetups().some((s) => s.id === setup.id));
});

test("businesses round-trip through save/get", () => {
  store.saveBusiness({ id: "b1", name: "Acme", trade: "plumbing" });
  assert.equal(store.getBusiness("b1").name, "Acme");
  assert.equal(store.getBusiness("nope"), null);
});
