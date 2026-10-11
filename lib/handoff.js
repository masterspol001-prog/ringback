// Human handoff and escalation.
//
// The receptionist's job is to keep the loop moving, not to be clever. When it
// detects a situation it should not handle alone, it stops and alerts a human.
// Every trigger here maps to a real failure mode observed in missed-call flows.

export const ESCALATION_REASONS = {
  emergency: { label: "emergency", priority: "high", kind: "urgent" },
  angry_customer: { label: "upset customer", priority: "high", kind: "urgent" },
  human_requested: { label: "customer asked for a person", priority: "high", kind: "handoff" },
  callback_requested: { label: "customer asked for a callback", priority: "high", kind: "handoff" },
  unusual_request: { label: "unusual or sensitive request", priority: "medium", kind: "handoff" },
  high_value: { label: "high-value opportunity", priority: "medium", kind: "opportunity" },
  unknown_pricing: { label: "pricing question we cannot answer", priority: "medium", kind: "handoff" },
  low_confidence: { label: "receptionist is unsure", priority: "medium", kind: "handoff" },
};

// Ordered by how quickly a human should respond.
const ORDER = [
  "emergency",
  "angry_customer",
  "human_requested",
  "callback_requested",
  "unusual_request",
  "high_value",
  "unknown_pricing",
  "low_confidence",
];

export function evaluateEscalation(context = {}) {
  const {
    business = {},
    extracted = {},
    qualification = {},
    intent = "general",
    urgent = false,
    severity = "",
    turnCount = 0,
    estimatedValue = 0,
    readyToBook = false,
    emergencyKeywords = [],
  } = context;

  const text = String(extracted.raw || "").toLowerCase();
  const keywordHit = emergencyKeywords.some((k) => k && text.includes(String(k).toLowerCase()));
  const triggers = {};

  const level = String(severity || "").toLowerCase();
  const isEmergency = level === "emergency" || keywordHit;
  if (isEmergency) {
    triggers.emergency = business.emergency?.available
      ? "Customer described an emergency."
      : "Customer described an emergency, but this business does not offer emergency service.";
  } else if (urgent && level === "urgent") {
    // Urgent is not an emergency. Do not invent dispatch or escalate as emergency.
  }

  if (extracted.angry) triggers.angry_customer = "Customer sounds upset.";
  if (extracted.wantsHuman) triggers.human_requested = "Customer asked for a person.";
  if (extracted.wantsCallback) triggers.callback_requested = "Customer asked to be called back.";
  if (extracted.unusual) triggers.unusual_request = "Message mentions refunds, legal, or claims.";

  const threshold = Number.isFinite(Number(business.highValueThreshold)) ? Number(business.highValueThreshold) : 1500;
  if (estimatedValue >= threshold) triggers.high_value = `Estimated job value is ${estimatedValue}.`;

  const priceIntent = intent === "price" || intent === "finance" || intent === "warranty";
  const hasService = Boolean(qualification.service);
  if (priceIntent && !hasService && turnCount >= 2) {
    triggers.unknown_pricing = "Customer is asking about price but we do not know the job yet.";
  }

  if (!readyToBook && turnCount >= 4 && !hasService && !qualification.area && !qualification.timing) {
    triggers.low_confidence = "Several turns without enough information to help.";
  }

  for (const reason of ORDER) {
    if (triggers[reason]) {
      return {
        escalate: true,
        reason,
        priority: ESCALATION_REASONS[reason].priority,
        kind: ESCALATION_REASONS[reason].kind,
        detail: triggers[reason],
      };
    }
  }
  return { escalate: false, reason: null, priority: null, kind: null, detail: null };
}

// Builds the plain-text owner alert. No emoji, no invented facts.
export function ownerPing({ business, lead, hours, qualification } = {}) {
  const who = lead?.name && lead.name !== "Unknown" ? lead.name : "A caller";
  const contact = lead?.phone || "no phone captured";
  const what = qualification?.service || lead?.message || "missed call";
  const when = hours?.label || (hours?.afterHours ? "After hours" : "During hours");
  const lines = [
    hours?.afterHours ? `AFTER HOURS missed call` : `Missed call`,
    `${who} ${contact}. ${what}. ${when}.`,
    contact !== "no phone captured" ? `Call them back: ${contact}` : "No caller number captured.",
    "RingBack did not dispatch a tech.",
  ];
  if (business?.name) lines.push(`- ${business.name}`);
  return lines.filter(Boolean).join("\n");
}

export function ownerAlert({ business, lead, escalation, qualification }) {
  const who = lead?.name && lead.name !== "Unknown" ? lead.name : "A customer";
  const contact = lead?.phone || "no phone captured";
  const what = qualification?.service || lead?.message || "service request";
  const area = qualification?.area ? ` in ${qualification.area}` : "";
  const when = qualification?.timing ? ` Timing: ${qualification.timing}.` : "";
  const lines = [];

  if (escalation?.reason === "emergency") {
    lines.push(`EMERGENCY DETECTED - owner notified`);
    lines.push(`${who} needs help${area}. Service: ${what}.${when}`);
    lines.push(`Reason: ${escalation.detail}`);
    lines.push(`Dispatcher has not confirmed. No technician is on the way.`);
  } else if (escalation?.reason === "angry_customer") {
    lines.push(`UPSET CUSTOMER - handle personally`);
    lines.push(`${who} (${contact}) is unhappy. Service: ${what}.${when}`);
  } else if (escalation?.reason === "high_value") {
    lines.push(`HIGH-VALUE LEAD`);
    lines.push(`${who} (${contact}). Service: ${what}.${when}`);
  } else {
    lines.push(`LEAD NEEDS A HUMAN - ${ESCALATION_REASONS[escalation?.reason]?.label || "handoff"}`);
    lines.push(`${who} (${contact}). Service: ${what}.${when}`);
  }
  lines.push(`Contact: ${contact}`);
  if (business?.name) lines.push(`- ${business.name} receptionist`);
  return lines.filter(Boolean).join("\n");
}
