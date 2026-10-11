const DEFAULT_BUSINESS = {
  id: "demo",
  name: "Northwind Heating & Air",
  trade: "HVAC",
  serviceArea: "Austin, TX",
  bookingUrl: "https://cal.com/northwind/service-call",
  phone: "+1 (512) 555-0142",
  hours: "Mon-Sat, 7am-7pm",
  offer: "free estimate on replacements",
};

export const CHANNELS = [
  { id: "missed_call", label: "Missed call", kind: "voice", note: "Text back within seconds when a call goes unanswered." },
  { id: "sms", label: "SMS", kind: "text", note: "Two-way texting on your existing business number." },
  { id: "whatsapp", label: "WhatsApp", kind: "text", note: "Reply to WhatsApp inquiries and click-to-chat ads." },
  { id: "facebook", label: "Facebook Messenger", kind: "social", note: "Answer Page messages and lead-ad submissions." },
  { id: "instagram", label: "Instagram DM", kind: "social", note: "Catch DMs from posts, reels, and profile taps." },
  { id: "google_ads", label: "Google Ads leads", kind: "ads", note: "Instant response to lead-form submissions." },
  { id: "webchat", label: "Website chat", kind: "web", note: "Answer your site visitors while you're on the job." },
  { id: "web_form", label: "Website form", kind: "web", note: "Auto-respond to contact and quote forms." },
  { id: "email", label: "Email", kind: "text", note: "Reply to inquiry emails with the same playbook." },
];

const CHANNEL_IDS = new Set(CHANNELS.map((c) => c.id));

export function normalizeChannel(channel) {
  const c = String(channel || "sms").toLowerCase();
  return CHANNEL_IDS.has(c) ? c : "sms";
}

export function channelLabel(channel) {
  const found = CHANNELS.find((c) => c.id === normalizeChannel(channel));
  return found ? found.label : "SMS";
}

const INTENTS = [
  {
    id: "emergency",
    words: ["emergency", "gas leak", "smell gas", "no heat", "no ac", "flood", "burst", "sparking", "burning smell", "can't breathe"],
  },
  {
    id: "repair",
    words: ["repair", "fix", "broken", "not working", "stopped working", "leak", "clog", "no cool", "won't start"],
  },
  {
    id: "install",
    words: ["install", "installation", "replace", "replacement", "new unit", "new system"],
  },
  {
    id: "price",
    words: ["price", "pricing", "cost", "how much", "quote", "estimate", "rate", "fee", "charge"],
  },
  {
    id: "availability",
    words: ["available", "availability", "today", "tomorrow", "asap", "urgent", "when can", "how soon", "now"],
  },
  {
    id: "booking",
    words: ["book", "schedule", "appointment", "slot", "come out", "send someone", "visit"],
  },
  {
    id: "existing",
    words: ["existing appointment", "already booked", "reschedule", "confirm my appointment", "running late"],
  },
  {
    id: "spam",
    words: ["seo services", "google ranking", "buy leads", "this is a recorded message"],
  },
  {
    id: "service_area",
    words: ["do you serve", "service area", "cover", "near me", "around", "travel to", "in my area"],
  },
  {
    id: "hours",
    words: ["open", "hours", "weekend", "sunday", "after hours", "closed"],
  },
  {
    id: "finance",
    words: ["financing", "payment plan", "installment", "credit", "monthly payment"],
  },
  {
    id: "warranty",
    words: ["warranty", "guarantee", "insured", "licensed", "certified"],
  },
];

const EMERGENCY_RE = /(emergency|gas leak|smell gas|no heat|no water|flood|flooded|burst|sparking|burning smell|can't breathe|cannot breathe|smoke)/;
const URGENT_RE = /(urgent|asap|right now|no ac|no cool|leak|leaking|broken|can't wait|toothache|tooth pain|swelling|broken tooth|tonight)/;

export function classifySeverity(text = "") {
  const t = String(text || "").toLowerCase();
  if (EMERGENCY_RE.test(t)) return "emergency";
  if (URGENT_RE.test(t)) return "urgent";
  return "normal";
}

export function isUrgent(text = "") {
  const level = classifySeverity(text);
  return level === "urgent" || level === "emergency";
}

export function isEmergency(text = "") {
  return classifySeverity(text) === "emergency";
}

export function classifyIntent(text = "") {
  const t = String(text).toLowerCase();
  let best = { id: "general", score: 0 };
  for (const intent of INTENTS) {
    let score = 0;
    for (const w of intent.words) {
      if (t.includes(w)) score += 1;
    }
    if (score > best.score) best = { id: intent.id, score };
  }
  return best.id;
}

export function inServiceArea(location, business = {}) {
  const area = String(business.serviceArea || "").toLowerCase().trim();
  const loc = String(location || "").toLowerCase().trim();
  if (!area || !loc) return { known: false, inside: null, reason: area ? "Need an address to check coverage." : "No service area configured." };
  const tokens = area.split(/[,/]| and /i).map((s) => s.trim()).filter((s) => s.length > 2);
  const hit = tokens.some((t) => loc.includes(t) || t.includes(loc));
  if (hit) return { known: true, inside: true, reason: `Inside ${business.serviceArea}.` };
  if (loc.length < 4) return { known: false, inside: null, reason: "Need a city or address to check coverage." };
  return { known: true, inside: false, reason: `Does not match ${business.serviceArea}. Confirm with the owner.` };
}

function firstName(name) {
  if (!name) return "";
  const clean = String(name).trim().split(/\s+/)[0];
  return clean ? ` ${clean}` : "";
}

function greeting(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function cap(s) {
  const t = String(s || "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function quoteLine(business) {
  const area = business.serviceArea ? ` in ${business.serviceArea}` : "";
  const offer = business.offer ? ` ${cap(business.offer)}.` : "";
  return `${business.name} handles ${business.trade} work${area}.${offer}`;
}

function openingFor(channel, who, business, meta, isContinuation) {
  const ch = normalizeChannel(channel);
  if (isContinuation) {
    if (ch === "email") return `Thanks for the reply${who}.`;
    return `Thanks${who}.`;
  }
  switch (ch) {
    case "missed_call":
      return `Sorry we missed your call${who}!`;
    case "whatsapp":
      return `Hi${who}, thanks for messaging ${business.name}.`;
    case "facebook":
      return `Hi${who}, thanks for the message!`;
    case "instagram":
      return `Hi${who}, thanks for the DM!`;
    case "webchat":
      return `Hi${who}, thanks for reaching out.`;
    case "google_ads":
      return `${openingFor("sms", who, business, meta, false)} Thanks for your interest.`;
    case "email":
      return `Thanks for reaching out${who}.`;
    default:
      if (meta.channel === "missed_call") return `Sorry we missed your call${who}!`;
      return `Thanks for reaching out.`;
  }
}

// Deterministic reply engine. No LLM, no key, no hallucinated pricing.
// It acknowledges, qualifies with one question, and pushes to a booking link.
// Supports multi-turn via meta.history = [{ role: "in"|"out", text }].
export function generateReply(message, business = DEFAULT_BUSINESS, meta = {}) {
  const biz = { ...DEFAULT_BUSINESS, ...business };
  const channel = normalizeChannel(meta.channel);
  const intent = classifyIntent(message);
  const severity = classifySeverity(message);
  const urgent = severity === "urgent" || severity === "emergency";
  const who = firstName(meta.name);
  const hour = typeof meta.hour === "number" ? meta.hour : 10;
  const booking = biz.bookingUrl ? ` Book a time here: ${biz.bookingUrl}` : "";
  const history = Array.isArray(meta.history) ? meta.history : [];
  const isContinuation = history.some((h) => h && h.role === "out");

  let opening = openingFor(channel, who, biz, meta, isContinuation);
  if (urgent && !isContinuation) {
    opening += ` Flagging this as urgent.`;
  }

  const h = biz.hours || "regular business hours";
  const intents = {};

  intents.price = `${opening} ${isContinuation ? "" : quoteLine(biz) + " "}For an exact price we need 30 seconds of details. What's the job, and what part of town are you in?${booking}`;

  intents.availability = `${opening} We're open ${h}. I will not invent a same-day slot. What's the address and the best window for you?${booking}`;

  intents.booking = `${opening} Happy to get you on the schedule, ${h}.${booking} If you'd rather we call you, just reply with a good time.`;

  intents.service_area = `${opening} We serve ${biz.serviceArea || "the local area"}.${booking} Send me your address and I'll confirm we cover it.`;

  intents.hours = `${opening} We're open ${h}.${booking} If it's urgent, reply URGENT and we'll treat it as a priority.`;

  intents.finance = `${opening} Yes, we offer financing options on larger jobs. Reply with what you're looking to get done and I'll send the details.${booking}`;

  intents.warranty = `${opening} We're licensed and every job is backed by our workmanship guarantee. What can we help you with today?${booking}`;

  intents.general = `${opening} ${isContinuation ? "" : quoteLine(biz) + " "}Could you tell me a little more about what you need?${booking}`;

  let body = intents[intent] || intents.general;

  if (channel === "whatsapp") body += " (WhatsApp is fine for photos and voice notes.)";
  if (channel === "facebook" || channel === "instagram") {
    body += " (Or message us here and we'll reply right away.)";
  }
  if (channel === "webchat") body += " (We can also call you back if that's easier.)";

  const footer = channel === "webchat" || channel === "facebook" || channel === "instagram"
    ? ""
    : biz.phone
      ? ` You can also call ${biz.phone}.`
      : "";

  return {
    intent,
    severity,
    urgent,
    channel,
    channelLabel: channelLabel(channel),
    engine: "deterministic-v1",
    reply: `${body}${footer}`,
    followUp: [
      followUpStep(1, biz, who, meta),
      followUpStep(2, biz, who, meta),
      followUpStep(3, biz, who, meta),
    ],
    generatedAt: new Date().toISOString(),
  };
}

function followUpStep(step, biz, who, meta) {
  const ch = normalizeChannel(meta.channel || "sms");
  const via = ch === "whatsapp" ? "WhatsApp" : ch === "email" ? "email" : "text";
  if (step === 1) {
    return {
      delayHours: 4,
      channel: ch,
      text: `${who ? who.trim() + ", just" : "Just"} checking in. Did you still need help with ${biz.trade.toLowerCase()}? Reply YES and I'll get you a time.`,
    };
  }
  if (step === 2) {
    return {
      delayHours: 24,
      channel: ch,
      text: `Last nudge from ${biz.name} - if you still need ${biz.trade.toLowerCase()} work, here's our open slots: ${biz.bookingUrl || `reply BOOK and we'll ${via} you a time`}.`,
    };
  }
  return {
    delayHours: 72,
    channel: ch,
    text: `We'll close this out for now, but you can restart anytime by replying here. - ${biz.name}`,
  };
}

export function scoreLead(lead = {}) {
  const t = String(lead.message || "").toLowerCase();
  let score = 0;
  const reasons = [];
  const severity = String(lead.severity || lead.qualification?.severity || "").toLowerCase();
  if (severity === "emergency" || EMERGENCY_RE.test(t)) {
    score += 40;
    reasons.push("Emergency service requested");
  } else if (severity === "urgent" || lead.urgent || URGENT_RE.test(t)) {
    score += 40;
    reasons.push("Customer requested same-day or urgent service");
  }
  if (/(quote|price|estimate|cost|how much)/.test(t)) {
    score += 15;
    reasons.push("Asked for price");
  }
  if (/(book|schedule|appointment|come out|send someone)/.test(t)) {
    score += 25;
    reasons.push("Requested an appointment");
  }
  if (/(today|tonight|asap|right now)/.test(t) && !reasons.includes("Customer requested same-day or urgent service") && !reasons.includes("Emergency service requested")) {
    score += 15;
    reasons.push("Customer requested same-day service");
  }
  const loc = lead.qualification?.area || lead.qualification?.address || "";
  if (loc) {
    score += 10;
    reasons.push("Service area matched");
  }
  if (lead.phone) {
    score += 5;
    reasons.push("Valid phone number");
  }
  if (lead.source === "missed_call") {
    score += 25;
    reasons.push("Missed call captured");
  }
  score = Math.min(100, score);
  const bucket = score >= 60 ? "hot" : score >= 30 ? "warm" : "cold";
  const label = bucket === "hot" ? "Book now" : bucket === "warm" ? "Follow up" : "Low intent";
  return { score, bucket, reasons, label };
}

export const TEMPLATES = { DEFAULT_BUSINESS };
