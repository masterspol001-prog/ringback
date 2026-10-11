import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateReply,
  classifyIntent,
  isUrgent,
  isEmergency,
  classifySeverity,
  scoreLead,
  inServiceArea,
  normalizeChannel,
  channelLabel,
  CHANNELS,
  TEMPLATES,
} from "../lib/engine.js";
import { extractInfo } from "../lib/extract.js";

const BIZ = {
  id: "t1",
  name: "Acme Plumbing",
  trade: "plumbing",
  serviceArea: "Denver, CO",
  bookingUrl: "https://cal.com/acme/visit",
  phone: "+1 303 555 0100",
  hours: "Mon-Sat, 7am-7pm",
  offer: "free estimates",
};

test("classifies price intent", () => {
  assert.equal(classifyIntent("how much do you charge?"), "price");
  assert.equal(classifyIntent("can I get a quote"), "price");
});

test("classifies urgency intent", () => {
  assert.equal(classifyIntent("my basement is flooding, urgent!"), "emergency");
});

test("classifies booking intent", () => {
  assert.equal(classifyIntent("I want to schedule a visit"), "booking");
});

test("classifies service area intent", () => {
  assert.equal(classifyIntent("do you serve near me"), "service_area");
});

test("falls back to general", () => {
  assert.equal(classifyIntent("hello there"), "general");
});

test("isUrgent detects emergencies", () => {
  assert.equal(isUrgent("no heat and it's freezing"), true);
  assert.equal(isUrgent("gas leak!"), true);
  assert.equal(isUrgent("just wondering about pricing"), false);
});

test("classifySeverity separates emergency, urgent, and normal", () => {
  assert.equal(classifySeverity("gas leak in the kitchen"), "emergency");
  assert.equal(isEmergency("gas leak in the kitchen"), true);
  assert.equal(classifySeverity("My AC isn't working and I'm in Austin. Can somebody come tonight?"), "urgent");
  assert.equal(isEmergency("My AC isn't working and I'm in Austin. Can somebody come tonight?"), false);
  assert.equal(classifySeverity("Looking for a spring maintenance quote"), "normal");
});

test("extractInfo location is a place, not a sentence fragment", () => {
  const leaked = extractInfo("I'm in Austin. Can somebody come tonight?", { serviceArea: "Austin, TX" });
  assert.equal(leaked.area, "Austin, TX");
  assert.doesNotMatch(leaked.area, /somebody|come tonight/i);
  const bare = extractInfo("I'm in Austin. Can somebody come tonight?");
  assert.equal(bare.area, "Austin");
  assert.doesNotMatch(bare.area, /Can somebody/);
  const service = extractInfo("My AC isn't working and I'm in Austin. Can somebody come tonight?", { serviceArea: "Austin, TX", services: [{ name: "AC repair" }] });
  assert.equal(service.service, "AC repair");
  assert.equal(service.area, "Austin, TX");
});

test("missed-call reply apologizes and includes booking link", () => {
  const r = generateReply("no heat", BIZ, { name: "Dana", channel: "missed_call", hour: 9 });
  assert.match(r.reply, /Sorry we missed your call/);
  assert.match(r.reply, /cal\.com\/acme\/visit/);
  assert.match(r.reply, /Dana/);
  assert.equal(r.channel, "missed_call");
});

test("reply never invents a specific price", () => {
  const r = generateReply("how much for a new water heater", BIZ);
  assert.doesNotMatch(r.reply, /\$\d/);
  assert.equal(r.intent, "price");
});

test("follow-up sequence has 3 steps with increasing delays", () => {
  const r = generateReply("hi", BIZ);
  assert.equal(r.followUp.length, 3);
  assert.ok(r.followUp[0].delayHours < r.followUp[1].delayHours);
  assert.ok(r.followUp[1].delayHours < r.followUp[2].delayHours);
});

test("lead scoring buckets urgent price request as hot", () => {
  const s = scoreLead({ message: "URGENT no heat, need a price", phone: "+1x", source: "missed_call" });
  assert.equal(s.bucket, "hot");
  assert.ok(s.score >= 60);
  assert.ok(s.reasons.length >= 2);
  assert.ok(s.reasons.some((r) => /emergency|urgent|same-day/i.test(r)));
});

test("availability reply does not invent same-day dispatch", () => {
  const r = generateReply("when can you come out", BIZ);
  assert.doesNotMatch(r.reply, /same or next day/i);
  assert.doesNotMatch(r.reply, /technician is on the way/i);
});

test("lead scoring buckets casual message as cold", () => {
  const s = scoreLead({ message: "just looking around", source: "web_form" });
  assert.equal(s.bucket, "cold");
});

test("missed-call source lifts a vague reply into warm", () => {
  const s = scoreLead({ message: "hi", phone: "+1x", source: "missed_call" });
  assert.equal(s.bucket, "warm");
});

test("unknown channels normalize to sms", () => {
  assert.equal(normalizeChannel("carrier_pigeon"), "sms");
  assert.equal(normalizeChannel("WHATSAPP"), "whatsapp");
  assert.equal(normalizeChannel(undefined), "sms");
});

test("every channel in the catalog normalizes to itself", () => {
  for (const c of CHANNELS) {
    assert.equal(normalizeChannel(c.id), c.id);
    assert.ok(channelLabel(c.id).length > 0);
  }
});

test("facebook channel adds a channel-specific nudge", () => {
  const r = generateReply("how much", BIZ, { channel: "facebook" });
  assert.match(r.reply, /message us here/);
  assert.equal(r.channelLabel, "Facebook Messenger");
});

test("whatsapp channel mentions photos and voice notes", () => {
  const r = generateReply("how much", BIZ, { channel: "whatsapp" });
  assert.match(r.reply, /photos and voice notes/);
});

test("webchat omits the phone footer", () => {
  const r = generateReply("hi", BIZ, { channel: "webchat" });
  assert.doesNotMatch(r.reply, /You can also call/);
});

test("sms keeps the phone footer", () => {
  const r = generateReply("hi", BIZ, { channel: "sms" });
  assert.match(r.reply, /You can also call/);
});

test("multi-turn drops the intro pitch on later turns", () => {
  const first = generateReply("how much", BIZ, { channel: "sms", history: [] });
  const later = generateReply("how much", BIZ, {
    channel: "sms",
    history: [{ role: "in", text: "how much" }, { role: "out", text: "..." }],
  });
  assert.match(first.reply, /Acme Plumbing handles/);
  assert.doesNotMatch(later.reply, /Acme Plumbing handles/);
  assert.match(later.reply, /Thanks/);
});

test("urgent language is flagged and surfaced", () => {
  const r = generateReply("emergency, water everywhere", BIZ, { channel: "sms" });
  assert.equal(r.urgent, true);
  assert.match(r.reply, /urgent/i);
});

test("every follow-up step carries the channel", () => {
  const r = generateReply("hi", BIZ, { channel: "whatsapp" });
  for (const f of r.followUp) assert.equal(f.channel, "whatsapp");
});

test("default business template has required fields", () => {
  for (const key of ["id", "name", "trade", "bookingUrl", "phone", "hours"]) {
    assert.ok(TEMPLATES.DEFAULT_BUSINESS[key], `missing ${key}`);
  }
});

test("empty input still returns a safe general reply", () => {
  const r = generateReply("", BIZ, { channel: "sms" });
  assert.equal(r.intent, "general");
  assert.ok(r.reply.length > 20);
});

test("inServiceArea matches city tokens", () => {
  const inside = inServiceArea("Denver", BIZ);
  assert.equal(inside.known, true);
  assert.equal(inside.inside, true);
  const outside = inServiceArea("Phoenix, AZ", BIZ);
  assert.equal(outside.known, true);
  assert.equal(outside.inside, false);
  const unknown = inServiceArea("", BIZ);
  assert.equal(unknown.known, false);
});

test("HELP on its own line is help, not opt-out", () => {
  const info = extractInfo("HELP");
  assert.equal(info.wantsHelp, true);
  assert.equal(info.doNotContact, false);
  const stop = extractInfo("STOP");
  assert.equal(stop.doNotContact, true);
  assert.equal(stop.wantsHelp, false);
});
