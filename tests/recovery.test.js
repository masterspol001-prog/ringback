import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

process.env.RINGBACK_DB = join(tmpdir(), `ringback-recovery-${Date.now()}.db`);

const { ingest, pauseConversation, resumeConversation, conversationIntelligence } = await import("../lib/conversation.js");
const { applyStatus, computeMetrics, LEAD_STATUSES } = await import("../lib/lifecycle.js");
const { decide, matchFaq } = await import("../lib/reception.js");
const { resetForTests, getLead } = await import("../lib/store.js");
const { resetDomain, listLeadMessages, listFollowUpJobs, leadTimeline, listNotifications } = await import("../lib/domain.js");
const { cancelForLead, stopReason } = await import("../lib/followup.js");
const { DEMO_BUSINESSES } = await import("../lib/seed.js");
const { normalizeBusiness } = await import("../lib/business.js");
const { rateLimit, resetRateLimit, verifyWebhook } = await import("../lib/security.js");

before(() => {
  resetForTests();
  resetDomain();
});

test("lifecycle includes won and off-ramps", () => {
  assert.ok(LEAD_STATUSES.includes("won"));
  assert.ok(LEAD_STATUSES.includes("do_not_contact"));
  const patch = applyStatus({ status: "new", stageAt: {} }, "booked");
  assert.equal(patch.status, "booked");
  assert.equal(patch.revenueStatus, "booked");
});

test("computeMetrics does not count booked jobs as recovered", () => {
  const m = computeMetrics([
    { status: "booked", jobValue: 720, reply: "hi", source: "sms", createdAt: "2026-09-18T00:00:00.000Z" },
    { status: "won", confirmedRevenue: 680, jobValue: 680, reply: "hi", source: "missed_call", createdAt: "2026-09-18T00:00:00.000Z" },
  ]);
  assert.equal(m.recoveredRevenue, 680);
  assert.equal(m.estimatedRevenue, 720);
  assert.equal(m.verifiedRevenue, 680);
  assert.equal(m.customersRecovered, 1);
  assert.equal(m.missedCallsHandled, 1);
  assert.equal(m.qualifiedLeads, 2);
  assert.equal(m.funnel.booked, 1);
  assert.equal(m.funnel.completed, 1);
  assert.equal(m.funnel.verifiedRevenue, 680);
  assert.equal(m.potentialRevenue, 720);
});

test("ingest creates a lead, conversation, and follow-ups", async () => {
  const r = await ingest({
    businessId: "demo-hvac",
    channel: "missed_call",
    source: "missed_call",
    name: "Dana",
    phone: "+15125550199",
    message: "AC is out",
    ai: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.ok(r.lead.id.startsWith("lead_"));
  assert.equal(r.lead.source, "missed_call");
  assert.ok(r.lead.reply.length > 10);
  assert.ok(r.conversation.id);
  assert.equal(listFollowUpJobs({ leadId: r.lead.id }).length, 3);
});

test("a second inbound from the same phone continues the open lead", async () => {
  const first = await ingest({
    businessId: "demo-hvac",
    channel: "missed_call",
    name: "Loop",
    phone: "+15125550888",
    message: "AC is out",
    ai: false,
  });
  const second = await ingest({
    businessId: "demo-hvac",
    channel: "sms",
    phone: "5125550888",
    message: "Tonight at 1200 Barton",
    ai: false,
  });
  assert.equal(second.created, false);
  assert.equal(second.lead.id, first.lead.id);
});

test("outbound-only follow-up sends the job text and does not re-greet", async () => {
  const first = await ingest({
    businessId: "demo-hvac",
    channel: "missed_call",
    name: "Follow",
    phone: "+15125550887",
    message: "Need AC repair",
    ai: false,
  });
  const greeting = first.reply;
  const follow = await ingest({
    leadId: first.lead.id,
    businessId: "demo-hvac",
    channel: "sms",
    outboundOnly: true,
    outboundText: "Just checking whether you still need help with AC repair. Reply YES and I'll get you a time.",
    ai: false,
  });
  assert.equal(follow.ok, true);
  assert.equal(follow.decision, null);
  assert.match(follow.reply, /Just checking/);
  assert.notEqual(follow.reply, greeting);
  assert.equal(follow.delivery.simulated, true);
});

test("opt-out stops follow-up and marks do_not_contact", async () => {
  const first = await ingest({
    businessId: "demo-hvac",
    channel: "sms",
    name: "Chris",
    phone: "+15125550177",
    message: "Need a quote for a new AC",
    ai: false,
  });
  const second = await ingest({
    leadId: first.lead.id,
    businessId: "demo-hvac",
    channel: "sms",
    message: "stop",
    ai: false,
  });
  assert.equal(second.lead.status, "do_not_contact");
  assert.equal(second.lead.optedOut, true);
  assert.ok(second.events.includes("opt_out"));
});

test("escalation fires for emergency + human request", async () => {
  const r = await ingest({
    businessId: "demo-electrical",
    channel: "sms",
    name: "Dana Ruiz",
    phone: "+16155550191",
    message: "The outlets are sparking and I smell burning. Can a human call me right now?",
    ai: false,
    business: DEMO_BUSINESSES.electrical,
  });
  assert.ok(r.decision.escalation);
  assert.ok(r.notification);
  assert.ok(r.events.includes("escalation"));
});

test("booking confirms only after a slot choice", async () => {
  const biz = normalizeBusiness(DEMO_BUSINESSES.hvac);
  const first = decide({
    conversation: { state: "greeting", proposedSlots: [] },
    qualification: { service: "AC repair", area: "Austin", timing: "this week" },
    message: "Please book an AC repair in Austin this week",
    business: biz,
    meta: { channel: "sms", name: "Sarah" },
  });
  assert.equal(first.stage, "booking_requested");
  assert.equal(first.bookingState, "offered");
  assert.notEqual(first.stage, "booked");
  assert.ok(first.slots.length >= 1);
  assert.match(first.reply, /Times offered — not a booking|Demo availability/);
  assert.ok(first.slots.every((s) => s.demo === true || s.source === "demo_availability" || /Demo availability/.test(s.label)));

  const selected = decide({
    conversation: { state: "booking", proposedSlots: first.slots },
    qualification: first.qualification,
    message: "1",
    business: biz,
    meta: { channel: "sms", name: "Sarah" },
  });
  assert.equal(selected.bookingState, "selected");
  assert.equal(selected.stage, "booking_requested");
  assert.notEqual(selected.stage, "booked");
  assert.ok(selected.slot);

  const confirm = decide({
    conversation: { state: "booking", proposedSlots: first.slots, selectedSlot: selected.slot },
    qualification: first.qualification,
    message: "yes",
    business: biz,
    meta: { channel: "sms", name: "Sarah" },
  });
  assert.equal(confirm.stage, "booked");
  assert.equal(confirm.bookingState, "confirmed");
  assert.ok(confirm.slot);
  assert.notEqual(selected.bookingState, confirm.bookingState);
});

test("Austin tonight demo extracts city and is urgent not emergency", () => {
  const biz = normalizeBusiness(DEMO_BUSINESSES.hvac);
  const d = decide({
    conversation: { state: "greeting", proposedSlots: [] },
    qualification: {},
    message: "I'm in Austin. Can somebody come tonight?",
    business: biz,
    meta: { channel: "sms" },
  });
  assert.equal(d.qualification.area, "Austin, TX");
  assert.doesNotMatch(d.qualification.area || "", /somebody|Can somebody/i);
  assert.equal(d.severity, "urgent");
  assert.notEqual(d.severity, "emergency");
  assert.doesNotMatch(d.reply, /^In,/);
  assert.doesNotMatch(d.reply, /I've dispatched/);
  assert.doesNotMatch(d.reply, /same-night dispatch/);
  assert.match(d.reply, /will not invent a price or claim a technician is on the way/);
});

test("emergency follows shop policy and does not invent dispatch", () => {
  const biz = normalizeBusiness({
    ...DEMO_BUSINESSES.hvac,
    emergency: { available: true, policy: "After-hours emergencies get a same-night dispatch when a tech is available." },
  });
  const d = decide({
    conversation: { state: "greeting", proposedSlots: [] },
    qualification: {},
    message: "gas leak in the kitchen, I smell gas",
    business: biz,
    meta: { channel: "sms" },
  });
  assert.equal(d.severity, "emergency");
  assert.ok(d.escalation);
  assert.equal(d.escalation.reason, "emergency");
  assert.match(d.reply, /same-night dispatch when a tech is available/);
  assert.match(d.reply, /will not invent a price or claim a technician is on the way/);
});

test("ingest persists severity and bookingState on the lead", async () => {
  const r = await ingest({
    businessId: "demo-hvac",
    channel: "sms",
    name: "Pat",
    phone: "+15125550901",
    message: "I'm in Austin. Can somebody come tonight? AC isn't working.",
    ai: false,
    business: DEMO_BUSINESSES.hvac,
  });
  assert.equal(r.ok, true);
  const stored = getLead(r.lead.id);
  assert.equal(stored.severity, "urgent");
  assert.equal(stored.qualification.severity, "urgent");
  assert.ok(["offered", "available"].includes(stored.bookingState));
  if (stored.status === "booking_requested") {
    assert.equal(stored.bookingState, "offered");
    assert.notEqual(stored.status, "booked");
  }
});

test("Sarah 11:30PM ABC HVAC recovery loop", async () => {
  const first = await ingest({
    businessId: "demo-hvac",
    channel: "missed_call",
    source: "missed_call",
    name: "Sarah Patel",
    phone: "+15125558821",
    message: "My AC stopped working and I need someone today.",
    ai: false,
    business: DEMO_BUSINESSES.hvac,
  });
  assert.equal(first.ok, true);
  assert.equal(first.lead.name, "Sarah Patel");
  assert.ok(first.lead.reply);

  const second = await ingest({
    leadId: first.lead.id,
    businessId: "demo-hvac",
    channel: "sms",
    message: "It's at 1200 Barton Springs Rd, Austin. Tonight if possible.",
    ai: false,
    business: DEMO_BUSINESSES.hvac,
  });
  assert.ok(second.lead.qualification.area || second.lead.qualification.address);
  const timeline = leadTimeline(first.lead.id);
  assert.ok(timeline.length >= 4);
  assert.ok(listLeadMessages(first.lead.id).some((m) => m.direction === "out"));
});

test("rate limit fails closed after max hits", () => {
  resetRateLimit();
  for (let i = 0; i < 3; i++) assert.equal(rateLimit("t", { max: 3 }).ok, true);
  assert.equal(rateLimit("t", { max: 3 }).ok, false);
});

test("webhook verify is honest when unconfigured", () => {
  const none = verifyWebhook({ provider: "hmac", secret: "", payload: {}, signature: "x" });
  assert.equal(none.reason, "not_configured");
  assert.equal(none.verified, false);
});

test("stopReason skips booked and opted-out leads", () => {
  assert.equal(stopReason({ lead: { status: "booked", followUpStatus: "active" }, business: { followUp: { enabled: true } } }), "closed");
  assert.equal(stopReason({ lead: { status: "new", optedOut: true, followUpStatus: "active" }, business: { followUp: { enabled: true } } }), "do_not_contact");
  cancelForLead("missing", "test");
});

test("owner takeover pauses AI replies until return_to_ai", async () => {
  const first = await ingest({
    businessId: "demo-hvac",
    channel: "sms",
    name: "Owner Pause",
    phone: "+15125550901",
    message: "Need AC repair in Austin tomorrow",
    ai: false,
    business: DEMO_BUSINESSES.hvac,
  });
  const paused = pauseConversation(first.conversation, "Owner took over the conversation.");
  assert.equal(paused.state, "paused");
  assert.equal(paused.ownerMode, true);
  assert.match(paused.pausedReason, /Owner took over/);

  const during = await ingest({
    leadId: first.lead.id,
    businessId: "demo-hvac",
    channel: "sms",
    message: "Can you still book me?",
    ai: false,
    business: DEMO_BUSINESSES.hvac,
  });
  assert.equal(during.paused, true);
  assert.equal(during.reply, null);
  assert.equal(during.messages.outbound, null);
  assert.equal(during.conversation.state, "paused");
  assert.ok(listLeadMessages(first.lead.id).some((m) => m.text.includes("Can you still book me")));

  resumeConversation(during.conversation);
  const after = await ingest({
    leadId: first.lead.id,
    businessId: "demo-hvac",
    channel: "sms",
    message: "Yes please book tomorrow afternoon",
    ai: false,
    business: DEMO_BUSINESSES.hvac,
  });
  assert.equal(after.paused, undefined);
  assert.ok(after.reply);
  assert.ok(after.reply.length > 8);
});

test("conversation intelligence surfaces next action and pause reason", () => {
  const intel = conversationIntelligence({
    lead: { status: "qualified", urgent: true, qualification: { service: "AC repair" }, intent: "availability" },
    conversation: { state: "paused", ownerMode: true, pausedReason: "Customer requested human" },
  });
  assert.equal(intel.paused, true);
  assert.equal(intel.pausedReason, "Customer requested human");
  assert.match(intel.nextAction, /Owner is handling/);
});

test("clinic receptionist asks patient questions instead of a service address", () => {
  const biz = normalizeBusiness(DEMO_BUSINESSES.dental);
  const d = decide({
    conversation: { state: "greeting" },
    qualification: {},
    message: "",
    business: biz,
    meta: { channel: "missed_call", name: "Priya" },
  });
  assert.match(d.reply, /patient|visit/i);
  assert.doesNotMatch(d.reply, /service address/i);
});

test("computeMetrics keeps demo recoveries out of verified dollars", () => {
  const m = computeMetrics([
    { status: "won", confirmedRevenue: 680, jobValue: 680, reply: "hi", source: "missed_call", businessId: "demo-plumbing" },
    { status: "won", confirmedRevenue: 500, jobValue: 500, reply: "hi", source: "missed_call", businessId: "shop-1" },
  ]);
  assert.equal(m.verifiedRevenue, 500);
  assert.equal(m.demoRevenue, 680);
  assert.equal(m.customersRecovered, 1);
});

test("computeMetrics tracks lost reasons separately from verified dollars", () => {
  const m = computeMetrics([
    { status: "lost", lostReason: "price", jobValue: 400, reply: "hi", source: "sms" },
    { status: "unqualified", lostReason: "outside_area", jobValue: 200, reply: "hi", source: "web_form" },
    { status: "won", confirmedRevenue: 680, jobValue: 680, reply: "hi", source: "missed_call" },
  ]);
  assert.equal(m.verifiedRevenue, 680);
  assert.equal(m.estimatedRevenue, 0);
  assert.equal(m.jobsCompleted, 1);
  assert.equal(m.byLostReason.price, 1);
  assert.equal(m.byLostReason.outside_area, 1);
});

test("outside configured service area is unqualified, not booked", () => {
  const biz = normalizeBusiness(DEMO_BUSINESSES.hvac);
  const d = decide({
    conversation: { state: "greeting", proposedSlots: [] },
    qualification: { service: "AC repair", area: "Phoenix, AZ", timing: "this week" },
    message: "Please book AC repair in Phoenix this week",
    business: biz,
    meta: { channel: "sms", name: "Alex" },
  });
  assert.equal(d.stage, "unqualified");
  assert.equal(d.lostReason, "outside_area");
  assert.doesNotMatch(d.reply, /\$\d/);
});

test("hot lead notifies the owner without inventing a price", async () => {
  const r = await ingest({
    businessId: "demo-hvac",
    channel: "missed_call",
    source: "missed_call",
    name: "Jordan Lee",
    phone: "+15125550999",
    message: "URGENT no heat, furnace died, need someone today at 14 Oak St Austin",
    ai: false,
    business: DEMO_BUSINESSES.hvac,
  });
  assert.ok(r.notification || r.events.includes("hot_lead") || r.events.includes("escalation"));
  const notes = listNotifications("demo-hvac", 20);
  assert.ok(notes.length >= 1);
  for (const n of notes) {
    assert.doesNotMatch(String(n.body || ""), /\$\d/);
  }
});

test("emergency without policy fails safely and does not dispatch", () => {
  const biz = normalizeBusiness({
    ...DEMO_BUSINESSES.hvac,
    emergency: {},
  });
  const d = decide({
    conversation: { state: "greeting", proposedSlots: [] },
    qualification: {},
    message: "gas leak in the kitchen, I smell gas",
    business: biz,
    meta: { channel: "sms" },
  });
  assert.equal(d.severity, "emergency");
  assert.match(d.reply, /No emergency policy is configured/);
  assert.match(d.reply, /Dispatcher has not confirmed/);
  assert.match(d.reply, /will not invent a price or claim a technician is on the way/);
  assert.doesNotMatch(d.reply, /A technician is on the way\./);
});

test("ingest records message timestamps and a lead timeline", async () => {
  const r = await ingest({
    businessId: "demo-hvac",
    channel: "missed_call",
    source: "missed_call",
    name: "Sarah Patel",
    phone: "+15125558821",
    message: "My AC isn't working and I'm in Austin. Can somebody come tonight?",
    ai: false,
    business: DEMO_BUSINESSES.hvac,
  });
  assert.equal(r.ok, true);
  const stored = getLead(r.lead.id);
  assert.ok(stored.stageAt?.message_queued_at);
  assert.equal(stored.deliveryStatus === "sent" ? Boolean(stored.stageAt?.first_response) : true, true);
  const intel = conversationIntelligence({ lead: stored, conversation: r.conversation, appointments: [] });
  assert.ok(intel.valueExplanation);
  assert.equal(intel.valueExplanation.label, "ESTIMATED");
  assert.match(intel.valueExplanation.status, /not verified/i);
  assert.ok(Array.isArray(intel.heatReasons));
  const timeline = leadTimeline(r.lead.id);
  assert.ok(timeline.length >= 2);
  const types = timeline.map((e) => e.type || e.kind);
  assert.ok(types.includes("missed_call") || types.includes("lead_created") || types.includes("event"));
});

test("knowledge base FAQs answer only from approved copy", () => {
  const biz = normalizeBusiness({
    ...DEMO_BUSINESSES.hvac,
    faqs: [{ q: "Do you charge a diagnostic fee?", a: "Diagnostic visits start at $89, waived if you proceed with the repair." }],
  });
  assert.match(matchFaq(biz, "diagnostic fee"), /\$89/);
  const d = decide({
    conversation: { state: "waiting_for_customer", turnCount: 1 },
    qualification: {},
    message: "Do you charge a diagnostic fee?",
    business: biz,
    meta: { channel: "sms" },
  });
  assert.match(d.reply, /\$89/);
});

test("YES without a selected slot is not a booking", () => {
  const biz = normalizeBusiness(DEMO_BUSINESSES.hvac);
  const offered = decide({
    conversation: { state: "greeting", proposedSlots: [] },
    qualification: { service: "AC repair", area: "Austin", timing: "this week" },
    message: "Please book an AC repair in Austin this week",
    business: biz,
    meta: { channel: "sms", name: "Sam" },
  });
  const confirm = decide({
    conversation: { state: "booking", proposedSlots: offered.slots, selectedSlot: null },
    qualification: offered.qualification,
    message: "yes",
    business: biz,
    meta: { channel: "sms", name: "Sam" },
  });
  assert.notEqual(confirm.stage, "booked");
  assert.equal(confirm.bookingFailed, true);
  assert.match(confirm.reply, /couldn't confirm/i);
});

test("activation checklist does not invent a ready shop", async () => {
  const { activationChecklist } = await import("../lib/business.js");
  const empty = activationChecklist({ name: "Your Business" });
  assert.equal(empty.ready, false);
  assert.ok(empty.missing.includes("name"));
  assert.ok(empty.missing.includes("emergency"));
});

test("won without invoice is not verified revenue status", () => {
  const patch = applyStatus({ status: "booked", stageAt: {}, confirmedRevenue: null }, "won");
  assert.equal(patch.status, "won");
  assert.notEqual(patch.revenueStatus, "won");
});

test("HELP on its own line is not an opt-out", () => {
  const biz = normalizeBusiness(DEMO_BUSINESSES.hvac);
  const d = decide({
    conversation: { state: "greeting" },
    qualification: {},
    message: "HELP",
    business: biz,
    meta: { channel: "sms" },
  });
  assert.match(d.reply, /Reply STOP/i);
  assert.notEqual(d.stage, "do_not_contact");
  assert.equal(d.doNotContact, undefined);
});

test("duplicate missed call within 15 minutes does not send another sorry", async () => {
  const first = await ingest({
    businessId: "shop-dup",
    channel: "missed_call",
    source: "missed_call",
    name: "Pat",
    phone: "+15125550111",
    message: "",
    ai: false,
  });
  assert.equal(first.created, true);
  const second = await ingest({
    businessId: "shop-dup",
    channel: "missed_call",
    source: "missed_call",
    name: "Pat",
    phone: "+15125550111",
    message: "",
    ai: false,
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.lead.id, first.lead.id);
  assert.equal(second.delivery.reason, "duplicate_missed_call");
  assert.equal(second.reply, null);
});

test("follow-up stops on emergency, unreachable, and owner takeover", () => {
  assert.equal(stopReason({ lead: { status: "new", followUpStatus: "active", severity: "emergency" } }), "emergency");
  assert.equal(stopReason({ lead: { status: "new", followUpStatus: "active", failureState: "sms_unavailable" } }), "unreachable");
  assert.equal(stopReason({ lead: { status: "new", followUpStatus: "active" }, conversation: { ownerMode: true, state: "paused" } }), "conversation_closed");
});

test("kill switch blocks auto-reply", async () => {
  const { saveSettings } = await import("../lib/domain.js");
  saveSettings("shop-kill", { automationPaused: true });
  const r = await ingest({
    businessId: "shop-kill",
    channel: "missed_call",
    source: "missed_call",
    name: "Kim",
    phone: "+15125550122",
    message: "",
    ai: false,
  });
  assert.equal(r.paused, true);
  assert.equal(r.reply, null);
  assert.equal(r.delivery.reason, "automation_paused");
});

test("quiet hours do not hold simulated SMS", async () => {
  const r = await ingest({
    businessId: "shop-quiet-sim",
    channel: "sms",
    source: "sms",
    name: "Late",
    phone: "+15125550123",
    message: "AC out, can you come?",
    at: "2026-09-21T23:30:00",
    ai: false,
  });
  assert.ok(r.reply);
  assert.notEqual(r.delivery.reason, "quiet_hours");
  assert.equal(r.events.includes("quiet_hours"), false);
});

test("quiet hours hold live SMS only", async () => {
  const prev = {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM_NUMBER,
  };
  process.env.TWILIO_ACCOUNT_SID = "ACtestquiet";
  process.env.TWILIO_AUTH_TOKEN = "tokentestquiet";
  process.env.TWILIO_FROM_NUMBER = "+15125550000";
  try {
    const r = await ingest({
      businessId: "shop-quiet-live",
      channel: "sms",
      source: "sms",
      name: "LateLive",
      phone: "+15125550126",
      message: "AC out, can you come?",
      at: "2026-09-21T23:30:00",
      ai: false,
    });
    assert.equal(r.delivery.reason, "quiet_hours");
    assert.ok(r.events.includes("quiet_hours"));
    assert.equal(r.lead.failureState, "quiet_hours");
    assert.equal(r.lead.deliveryStatus, "not_configured");
  } finally {
    if (prev.sid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
    else process.env.TWILIO_ACCOUNT_SID = prev.sid;
    if (prev.token === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = prev.token;
    if (prev.from === undefined) delete process.env.TWILIO_FROM_NUMBER;
    else process.env.TWILIO_FROM_NUMBER = prev.from;
  }
});

test("duplicate Twilio providerRef is idempotent", async () => {
  const first = await ingest({
    businessId: "shop-sid",
    channel: "sms",
    source: "sms",
    name: "Sid",
    phone: "+15125550124",
    message: "Need AC",
    providerRef: "SM123duplicate",
    ai: false,
  });
  assert.equal(first.created, true);
  const second = await ingest({
    businessId: "shop-sid",
    channel: "sms",
    source: "sms",
    name: "Sid",
    phone: "+15125550124",
    message: "Need AC",
    providerRef: "SM123duplicate",
    ai: false,
  });
  assert.equal(second.idempotent, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.delivery.reason, "duplicate_webhook");
  assert.equal(second.lead.id, first.lead.id);
});

test("follow-up retries failed sends then cancels after max attempts", async () => {
  const { addFollowUpJob, updateFollowUpJob, listFollowUpJobs } = await import("../lib/domain.js");
  const { runDueJobs, MAX_SEND_ATTEMPTS } = await import("../lib/followup.js");
  const { nextId } = await import("../lib/store.js");
  const leadId = nextId("lead");
  const job = addFollowUpJob({
    businessId: "shop-retry",
    leadId,
    channel: "sms",
    text: "checking in",
    runAt: new Date(0).toISOString(),
    status: "pending",
  });
  const now = Date.now();
  const first = await runDueJobs({
    businessId: "shop-retry",
    business: { followUp: { enabled: true } },
    getLead: () => ({ id: leadId, status: "new", followUpStatus: "active" }),
    getConversation: () => ({ state: "waiting_for_customer" }),
    send: async () => ({ status: "failed", error: "network" }),
    now,
  });
  assert.equal(first.results[0].sent, false);
  assert.equal(first.results[0].attempts, 1);
  const pending = listFollowUpJobs({ leadId, status: "pending" });
  assert.equal(pending.length, 1);
  for (let i = 1; i < MAX_SEND_ATTEMPTS; i++) {
    updateFollowUpJob(job.id, { runAt: new Date(0).toISOString() });
    await runDueJobs({
      businessId: "shop-retry",
      business: { followUp: { enabled: true } },
      getLead: () => ({ id: leadId, status: "new", followUpStatus: "active" }),
      getConversation: () => ({ state: "waiting_for_customer" }),
      send: async () => ({ status: "failed", error: "network" }),
      now: now + i * 16 * 60 * 1000,
    });
  }
  const cancelled = listFollowUpJobs({ leadId, status: "cancelled" });
  assert.equal(cancelled.length, 1);
});

test("account deletion removes leads and documents", async () => {
  const { deleteBusinessAccount } = await import("../lib/account.js");
  const created = await ingest({
    businessId: "shop-delete-me",
    channel: "sms",
    name: "Gone",
    phone: "+15125550125",
    message: "Need heat",
    ai: false,
  });
  assert.equal(created.created, true);
  const refused = deleteBusinessAccount("shop-delete-me", { confirm: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "confirm_required");
  const demo = deleteBusinessAccount("demo", { confirm: "DELETE" });
  assert.equal(demo.ok, false);
  const ok = deleteBusinessAccount("shop-delete-me", { confirm: "DELETE" });
  assert.equal(ok.ok, true);
  assert.equal(ok.leadsDeleted >= 1, true);
  assert.equal(getLead(created.lead.id), null);
});

test("entitlements report starter SMS cap", async () => {
  const { entitlementsReport, limitsFor } = await import("../lib/entitlements.js");
  const limits = limitsFor("starter");
  assert.equal(limits.smsPerMonth, 500);
  const report = entitlementsReport("shop-entitle");
  assert.equal(report.plan, "starter");
  assert.equal(report.limits.smsPerMonth, 500);
  assert.equal(typeof report.usage.sms, "number");
});

test("account export includes this business only", async () => {
  const { exportBusinessAccount } = await import("../lib/account.js");
  const created = await ingest({
    businessId: "shop-export-me",
    channel: "sms",
    name: "Pat",
    phone: "+15125550126",
    message: "Need AC",
    ai: false,
  });
  assert.equal(created.created, true);
  const missing = exportBusinessAccount("");
  assert.equal(missing.ok, false);
  const dump = exportBusinessAccount("shop-export-me");
  assert.equal(dump.ok, true);
  assert.equal(dump.businessId, "shop-export-me");
  assert.ok(dump.leads.some((l) => l.id === created.lead.id));
  assert.ok(dump.documents.messages);
});

test("test recovery flag never claims a live text", async () => {
  const r = await ingest({
    businessId: "shop-test-flow",
    channel: "missed_call",
    source: "missed_call",
    name: "Test caller",
    phone: "+15555550100",
    test: true,
    forceNew: true,
    ai: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.delivery.simulated, true);
  assert.equal(r.delivery.status, "simulated");
  assert.equal(r.delivery.reason, "test_recovery");
  assert.notEqual(r.lead.sms?.status, "sent");
});

test("Twilio status maps delivered and undelivered", async () => {
  const { mapTwilioMessageStatus } = await import("../lib/sms.js");
  const { addMessage, findMessageByProviderRef, updateMessage } = await import("../lib/domain.js");
  assert.equal(mapTwilioMessageStatus("delivered"), "delivered");
  assert.equal(mapTwilioMessageStatus("undelivered"), "undelivered");
  assert.equal(mapTwilioMessageStatus("failed"), "undelivered");
  assert.equal(mapTwilioMessageStatus("queued"), "sent");
  const msg = addMessage({
    businessId: "shop-receipt",
    conversationId: "conv_receipt",
    leadId: "lead_receipt",
    direction: "out",
    channel: "sms",
    text: "hi",
    status: "sent",
    providerRef: "SMreceipt1",
  });
  assert.equal(findMessageByProviderRef("SMreceipt1").id, msg.id);
  const updated = updateMessage(msg.id, { status: "delivered" });
  assert.equal(updated.status, "delivered");
});
