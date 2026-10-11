// Business configuration.
//
// One normalized shape for everything the receptionist needs to know: services,
// hours, service area, emergency policy, starting prices, booking rules,
// notification contacts, and follow-up behaviour. Onboarding and settings write
// it, reception/booking/AI read it.
//
// Pricing rule: starting prices only ever come from this config. The AI is not
// allowed to invent a number, and validation rejects any draft that does.

export const TRADES = [
  "plumbing",
  "hvac",
  "electrical",
  "cleaning",
  "roofing",
  "appliance repair",
  "locksmith",
  "auto repair",
  "landscaping",
  "pest control",
  "dental",
  "medical",
  "medspa",
  "real estate",
  "other",
];

export const TRADE_ALIASES = {
  "dental clinic": "dental",
  "dental / clinic": "dental",
  "dental care": "dental",
  clinic: "medical",
  "medical clinic": "medical",
  "med spa": "medspa",
  "med-spa": "medspa",
  contractor: "other",
  "general contractor": "other",
  "home services": "other",
};

export const CLINIC_TRADES = new Set(["dental", "medical", "medspa"]);

export const DEFAULT_FAQS = {
  hvac: [
    { q: "Do you offer financing?", a: "Yes, we can look at payment options on replacements and larger jobs." },
    { q: "Do you charge a diagnostic fee?", a: "Ask the team to confirm the current diagnostic fee before quoting one." },
  ],
  plumbing: [
    { q: "Do you handle emergencies?", a: "Burst pipes and sewage backups are treated as emergencies when that service is offered." },
    { q: "Are you licensed?", a: "Yes, the team is licensed for the work we take on." },
  ],
  electrical: [
    { q: "Do you handle emergencies?", a: "Sparking, burning smell, or no power to the house is treated as urgent." },
    { q: "Are you licensed?", a: "Yes, electrical work is done by licensed electricians." },
  ],
  dental: [
    { q: "Do you take new patients?", a: "Yes, new patients are welcome. We can book an exam once we know the visit type." },
    { q: "Do you accept insurance?", a: "Bring your insurance card to the visit and the front desk will check benefits. We do not quote coverage over text." },
    { q: "Do you see emergencies?", a: "Tooth pain, swelling, or a broken tooth can be flagged as urgent so the team can call you back." },
  ],
  medical: [
    { q: "Do you take new patients?", a: "Yes. Tell us if you are new or existing and what the visit is for." },
    { q: "Do you accept insurance?", a: "Bring your insurance card. We confirm benefits at the visit and do not quote coverage over text." },
  ],
  medspa: [
    { q: "Do I need a consult first?", a: "Most first-time treatments start with a consult so the provider can confirm you are a fit." },
    { q: "Do you take walk-ins?", a: "Appointments are preferred. Reply with a time that works and we will hold a slot." },
  ],
};

export function isClinicTrade(trade) {
  return CLINIC_TRADES.has(normalizeTrade(trade));
}

export const DEFAULT_SERVICES = {
  plumbing: ["Drain cleaning", "Water heater repair", "Leak repair", "Toilet repair", "Sewer line", "Repipe"],
  hvac: ["AC repair", "Furnace repair", "AC installation", "Maintenance tune-up", "Duct cleaning"],
  electrical: ["Panel upgrade", "Outlet or switch repair", "Lighting install", "EV charger install", "Wiring repair"],
  cleaning: ["Deep clean", "Recurring clean", "Move-out clean", "Carpet cleaning", "Office clean"],
  roofing: ["Roof repair", "Roof replacement", "Storm damage inspection", "Gutter repair"],
  "appliance repair": ["Refrigerator repair", "Washer repair", "Dryer repair", "Oven repair", "Dishwasher repair"],
  locksmith: ["Lockout", "Rekey", "Lock install", "Car lockout"],
  "auto repair": ["Brake repair", "Diagnostics", "Oil change", "Battery replacement", "AC service"],
  landscaping: ["Lawn care", "Landscape design", "Tree trimming", "Irrigation repair"],
  "pest control": ["General pest", "Termite inspection", "Rodent control", "Bed bugs"],
  dental: ["New patient exam", "Cleaning", "Emergency visit", "Whitening"],
  medical: ["New patient visit", "Follow-up", "Sick visit", "Annual physical"],
  medspa: ["Consult", "Facial", "Laser", "Injectables"],
  "real estate": ["Home valuation", "Buyer showing", "Listing consultation"],
  other: ["Service call", "Estimate"],
};

// Trades that normally run emergency or after-hours service.
const EMERGENCY_TRADES = new Set(["plumbing", "hvac", "electrical", "locksmith", "roofing", "appliance repair", "auto repair"]);

const DEFAULT_SLOT_TIMES = ["09:00", "13:00", "16:00"];

export function defaultServicesFor(trade) {
  const key = String(trade || "").toLowerCase();
  return (DEFAULT_SERVICES[key] || DEFAULT_SERVICES.other).slice();
}

export function normalizeTrade(trade) {
  const key = String(trade || "").toLowerCase().trim();
  if (TRADES.includes(key)) return key;
  if (TRADE_ALIASES[key]) return TRADE_ALIASES[key];
  return "other";
}

// Produces a complete, safe config from a possibly partial one.
export function normalizeBusiness(raw = {}) {
  const trade = normalizeTrade(raw.trade || "other");
  const emergencyAvailable =
    raw.emergency && typeof raw.emergency.available === "boolean"
      ? raw.emergency.available
      : EMERGENCY_TRADES.has(trade);

  const services = Array.isArray(raw.services) && raw.services.length
    ? raw.services
        .map((s) => (typeof s === "string" ? { name: s, startingPrice: null } : {
          name: String(s?.name || "").slice(0, 80),
          startingPrice: typeof s?.startingPrice === "number" ? s.startingPrice : null,
        }))
        .filter((s) => s.name)
    : defaultServicesFor(trade).map((name) => ({ name, startingPrice: null }));

  const startingPrices = {};
  for (const svc of services) {
    if (typeof svc.startingPrice === "number") startingPrices[svc.name] = svc.startingPrice;
  }
  if (raw.pricing && typeof raw.pricing.startingPrices === "object" && raw.pricing.startingPrices) {
    for (const [key, value] of Object.entries(raw.pricing.startingPrices)) {
      if (typeof value === "number") startingPrices[key] = value;
    }
  }

  const calendar = raw.calendar && typeof raw.calendar === "object" ? raw.calendar : {};
  const days = Array.isArray(calendar.days) && calendar.days.length
    ? calendar.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [1, 2, 3, 4, 5, 6];
  const times = Array.isArray(calendar.times) && calendar.times.length
    ? calendar.times.filter((t) => /^\d{1,2}:\d{2}$/.test(String(t))).map(String)
    : DEFAULT_SLOT_TIMES.slice();

  const bookingRules = raw.bookingRules && typeof raw.bookingRules === "object" ? raw.bookingRules : {};
  const clinic = CLINIC_TRADES.has(trade);
  const followUp = raw.followUp && typeof raw.followUp === "object" ? raw.followUp : {};
  const notifications = raw.notifications && typeof raw.notifications === "object" ? raw.notifications : {};

  return {
    id: raw.id || "demo",
    name: String(raw.name || "Your Business").slice(0, 120),
    trade: raw.trade || trade,
    tradeKey: trade,
    serviceArea: String(raw.serviceArea || "").slice(0, 160),
    bookingUrl: String(raw.bookingUrl || "").slice(0, 300),
    phone: String(raw.phone || "").slice(0, 40),
    email: String(raw.email || "").slice(0, 160),
    hours: String(raw.hours || "").slice(0, 160),
    timeZone: String(raw.timeZone || raw.timezone || "").slice(0, 80),
    offer: String(raw.offer || "").slice(0, 200),
    customInstructions: String(raw.customInstructions || "").slice(0, 1000),
    faqs: (Array.isArray(raw.faqs) ? raw.faqs : DEFAULT_FAQS[trade] || []).slice(0, 30).map((f) => ({
      q: String(f?.q || f?.question || "").slice(0, 200),
      a: String(f?.a || f?.answer || "").slice(0, 400),
    })).filter((f) => f.q && f.a),
    services,
    pricing: {
      startingPrices,
      currency: String(raw.pricing?.currency || "USD").slice(0, 8).toUpperCase(),
      quoteRequired: raw.pricing?.quoteRequired !== false,
    },
    emergency: {
      available: emergencyAvailable,
      policy: String(raw.emergency?.policy || "").slice(0, 300),
      keywords: Array.isArray(raw.emergency?.keywords) ? raw.emergency.keywords.map(String).slice(0, 30) : [],
    },
    bookingRules: {
      requireService: bookingRules.requireService !== false,
      requireArea: bookingRules.requireArea !== undefined ? bookingRules.requireArea !== false : !clinic,
      requireTiming: bookingRules.requireTiming !== false,
      leadTimeHours: Number.isFinite(Number(bookingRules.leadTimeHours)) ? Math.max(0, Number(bookingRules.leadTimeHours)) : 2,
      daysAhead: Number.isFinite(Number(bookingRules.daysAhead)) ? Math.min(30, Math.max(1, Number(bookingRules.daysAhead))) : 7,
    },
    calendar: { days, open: String(calendar.open || "08:00"), close: String(calendar.close || "18:00"), times },
    followUp: {
      enabled: followUp.enabled !== false,
      steps: Array.isArray(followUp.steps) && followUp.steps.length
        ? followUp.steps.slice(0, 5).map((s) => ({
          delayHours: Number(s?.delayHours) >= 0 ? Number(s.delayHours) : 4,
          text: String(s?.text || "").slice(0, 500),
        }))
        : null,
    },
    notifications: {
      email: String(notifications.email || raw.email || "").slice(0, 160),
      phone: String(notifications.phone || raw.phone || "").slice(0, 40),
      onHotLead: notifications.onHotLead !== false,
    },
    quietHours: {
      enabled: raw.quietHours?.enabled !== false,
      startMin: Number.isFinite(Number(raw.quietHours?.startMin)) ? Number(raw.quietHours.startMin) : 21 * 60,
      endMin: Number.isFinite(Number(raw.quietHours?.endMin)) ? Number(raw.quietHours.endMin) : 8 * 60,
    },
    ai: {
      enabled: raw.ai?.enabled !== false,
      tone: String(raw.ai?.tone || "warm, brief, professional").slice(0, 80),
    },
  };
}

export function activationChecklist(raw = {}) {
  const b = raw && typeof raw === "object" ? raw : {};
  const name = String(b.name || "").trim();
  const sender = String(b.senderIdentity || b.name || "").trim();
  const services = Array.isArray(b.services) ? b.services.filter((s) => (typeof s === "string" ? s.trim() : s?.name)) : [];
  const serviceArea = String(b.serviceArea || "").trim();
  const hours = String(b.hours || "").trim();
  const emergencyPolicy = String(b.emergency?.policy || "").trim();
  const escalation = String(b.notifications?.phone || b.phone || "").trim();
  const bookingRules = b.bookingRules && typeof b.bookingRules === "object";
  const calendarProvider = Boolean(b.calendar?.provider);
  const playbook = Array.isArray(b.faqs) && b.faqs.length > 0 || Boolean(String(b.customInstructions || "").trim());
  const followUp = b.followUp && b.followUp.enabled !== false;
  const items = [
    { id: "name", label: "Business name", ok: Boolean(name) && name !== "Your Business" },
    { id: "sender", label: "Sender identity", ok: Boolean(sender) && sender !== "Your Business" },
    { id: "services", label: "Services", ok: services.length > 0 },
    { id: "serviceArea", label: "Service area", ok: Boolean(serviceArea) },
    { id: "hours", label: "Business hours", ok: Boolean(hours) },
    { id: "emergency", label: "Emergency policy", ok: Boolean(emergencyPolicy) },
    { id: "escalation", label: "Escalation contact", ok: Boolean(escalation) },
    { id: "bookingRules", label: "Booking rules", ok: Boolean(bookingRules) },
    { id: "calendar", label: "Calendar", ok: calendarProvider },
    { id: "playbook", label: "Approved messaging / playbook", ok: Boolean(playbook) },
    { id: "followUp", label: "Follow-up sequence", ok: Boolean(followUp) },
  ];
  const missing = items.filter((i) => !i.ok).map((i) => i.id);
  return {
    ready: missing.length === 0,
    missing,
    items,
    note: missing.length
      ? "Live SMS stays off until these are configured. RingBack will not invent a policy."
      : "Configured. Live send still requires Twilio.",
  };
}

export function startingPriceFor(business, serviceName) {
  const prices = business?.pricing?.startingPrices || {};
  if (serviceName && prices[serviceName] !== undefined) return prices[serviceName];
  const keys = Object.keys(prices);
  return keys.length ? prices[keys[0]] : null;
}

export function currencySymbol(currency) {
  return currency === "INR" ? "Rs " : currency === "EUR" ? "EUR " : "$";
}

export function businessSummary(business) {
  const b = business || {};
  const lines = [`Business: ${b.name} (${b.trade}).`];
  if (b.serviceArea) lines.push(`Service area: ${b.serviceArea}.`);
  if (b.hours) lines.push(`Hours: ${b.hours}.`);
  if (b.services?.length) lines.push(`Services: ${b.services.map((s) => s.name).join(", ")}.`);
  const prices = Object.entries(b.pricing?.startingPrices || {});
  if (prices.length) {
    lines.push(`Starting prices (you may quote these exactly, nothing else): ${prices.map(([k, v]) => `${k} from ${currencySymbol(b.pricing.currency)}${v}`).join("; ")}.`);
  } else {
    lines.push("No prices are configured. Never state a price or a range; say you need a few details and the team will give an exact quote.");
  }
  if (b.emergency?.available) {
    lines.push(`Emergency service: available.${b.emergency.policy ? ` Policy: ${b.emergency.policy}` : ""}`);
  } else {
    lines.push("Emergency service: not offered. Do not promise same-day or after-hours emergency work.");
  }
  if (b.bookingUrl) lines.push(`Booking link: ${b.bookingUrl}.`);
  if (b.offer) lines.push(`Current offer: ${b.offer}.`);
  if (b.faqs?.length) {
    lines.push(`Approved FAQs (answer only from these): ${b.faqs.map((f) => `Q: ${f.q} A: ${f.a}`).join(" | ")}`);
  }
  if (b.customInstructions) lines.push(`Owner instructions: ${b.customInstructions}`);
  return lines.join("\n");
}
