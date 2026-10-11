import { engine, hasSqlite, dbPath, engineName, resetForTests as resetEngine } from "./db.js";
import { LEAD_STATUSES, REVENUE_STATUSES, computeMetrics, normalizeStatus, normalizeRevenueStatus } from "./lifecycle.js";

export const DEFAULT_JOB_VALUE = 450;

export { hasSqlite, dbPath, engineName, LEAD_STATUSES, REVENUE_STATUSES };

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

export function nextId(prefix) {
  const seq = engine.nextSeq();
  return `${prefix}_${seq.toString(36)}${Date.now().toString(36).slice(-4)}${randomSuffix().slice(0, 2)}`;
}

export function addLead(lead) {
  return engine.upsertLead({
    status: "new",
    notes: "",
    jobValue: null,
    followUpAt: null,
    revenueStatus: "unknown",
    followUpStatus: "active",
    ...lead,
  });
}

export function listLeads(businessId) {
  return engine.listLeads(businessId);
}

export function deleteLead(id) {
  return engine.deleteLead(id);
}

export function getLead(id) {
  return engine.getLead(id);
}

export function phoneDigits(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

const CLOSED_LEAD = new Set(["won", "lost", "unqualified", "spam", "do_not_contact"]);

export function findOpenLeadByPhone(phone, businessId) {
  const target = phoneDigits(phone);
  if (!target) return null;
  return listLeads(businessId).find((l) => phoneDigits(l.phone) === target && !CLOSED_LEAD.has(l.status)) || null;
}

export function findRecentLeadByPhone(phone, businessId, windowMs = 15 * 60 * 1000, now = Date.now()) {
  const target = phoneDigits(phone);
  if (!target) return null;
  const cutoff = now - Math.max(0, Number(windowMs) || 0);
  return listLeads(businessId).find((l) => {
    if (phoneDigits(l.phone) !== target) return false;
    const at = Date.parse(l.createdAt || l.updatedAt || "");
    return Number.isFinite(at) && at >= cutoff;
  }) || null;
}

export function updateLead(id, patch = {}) {
  const current = engine.getLead(id);
  if (!current) return null;

  const allowed = {};

  if (patch.status) {
    const status = normalizeStatus(patch.status);
    if (status) allowed.status = status;
  }
  if (patch.revenueStatus) {
    const status = normalizeRevenueStatus(patch.revenueStatus);
    if (status) allowed.revenueStatus = status;
  }
  if (typeof patch.notes === "string") allowed.notes = patch.notes.slice(0, 2000);
  if (typeof patch.lostReason === "string") allowed.lostReason = patch.lostReason.slice(0, 200);

  for (const key of ["jobValue", "estimatedValue", "confirmedRevenue"]) {
    if (patch[key] === null) allowed[key] = null;
    else if (typeof patch[key] === "number" && Number.isFinite(patch[key])) {
      allowed[key] = Math.max(0, Math.min(patch[key], 1_000_000));
    }
  }

  if (patch.followUpAt && !Number.isNaN(Date.parse(patch.followUpAt))) {
    allowed.followUpAt = new Date(patch.followUpAt).toISOString();
  } else if (patch.followUpAt === null) {
    allowed.followUpAt = null;
  }

  if (patch.qualification && typeof patch.qualification === "object") {
    allowed.qualification = sanitizeQualification(patch.qualification);
  }
  if (patch.stageAt && typeof patch.stageAt === "object") {
    allowed.stageAt = sanitizeStageAt(patch.stageAt);
  }
  for (const key of ["appointmentId", "conversationId", "customerId", "ownerLastNotifiedAt", "reply", "engine", "intent", "channel", "channelLabel", "source", "name", "phone", "message", "severity", "bookingState", "failureState", "deliveryStatus", "revenueState", "invoiceRef"]) {
    if (patch[key] === null && (key === "failureState" || key === "invoiceRef")) allowed[key] = null;
    else if (typeof patch[key] === "string") allowed[key] = patch[key].slice(0, 2000);
  }
  for (const key of ["optedOut", "doNotContact", "urgent", "demo", "afterHours"]) {
    if (typeof patch[key] === "boolean") allowed[key] = patch[key];
  }
  if (["active", "stopped", "paused"].includes(patch.followUpStatus)) allowed.followUpStatus = patch.followUpStatus;
  if (Array.isArray(patch.followUp)) allowed.followUp = patch.followUp.slice(0, 10);
  if (patch.sms && typeof patch.sms === "object") allowed.sms = patch.sms;
  if (patch.score && typeof patch.score === "object") allowed.score = patch.score;

  if (Object.keys(allowed).length === 0) return current;
  return engine.updateLead(id, { ...allowed, updatedAt: new Date().toISOString() });
}

function sanitizeQualification(raw) {
  const out = {};
  for (const key of ["name", "phone", "email", "address", "area", "service", "timing", "severity"]) {
      if (typeof raw[key] === "string") out[key] = raw[key].slice(0, 240);
    }
  if (typeof raw.budget === "number" && Number.isFinite(raw.budget)) out.budget = raw.budget;
  return out;
}

function sanitizeStageAt(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) out[key] = value;
  }
  return out;
}

export function addSetup(setup) {
  return engine.insertSetup(setup);
}

export function listSetups() {
  return engine.listSetups();
}

export function updateSetup(id, patch) {
  return engine.updateSetup(id, patch);
}

export function getBusiness(id) {
  return engine.getBusiness(id);
}

export function saveBusiness(biz) {
  return engine.saveBusiness(biz);
}

export function listBusinesses() {
  return engine.listBusinesses();
}

export function addPayment(payment) {
  return engine.insertPayment(payment);
}

export function listPayments() {
  return engine.listPayments();
}

export function stats(businessId, options = {}) {
  const leads = listLeads(businessId);
  const metrics = computeMetrics(leads);
  const planCost = Number.isFinite(Number(options.planCost)) ? Number(options.planCost) : 199;
  const recovered = metrics.recoveredRevenue;
  const verified = metrics.verifiedRevenue || 0;
  return {
    ...metrics,
    // Backward-compatible aliases used by the v1 report and dashboard.
    recovered,
    total: metrics.total,
    planCost,
    estimatedRoi: planCost > 0 ? Number((recovered / planCost).toFixed(1)) : 0,
    verifiedRoi: planCost > 0 ? Number((verified / planCost).toFixed(1)) : 0,
  };
}

export function toCsv(businessId) {
  const leads = listLeads(businessId);
  const cols = [
    "id", "createdAt", "status", "bucket", "score", "intent", "source", "channel",
    "name", "phone", "message", "reply", "jobValue", "notes", "revenueStatus", "estimatedValue", "confirmedRevenue", "lostReason",
  ];
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = leads.map((l) => [
    l.id, l.createdAt, l.status || "new", l.revenueStatus || "unknown", l.score?.bucket || "", l.score?.score ?? "",
    l.intent || "", l.source || "", l.channel || "", l.name || "", l.phone || "",
    l.estimatedValue ?? "", l.confirmedRevenue ?? "", l.message || "", l.reply || "", l.jobValue ?? "",
    l.lostReason || "", l.notes || "",
  ].map(esc).join(","));
  return [cols.join(","), ...rows].join("\n");
}

export function resetForTests() {
  resetEngine();
}

export const DB_FILE_PATH = dbPath();
