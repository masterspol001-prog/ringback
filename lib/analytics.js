import { engine } from "./db.js";

export const FUNNEL_EVENTS = [
  "page_view",
  "demo_start",
  "demo_complete",
  "cta_click",
  "calculator_used",
  "trial_start",
  "setup_request",
  "number_connected",
  "lead_recovered",
  "booking",
  "paid_conversion",
  "referral_sent",
];

const ALLOWED = new Set(FUNNEL_EVENTS);

function eventId() {
  return `funnel_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function trackEvent(params = {}) {
  const type = String(params.type || params.event || "").trim().toLowerCase();
  if (!ALLOWED.has(type)) return { ok: false, error: "unknown_event" };
  const record = {
    id: eventId(),
    businessId: String(params.businessId || "site").slice(0, 80),
    type,
    source: String(params.source || "web").slice(0, 40),
    path: String(params.path || "").slice(0, 160),
    label: String(params.label || "").slice(0, 80),
    createdAt: new Date().toISOString(),
  };
  engine.putDocument("analytics_events", record);
  return { ok: true, event: { id: record.id, type: record.type, createdAt: record.createdAt } };
}

export function listEvents({ businessId, limit = 200 } = {}) {
  return engine.listDocuments("analytics_events", { businessId, order: "desc", limit });
}

export function funnelSummary(businessId) {
  const events = engine.listDocuments("analytics_events", { businessId, order: "asc", limit: 5000 });
  const counts = {};
  for (const name of FUNNEL_EVENTS) counts[name] = 0;
  for (const e of events) {
    if (counts[e.type] !== undefined) counts[e.type] += 1;
  }
  const visitors = counts.page_view;
  const trials = counts.trial_start + counts.setup_request;
  const paid = counts.paid_conversion;
  return {
    counts,
    demoCompletionRate: counts.demo_start ? Number(((counts.demo_complete / counts.demo_start) * 100).toFixed(1)) : 0,
    trialRate: visitors ? Number(((trials / visitors) * 100).toFixed(1)) : 0,
    paidRate: trials ? Number(((paid / trials) * 100).toFixed(1)) : 0,
  };
}
