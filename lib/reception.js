// The AI receptionist.
//
// This is the core loop: understand what the customer needs, qualify them,
// answer safely from the business's own configuration, and move them to a
// booking. It is deterministic by design so the product works with no AI key,
// and it exposes the same decision shape the LLM path must produce, so the AI
// can be dropped in behind strict validation without changing the loop.
//
// Hard rule: never invent a price, an availability promise, a policy, or a
// guarantee. If the config does not contain the answer, ask a better question
// or escalate to a human.

import { classifyIntent, isUrgent, classifySeverity, inServiceArea } from "./engine.js";
import { extractInfo } from "./extract.js";
import { evaluateEscalation } from "./handoff.js";
import { proposeSlots, parseSlotChoice, isConfirmation, isDecline } from "./booking.js";
import { startingPriceFor, currencySymbol, isClinicTrade } from "./business.js";

export const RECEPTIONIST_VERSION = "receptionist-v2";
export const PROMPT_VERSION = "ringback-receptionist-v2";

export const OUTCOMES = [
  "answer",
  "collect",
  "qualify",
  "book",
  "callback",
  "escalate",
  "unqualified",
  "follow_up",
];

const FIELD_QUESTIONS = {
  service: (b) => {
    if (isClinicTrade(b.tradeKey || b.trade)) {
      return "Are you a new or existing patient, and what is the visit for?";
    }
    return b.trade && b.trade !== "other" ? `What do you need help with - is it ${b.trade}?` : "What can we help you with?";
  },
  area: (b) => {
    if (isClinicTrade(b.tradeKey || b.trade)) return b.serviceArea ? `Which ${b.serviceArea} location works best?` : "Which location works best?";
    return b.serviceArea ? `What part of ${b.serviceArea} are you in?` : "What's the service address?";
  },
  timing: (b) => (isClinicTrade(b.tradeKey || b.trade) ? "When works best - today, tomorrow, or later this week?" : "When works best - today, tomorrow, or later this week?"),
};

export function requiredFields(business) {
  const rules = business?.bookingRules || {};
  const fields = [];
  if (rules.requireService !== false) fields.push("service");
  if (rules.requireArea !== false) fields.push("area");
  if (rules.requireTiming !== false) fields.push("timing");
  return fields;
}

export function missingFields(qualification = {}, business = {}) {
  return requiredFields(business).filter((f) => {
    if (f === "service") return !qualification.service;
    if (f === "area") return !(qualification.area || qualification.address);
    if (f === "timing") return !qualification.timing;
    return false;
  });
}

export function isReadyToBook(qualification = {}, business = {}) {
  return missingFields(qualification, business).length === 0;
}

export function mergeQualification(previous = {}, extracted = {}) {
  const merged = { ...previous };
  const fields = ["name", "phone", "email", "address", "area", "service", "timing", "budget", "severity"];
  for (const f of fields) {
    const value = extracted[f];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "string" && !value.trim()) continue;
    merged[f] = value;
  }
  return merged;
}

function firstName(name) {
  if (!name) return "";
  const clean = String(name).trim().split(/\s+/)[0];
  return clean ? clean : "";
}

function money(business, amount) {
  return `${currencySymbol(business.pricing?.currency)}${amount}`;
}

// The next thing we need to know, phrased for a human.
function nextQuestion(qualification, business) {
  const missing = missingFields(qualification, business);
  if (!missing.length) return "";
  return FIELD_QUESTIONS[missing[0]](business);
}

function bookingOffer(business, slots) {
  if (!slots.length) {
    return " We couldn't verify availability right now. A team member will follow up.";
  }
  const demo = slots.some((s) => s.demo);
  const list = slots.map((s, i) => `${i + 1}) ${s.label}`).join("  ");
  const link = business.bookingUrl ? ` Or book yourself: ${business.bookingUrl}` : "";
  const prefix = demo ? " Demo availability (not a live calendar): " : " Times offered — not a booking: ";
  return `${prefix}${list}. Reply 1, 2, or 3. Confirmation happens only after you pick and we confirm.${link}`;
}

// Answers an intent using only configuration facts. Returns "" when we have
// nothing safe to say, so the caller falls back to a question.
function answerFromConfig(intent, qualification, business) {
  const faqHit = matchFaq(business, [qualification.service, intent].filter(Boolean).join(" "));
  switch (intent) {
    case "hours":
      return business.hours ? `We're open ${business.hours}.` : faqHit;
    case "service_area":
      return business.serviceArea ? `We serve ${business.serviceArea}.` : faqHit;
    case "finance":
      return faqHit || "We can look at payment options on larger jobs.";
    case "warranty":
      return faqHit || "We're licensed and our work is guaranteed.";
    case "price": {
      const price = qualification.service ? startingPriceFor(business, qualification.service) : null;
      if (price !== null && price !== undefined) {
        const unit = business.pricing?.quoteRequired ? "start at" : "are";
        return `For ${qualification.service}, prices ${unit} ${money(business, price)}.`;
      }
      return faqHit;
    }
    default:
      return matchFaq(business, qualification.service || intent) || "";
  }
}

function tokens(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

export function matchFaq(business, query) {
  const faqs = Array.isArray(business?.faqs) ? business.faqs : [];
  if (!faqs.length) return "";
  const qTokens = tokens(query);
  if (!qTokens.length) return "";
  let best = null;
  let bestScore = 0;
  for (const f of faqs) {
    const hay = tokens(`${f.q} ${f.a}`);
    const score = qTokens.filter((t) => hay.includes(t)).length;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return bestScore > 0 ? best.a : "";
}

export function composeReply({ kind, business, qualification, slots = [], intent = "general", slot = null, escalation = null }) {
  const who = firstName(qualification.name);
  const hi = who ? `${who}, ` : "";

  switch (kind) {
    case "missed_call":
      return `${hi}sorry we missed your call! This is the ${business.name} assistant. ${nextQuestion(qualification, business) || "What can we help you with?"}`.trim();
    case "greeting":
      return `Hi ${hi}thanks for reaching out to ${business.name}. ${nextQuestion(qualification, business) || "What can we help you with?"}`.trim();
    case "opt_out":
      return "Understood - we won't contact you again. Sorry for the interruption.";
    case "help":
      return `${business.name || "This business"} texts about missed calls and appointments. Reply STOP to opt out. For a person, reply HUMAN.`;
    case "booking_confirmed":
      return `Booked${who ? `, ${who}` : ""} - ${slot?.label || "your appointment"} with ${business.name}. ${business.phone ? `If anything changes, call ${business.phone}.` : "If anything changes, just reply here."}`;
    case "booking_selected":
      return `${hi}got it - ${slot?.label || "that time"} is selected, not confirmed yet. Reply YES to confirm or pick another number.`;
    case "urgent":
      return `${hi}I've flagged this as urgent, not an emergency. RingBack will not invent a price or claim a technician is on the way. ${nextQuestion(qualification, business) || "What else do we need to book this?"}`.trim();
    case "booking_offer": {
      const head = who ? `${who}, great -` : "Great -";
      const answer = answerFromConfig(intent, qualification, business);
      return `${head}${answer ? ` ${answer}` : ""}${bookingOffer(business, slots)}`.trim();
    }
    case "declined":
      return `No problem${who ? `, ${who}` : ""}. ${nextQuestion(qualification, business) || "What would be a better time?"}`;
    case "emergency": {
      const policyConfigured = Boolean(String(business.emergency?.policy || "").trim());
      const policy = policyConfigured ? ` Shop policy: ${business.emergency.policy}` : "";
      const failSafe = policyConfigured ? "" : " No emergency policy is configured, so RingBack will not promise dispatch.";
      const offer = business.emergency?.available ? bookingOffer(business, slots) : " RingBack has not dispatched anyone.";
      return `${hi}Emergency detected. Owner notified. Dispatcher has not confirmed. No technician is on the way unless the owner confirms.${failSafe}${policy}${offer} RingBack will not invent a price or claim a technician is on the way.`.trim();
    }
    case "human_requested":
      return "Of course - I'm alerting someone now and they'll reach out shortly.";
    case "callback_requested":
      return `${hi}I've asked the team to call you back${business.hours ? ` during ${business.hours}` : ""}. If now is good, reply with the best number.`.trim();
    case "angry":
      return "I'm sorry about that - I'm getting the owner to call you personally.";
    case "high_value":
      return `${hi}I've alerted the team so they can give this the attention it needs.`;
    case "collected":
    default: {
      const answer = answerFromConfig(intent, qualification, business);
      const question = nextQuestion(qualification, business);
      const parts = [answer, question].filter(Boolean);
      if (!parts.length) return `${hi}thanks - I've got that. Anything else you need?`.trim();
      return `${who ? `${who}, ` : ""}${parts.join(" ")}`.trim();
    }
  }
}

function stageFor(state, qualification, business, opts = {}) {
  if (opts.booked) return "booked";
  if (opts.doNotContact) return "do_not_contact";
  if (opts.unqualified) return "unqualified";
  if (state === "booking") return "booking_requested";
  if (isReadyToBook(qualification, business)) return "qualified";
  if (qualification.service) return "qualified";
  if (opts.turnCount > 0) return "engaged";
  return "contacted";
}

// The single decision function. Pure: no storage, no side effects, fully
// testable. conversation.js applies the decision.
export function decide(context = {}) {
  const {
    conversation = {},
    qualification = {},
    message = "",
    business = {},
    meta = {},
  } = context;

  const text = String(message || "").trim();
  const turnCount = Number(conversation.turnCount) || 0;
  const state = conversation.state || "greeting";
  const initial = !text;
  const extracted = extractInfo(text, business);
  const intent = initial ? "general" : classifyIntent(text);
  const severity = initial ? "normal" : classifySeverity(text);
  const urgent = severity === "urgent" || severity === "emergency";
  const merged = mergeQualification(qualification, { ...extracted, severity });
  const faqAnswer = initial ? "" : matchFaq(business, text);

  const emergencyKeywords = business.emergency?.keywords || [];
  const ready = isReadyToBook(merged, business);

  const estimatedValue = estimateValue(merged, business);
  const escalation = evaluateEscalation({
    business,
    extracted,
    qualification: merged,
    intent,
    urgent,
    severity,
    turnCount,
    estimatedValue,
    readyToBook: ready,
    emergencyKeywords,
  });

  const base = {
    engine: RECEPTIONIST_VERSION,
    promptVersion: PROMPT_VERSION,
    intent,
    severity,
    urgent: urgent || escalation.reason === "emergency",
    extracted,
    qualification: merged,
    estimatedValue,
    slots: [],
    escalation: escalation.escalate ? escalation : null,
    outcomes: [],
  };

  // 1) Do not contact wins over everything.
  if (extracted.wantsHelp) {
    return {
      ...base,
      reply: composeReply({ kind: "help", business, qualification: merged }),
      nextState: conversation.state || "waiting_for_customer",
      action: "answer",
      stage: stageFor(state, merged, business, { turnCount }),
      outcomes: ["answer"],
    };
  }
  if (extracted.doNotContact) {
    return {
      ...base,
      reply: composeReply({ kind: "opt_out", business, qualification: merged }),
      nextState: "completed",
      action: "unqualified",
      stage: "do_not_contact",
      stopFollowUp: true,
      doNotContact: true,
      outcomes: ["unqualified"],
    };
  }

  // 2) Offered -> selected -> confirmed. A numbered choice is not a booking.
  const proposed = Array.isArray(conversation.proposedSlots) ? conversation.proposedSlots : [];
  const previouslySelected = conversation.selectedSlot || null;
  if (state === "booking" && proposed.length) {
    const chosen = parseSlotChoice(text, proposed);
    if (isConfirmation(text)) {
      const slot = previouslySelected || chosen;
      if (!slot) {
        return {
          ...base,
          reply: "We couldn't confirm that appointment. Reply with 1, 2, or 3 to pick a time. A team member will follow up if this keeps failing.",
          nextState: "booking",
          action: "collect",
          stage: "booking_requested",
          bookingFailed: true,
          bookingState: "offered",
          slots: proposed,
          outcomes: ["collect"],
        };
      }
      return {
        ...base,
        reply: composeReply({ kind: "booking_confirmed", business, qualification: merged, slot }),
        nextState: "completed",
        action: "book",
        stage: "booked",
        slot,
        bookingState: "confirmed",
        stopFollowUp: true,
        outcomes: ["book"],
      };
    }
    if (chosen) {
      return {
        ...base,
        reply: composeReply({ kind: "booking_selected", business, qualification: merged, slot: chosen }),
        nextState: "booking",
        action: "collect",
        stage: "booking_requested",
        slot: chosen,
        slots: proposed,
        bookingState: "selected",
        stopFollowUp: false,
        outcomes: ["collect"],
      };
    }
    if (isDecline(text)) {
      return {
        ...base,
        reply: composeReply({ kind: "declined", business, qualification: merged, intent }),
        nextState: "waiting_for_customer",
        action: "follow_up",
        stage: stageFor(state, merged, business, { turnCount }),
        bookingState: "offered",
        outcomes: ["follow_up"],
      };
    }
  }

  // 3) Escalations that need a human now. Emergency uses shop policy. Urgent does not.
  if (escalation.escalate && escalation.priority === "high") {
    const slots = escalation.reason === "emergency" ? proposeSlots(business, { count: 2 }) : [];
    const kind =
      escalation.reason === "emergency" ? "emergency" :
      escalation.reason === "angry_customer" ? "angry" :
      escalation.reason === "human_requested" ? "human_requested" :
      escalation.reason === "callback_requested" ? "callback_requested" : "high_value";
    return {
      ...base,
      reply: composeReply({ kind, business, qualification: merged, intent, slots, slot: null, escalation }),
      nextState: escalation.reason === "human_requested" ? "escalated" : "waiting_for_customer",
      action: escalation.reason === "callback_requested" ? "callback" : "escalate",
      stage: stageFor(state, merged, business, { turnCount }),
      slots,
      bookingState: escalation.reason === "emergency" && slots.length ? "offered" : (conversation.bookingState || "available"),
      stopFollowUp: false,
      outcomes: ["escalate"],
    };
  }

  const coverage = inServiceArea(merged.area || merged.address, business);
  if (coverage.known && coverage.inside === false) {
    return {
      ...base,
      reply: `We serve ${business.serviceArea}. ${merged.area || merged.address} looks outside that area — I will confirm with the owner rather than book it.`,
      nextState: "completed",
      action: "unqualified",
      stage: "unqualified",
      lostReason: "outside_area",
      stopFollowUp: true,
      outcomes: ["unqualified"],
    };
  }

  // 4) Ready to book -> offer real slots.
  if (ready) {
    const slots = proposeSlots(business, { count: 3 });
    return {
      ...base,
      reply: composeReply({ kind: "booking_offer", business, qualification: merged, slots, intent }),
      nextState: "booking",
      action: "book",
      stage: "booking_requested",
      bookingState: "offered",
      slots,
      outcomes: ["qualify", "book"],
    };
  }

  // 5) Otherwise answer what we can and ask the next question.
  const slots = [];
  const replyKind = initial ? (meta.channel === "missed_call" ? "missed_call" : "greeting") : "collected";
  const outcomes = initial ? ["answer", "collect"] : ["answer", "collect"];
  const unknownService = !initial && !merged.service && ["repair", "price", "booking"].includes(intent);
  const collected = composeReply({ kind: replyKind, business, qualification: merged, intent, slots });
  const reply = !initial && faqAnswer && !collected.includes(faqAnswer)
    ? `${faqAnswer} ${collected}`.trim()
    : collected;
  const urgentKind = !initial && severity === "urgent" && !ready ? "urgent" : replyKind;
  const urgentReply = urgentKind === "urgent"
    ? composeReply({ kind: "urgent", business, qualification: merged, intent, slots })
    : reply;
  return {
    ...base,
    reply: urgentKind === "urgent" ? urgentReply : reply,
    nextState: initial ? "waiting_for_customer" : "collecting_details",
    action: "collect",
    stage: stageFor(state, merged, business, { turnCount }),
    slots,
    bookingState: conversation.bookingState || "available",
    escalation: escalation.escalate ? escalation : null,
    unknownService,
    outcomes,
  };
}

export function estimateValue(qualification = {}, business = {}) {
  return explainLeadValue(qualification, business).amount;
}

export function explainLeadValue(qualification = {}, business = {}) {
  const services = Array.isArray(business.services) ? business.services : [];
  const match = services.find((s) => s.name && s.name === qualification.service);
  let jobValue = null;
  let source = "default_job_value";
  if (match && typeof match.startingPrice === "number") {
    jobValue = match.startingPrice;
    source = "configured_service";
  } else {
    const anyPrice = startingPriceFor(business, qualification.service);
    if (typeof anyPrice === "number") {
      jobValue = anyPrice;
      source = "configured_starting_price";
    } else {
      jobValue = Number(business.defaultJobValue) || 450;
      source = "default_job_value";
    }
  }
  const close = Number.isFinite(Number(business.defaultCloseRate))
    ? Math.max(0, Math.min(1, Number(business.defaultCloseRate)))
    : null;
  const amount = close == null ? jobValue : Math.round(jobValue * close);
  const formula = close == null
    ? "configured starting / job value (no close rate applied)"
    : "average_job_value × estimated_close_probability";
  return {
    amount,
    jobValue,
    closeProbability: close,
    service: qualification.service || null,
    source,
    label: "ESTIMATED",
    status: "Estimated — not verified revenue.",
    formula,
    steps: [
      { name: "service", result: qualification.service || "unknown" },
      { name: "average_job_value", result: jobValue, source },
      { name: "estimated_close_probability", result: close == null ? "not applied" : close },
      { name: "estimated_lead_value", formula: close == null ? `$${jobValue}` : `$${jobValue} × ${close}`, result: amount },
    ],
  };
}
