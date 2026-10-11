import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";

process.env.RINGBACK_OUTREACH_CSV = join(tmpdir(), `rb-outreach-${Date.now()}.csv`);
writeFileSync(process.env.RINGBACK_OUTREACH_CSV, "business,trade,city,state,phone,email,website,owner_name,reviews,rating,runs_ads,status,channel,date_contacted,replied,reply_text,next_action,notes\n");

const { addProspect, draftEmail, listProspects, outreachSummary } = await import("../lib/outreach.js");

test("outreach refuses a row without a shop name", () => {
  const r = addProspect({ email: "a@b.com" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "business_required");
});

test("outreach refuses a row without phone or email", () => {
  const r = addProspect({ business: "Acme HVAC" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "phone_or_email_required");
});

test("outreach saves one typed prospect and does not send email", () => {
  const r = addProspect({
    business: "Acme HVAC",
    owner_name: "Pat",
    city: "Austin",
    email: "pat@acme-hvac.example",
    phone: "5125550100",
    trade: "hvac",
  });
  assert.equal(r.ok, true);
  assert.equal(r.sent, false);
  assert.equal(r.prospect.business, "Acme HVAC");
  assert.equal(listProspects().length, 1);
  assert.equal(outreachSummary().count, 1);
});

test("outreach draft is copy-paste only and never claims send", () => {
  const d = draftEmail({
    business: "Acme HVAC",
    owner_name: "Pat",
    email: "pat@acme-hvac.example",
  });
  assert.equal(d.ok, true);
  assert.equal(d.sent, false);
  assert.match(d.subject, /Acme HVAC/);
  assert.match(d.body, /Hi Pat/);
  assert.match(d.note, /does not send/i);
});

test("outreach rejects a duplicate shop + email", () => {
  const r = addProspect({
    business: "Acme HVAC",
    email: "pat@acme-hvac.example",
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "duplicate_prospect");
});
