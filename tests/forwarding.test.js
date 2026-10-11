import { test } from "node:test";
import assert from "node:assert/strict";
import { carrierGuide, carrierList, forwardingGuide, connectNumberStatus } from "../lib/forwarding.js";

test("carrier list exposes the four known carriers", () => {
  const ids = carrierList().map((c) => c.id);
  assert.deepEqual(ids.sort(), ["att", "other", "tmobile", "verizon"]);
});

test("forwarding guide never claims RingBack flips the carrier", () => {
  const g = forwardingGuide({ shopPhone: "+15125550142", twilioNumber: "+15125550100", carrier: "verizon" });
  assert.equal(g.flippedByRingBack, false);
  assert.match(g.note, /cannot flip forwarding at the carrier/i);
  assert.ok(g.steps.some((s) => s.includes("+15125550100")));
  assert.ok(g.steps.some((s) => /unanswered and busy/i.test(s)));
});

test("tmobile and att codes differ from verizon", () => {
  assert.match(carrierGuide("tmobile").unanswered, /\*\*61\*/);
  assert.match(carrierGuide("att").unanswered, /\*92/);
  assert.match(carrierGuide("verizon").unanswered, /\*71/);
});

test("connect status is not connected until twilio and forwarding are real", () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  const d = connectNumberStatus({ shopPhone: "+15125550142", ownerPhone: "+15125550199", forwarded: false });
  assert.equal(d.connected, false);
  assert.ok(d.missing.includes("twilio"));
  assert.ok(d.missing.includes("forwarding_not_confirmed"));
  assert.equal(d.ok, true);
});

test("connect status flags missing owner phone", () => {
  const d = connectNumberStatus({ shopPhone: "+15125550142", ownerPhone: "", forwarded: true });
  assert.ok(d.missing.includes("owner_phone"));
  assert.ok(d.missing.includes("twilio"));
});
