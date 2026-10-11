// Typed domain entities for the recovery engine.
//
// Everything here is a thin, validated wrapper over the generic document store
// in lib/db.js. Keeping the entity shapes in one file means the SQLite engine
// and the JSON fallback can never drift, and the rest of the app never touches
// storage directly.

import { engine } from "./db.js";
import { nextId } from "./store.js";

export const CONVERSATION_STATES = [
  "greeting",
  "understanding_problem",
  "qualifying",
  "collecting_details",
  "booking",
  "waiting_for_customer",
  "escalated",
  "paused",
  "completed",
];

export const APPOINTMENT_STATUSES = ["requested", "proposed", "offered", "selected", "confirmed", "cancelled", "completed"];

export const MESSAGE_STATUSES = ["sent", "simulated", "failed", "pending", "not_configured", "received", "delivered", "undelivered"];

export const JOB_STATUSES = ["pending", "sent", "cancelled", "skipped"];

export const NOTIFICATION_STATUSES = ["unread", "read"];

function nowIso() {
  return new Date().toISOString();
}

function clean(value, max = 500) {
  return value === null || value === undefined ? "" : String(value).trim().slice(0, max);
}

function normalizePhone(phone) {
  return clean(phone, 40).replace(/[^\d+]/g, "");
}

// ---------------------------------------------------------------- customers

export function findCustomer(businessId, { phone, email } = {}) {
  const targetPhone = normalizePhone(phone);
  const targetEmail = clean(email, 160).toLowerCase();
  const all = engine.listDocuments("customers", { businessId, order: "asc" });
  if (targetPhone) {
    const byPhone = all.find((c) => normalizePhone(c.phone) === targetPhone);
    if (byPhone) return byPhone;
  }
  if (targetEmail) {
    const byEmail = all.find((c) => clean(c.email, 160).toLowerCase() === targetEmail);
    if (byEmail) return byEmail;
  }
  return null;
}

export function findOrCreateCustomer(businessId, params = {}) {
  const existing = findCustomer(businessId, params);
  if (existing) {
    const patch = {};
    if (!existing.name && params.name) patch.name = clean(params.name, 120);
    if (!existing.email && params.email) patch.email = clean(params.email, 160);
    if (!existing.address && params.address) patch.address = clean(params.address, 240);
    if (Object.keys(patch).length) {
      return engine.putDocument("customers", { ...existing, ...patch, updatedAt: nowIso() });
    }
    return existing;
  }
  const customer = {
    id: nextId("cust"),
    businessId,
    name: clean(params.name, 120),
    phone: clean(params.phone, 40),
    email: clean(params.email, 160),
    address: clean(params.address, 240),
    optedOut: false,
    doNotContact: false,
    tags: [],
    createdAt: nowIso(),
    updatedAt: null,
  };
  return engine.putDocument("customers", customer);
}

export function updateCustomer(id, patch = {}) {
  const current = engine.getDocument("customers", id);
  if (!current) return null;
  const allowed = {};
  for (const key of ["name", "phone", "email", "address"]) {
    if (typeof patch[key] === "string") allowed[key] = clean(patch[key], 240);
  }
  if (typeof patch.optedOut === "boolean") allowed.optedOut = patch.optedOut;
  if (typeof patch.doNotContact === "boolean") allowed.doNotContact = patch.doNotContact;
  if (Array.isArray(patch.tags)) allowed.tags = patch.tags.slice(0, 20).map((t) => clean(t, 40));
  return engine.putDocument("customers", { ...current, ...allowed, updatedAt: nowIso() });
}

export function getCustomer(id) {
  return engine.getDocument("customers", id);
}

export function listCustomers(businessId, limit = 500) {
  return engine.listDocuments("customers", { businessId, order: "desc", limit });
}

// ---------------------------------------------------------------- conversations

export function createConversation({ businessId, leadId, customerId, channel, state = "greeting" }) {
  const at = nowIso();
  const conversation = {
    id: nextId("conv"),
    businessId,
    leadId,
    customerId,
    channel,
    state,
    stateUpdatedAt: at,
    lastMessageAt: null,
    turnCount: 0,
    ownerMode: false,
    pausedReason: "",
    resumeState: null,
    createdAt: at,
    updatedAt: null,
  };
  return engine.putDocument("conversations", conversation);
}

export function getConversation(id) {
  return engine.getDocument("conversations", id);
}

export function getConversationByLead(leadId) {
  const all = engine.listDocuments("conversations", { order: "asc" });
  return all.find((c) => c.leadId === leadId) || null;
}

export function updateConversation(id, patch = {}) {
  const current = engine.getDocument("conversations", id);
  if (!current) return null;
  const allowed = {};
  if (CONVERSATION_STATES.includes(patch.state)) allowed.state = patch.state;
  if (typeof patch.turnCount === "number") allowed.turnCount = Math.max(0, Math.floor(patch.turnCount));
  if (typeof patch.lastMessageAt === "string") allowed.lastMessageAt = patch.lastMessageAt;
  if (patch.summary !== undefined) allowed.summary = clean(patch.summary, 600);
  if (patch.pausedReason !== undefined) allowed.pausedReason = clean(patch.pausedReason, 200);
  if (typeof patch.ownerMode === "boolean") allowed.ownerMode = patch.ownerMode;
  if (patch.resumeState !== undefined) {
    allowed.resumeState = CONVERSATION_STATES.includes(patch.resumeState) ? patch.resumeState : null;
  }
  if (CONVERSATION_STATES.includes(patch.state) && patch.state !== current.state) {
    allowed.stateUpdatedAt = nowIso();
  }
  if (Array.isArray(patch.proposedSlots)) {
    allowed.proposedSlots = patch.proposedSlots.slice(0, 6).map((s) => ({
      date: clean(s?.date, 20),
      time: clean(s?.time, 10),
      weekday: Number.isInteger(s?.weekday) ? s.weekday : null,
      label: clean(s?.label, 80),
    }));
  }
  if (patch.selectedSlot && typeof patch.selectedSlot === "object") {
    allowed.selectedSlot = {
      date: clean(patch.selectedSlot.date, 20),
      time: clean(patch.selectedSlot.time, 10),
      weekday: Number.isInteger(patch.selectedSlot.weekday) ? patch.selectedSlot.weekday : null,
      label: clean(patch.selectedSlot.label, 80),
    };
  }
  if (typeof patch.bookingState === "string") allowed.bookingState = clean(patch.bookingState, 40);
  return engine.putDocument("conversations", { ...current, ...allowed, updatedAt: nowIso() });
}

export function listConversations(businessId, limit = 200) {
  return engine.listDocuments("conversations", { businessId, order: "desc", limit });
}

// ---------------------------------------------------------------- messages

export function addMessage(message) {
  const record = {
    id: nextId("msg"),
    businessId: message.businessId,
    conversationId: message.conversationId,
    leadId: message.leadId,
    direction: message.direction === "out" ? "out" : "in",
    sender: message.sender || (message.direction === "out" ? "ai" : "customer"),
    channel: message.channel || "sms",
    text: clean(message.text, 2000),
    status: MESSAGE_STATUSES.includes(message.status) ? message.status : message.direction === "in" ? "received" : "simulated",
    intent: message.intent || null,
    providerRef: message.providerRef || null,
    error: message.error ? clean(message.error, 300) : null,
    createdAt: message.createdAt || nowIso(),
    updatedAt: null,
  };
  return engine.putDocument("messages", record);
}

export function listMessages(conversationId) {
  return engine.listDocuments("messages", { order: "asc" }).filter((m) => m.conversationId === conversationId);
}

export function listLeadMessages(leadId) {
  return engine.listDocuments("messages", { order: "asc" }).filter((m) => m.leadId === leadId);
}

export function findMessageByProviderRef(providerRef) {
  const id = clean(providerRef, 120);
  if (!id) return null;
  const matches = engine.listDocuments("messages", { order: "desc", limit: 400 }).filter((m) => m.providerRef === id);
  return matches.find((m) => m.direction === "out") || matches[0] || null;
}

export function updateMessage(id, patch = {}) {
  const current = engine.getDocument("messages", id);
  if (!current) return null;
  const allowed = {};
  if (MESSAGE_STATUSES.includes(patch.status)) allowed.status = patch.status;
  if (patch.error !== undefined) allowed.error = patch.error ? clean(patch.error, 300) : null;
  return engine.putDocument("messages", { ...current, ...allowed, updatedAt: nowIso() });
}

// ---------------------------------------------------------------- notes

export function addNote({ businessId, leadId, author = "owner", text }) {
  return engine.putDocument("notes", {
    id: nextId("note"),
    businessId,
    leadId,
    author: clean(author, 80),
    text: clean(text, 2000),
    createdAt: nowIso(),
    updatedAt: null,
  });
}

export function listNotes(leadId) {
  return engine.listDocuments("notes", { order: "asc" }).filter((n) => n.leadId === leadId);
}

// ---------------------------------------------------------------- appointments

export function saveAppointment(appointment) {
  const current = appointment.id ? engine.getDocument("appointments", appointment.id) : null;
  const base = current || {
    id: nextId("appt"),
    businessId: appointment.businessId,
    leadId: appointment.leadId,
    customerId: appointment.customerId,
    service: "",
    preferredDate: "",
    preferredTime: "",
    status: "requested",
    provider: "demo",
    notes: "",
    confirmedAt: null,
    createdAt: nowIso(),
  };
  const merged = { ...base, ...appointment, id: base.id, createdAt: base.createdAt, updatedAt: nowIso() };
  if (!APPOINTMENT_STATUSES.includes(merged.status)) merged.status = "requested";
  if (merged.status === "confirmed" && !merged.confirmedAt) merged.confirmedAt = nowIso();
  return engine.putDocument("appointments", merged);
}

export function getAppointment(id) {
  return engine.getDocument("appointments", id);
}

export function listAppointments(businessId, limit = 200) {
  return engine.listDocuments("appointments", { businessId, order: "desc", limit });
}

export function listLeadAppointments(leadId) {
  return engine.listDocuments("appointments", { order: "asc" }).filter((a) => a.leadId === leadId);
}

// ---------------------------------------------------------------- events

// The event log is the audit trail and the lead timeline. Every meaningful
// thing the system does lands here.
export function recordEvent({ businessId, leadId = null, conversationId = null, type, actor = "system", summary = "", data = null }) {
  return engine.putDocument("events", {
    id: nextId("evt"),
    businessId,
    leadId,
    conversationId,
    type: clean(type, 60),
    actor: clean(actor, 40),
    summary: clean(summary, 300),
    data: data && typeof data === "object" ? data : null,
    createdAt: nowIso(),
    updatedAt: null,
  });
}

export function listEvents(options = {}) {
  const { businessId, leadId, limit = 0 } = options;
  let all = engine.listDocuments("events", { businessId, order: "asc" });
  if (leadId) all = all.filter((e) => e.leadId === leadId);
  if (limit > 0) all = all.slice(-limit);
  return all;
}

// ---------------------------------------------------------------- follow-up jobs

export function addFollowUpJob(job) {
  return engine.putDocument("follow_up_jobs", {
    id: nextId("job"),
    businessId: job.businessId,
    leadId: job.leadId,
    conversationId: job.conversationId || null,
    channel: job.channel || "sms",
    step: Number(job.step) || 1,
    text: clean(job.text, 1000),
    runAt: job.runAt || nowIso(),
    status: JOB_STATUSES.includes(job.status) ? job.status : "pending",
    reason: job.reason || null,
    attempts: Number(job.attempts) || 0,
    sentAt: null,
    createdAt: nowIso(),
    updatedAt: null,
  });
}

export function listFollowUpJobs(options = {}) {
  const { businessId, leadId, status } = options;
  let all = engine.listDocuments("follow_up_jobs", { businessId, order: "asc" });
  if (leadId) all = all.filter((j) => j.leadId === leadId);
  if (status) all = all.filter((j) => j.status === status);
  return all;
}

export function updateFollowUpJob(id, patch = {}) {
  const current = engine.getDocument("follow_up_jobs", id);
  if (!current) return null;
  const allowed = {};
  if (JOB_STATUSES.includes(patch.status)) allowed.status = patch.status;
  if (patch.reason !== undefined) allowed.reason = clean(patch.reason, 200);
  if (patch.sentAt !== undefined) allowed.sentAt = patch.sentAt;
  if (patch.runAt !== undefined) allowed.runAt = patch.runAt;
  if (typeof patch.attempts === "number") allowed.attempts = Math.max(0, Math.floor(patch.attempts));
  return engine.putDocument("follow_up_jobs", { ...current, ...allowed, updatedAt: nowIso() });
}

export function cancelFollowUpJobs(leadId, reason = "cancelled") {
  const jobs = listFollowUpJobs({ leadId }).filter((j) => j.status === "pending");
  for (const job of jobs) updateFollowUpJob(job.id, { status: "cancelled", reason });
  return jobs.length;
}

// ---------------------------------------------------------------- notifications

export function addNotification({ businessId, leadId = null, kind = "info", title, body = "" }) {
  return engine.putDocument("notifications", {
    id: nextId("notif"),
    businessId,
    leadId,
    kind: clean(kind, 40),
    title: clean(title, 200),
    body: clean(body, 1000),
    status: "unread",
    createdAt: nowIso(),
    updatedAt: null,
    readAt: null,
  });
}

export function listNotifications(businessId, limit = 50) {
  return engine.listDocuments("notifications", { businessId, order: "desc", limit });
}

export function markNotificationRead(id) {
  const current = engine.getDocument("notifications", id);
  if (!current) return null;
  return engine.putDocument("notifications", { ...current, status: "read", readAt: nowIso(), updatedAt: nowIso() });
}

// ---------------------------------------------------------------- revenue

export function addRevenueEntry(entry) {
  return engine.putDocument("revenue", {
    id: nextId("rev"),
    businessId: entry.businessId,
    leadId: entry.leadId || null,
    amount: Number(entry.amount) || 0,
    currency: clean(entry.currency || "USD", 8).toUpperCase(),
    status: ["estimated", "booked", "won", "lost"].includes(entry.status) ? entry.status : "won",
    source: clean(entry.source || "manual", 40),
    note: clean(entry.note, 400),
    invoiceRef: clean(entry.invoiceRef || entry.reference, 80),
    createdAt: nowIso(),
    updatedAt: null,
  });
}

export function listRevenue(businessId, limit = 200) {
  return engine.listDocuments("revenue", { businessId, order: "desc", limit });
}

// ---------------------------------------------------------------- integrations

const INTEGRATION_STATUSES = ["live", "simulated", "not_configured", "error"];

export function setIntegration({ businessId, provider, status, note = "" }) {
  const safe = INTEGRATION_STATUSES.includes(status) ? status : "not_configured";
  return engine.putDocument("integrations", {
    id: `${businessId}:${provider}`,
    businessId,
    provider: clean(provider, 40),
    status: safe,
    note: clean(note, 300),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
}

export function listIntegrations(businessId) {
  return engine.listDocuments("integrations", { businessId, order: "asc" });
}

// ---------------------------------------------------------------- business settings

export function saveSettings(businessId, settings) {
  const current = engine.getDocument("business_settings", businessId) || { id: businessId, businessId };
  const merged = { ...current, ...settings, id: businessId, businessId, updatedAt: nowIso(), createdAt: current.createdAt || nowIso() };
  return engine.putDocument("business_settings", merged);
}

export function getSettings(businessId) {
  return engine.getDocument("business_settings", businessId);
}

// ---------------------------------------------------------------- timeline

// Merges the event log and the message log into one chronological timeline for
// the lead detail view.
export function leadTimeline(leadId) {
  const events = listEvents({ leadId }).map((e) => ({
    kind: "event",
    id: e.id,
    type: e.type,
    actor: e.actor,
    summary: e.summary,
    data: e.data,
    at: e.createdAt,
  }));
  const messages = listLeadMessages(leadId).map((m) => ({
    kind: "message",
    id: m.id,
    direction: m.direction,
    sender: m.sender,
    channel: m.channel,
    text: m.text,
    status: m.status,
    intent: m.intent,
    at: m.createdAt,
  }));
  return [...events, ...messages].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function findProcessedEvent(providerRef) {
  const id = clean(providerRef, 120);
  if (!id) return null;
  return engine.getDocument("processed_events", id);
}

export function recordProcessedEvent({ providerRef, businessId = null, leadId = null, kind = "webhook" }) {
  const id = clean(providerRef, 120);
  if (!id) return null;
  const existing = engine.getDocument("processed_events", id);
  if (existing) return { ...existing, duplicate: true };
  return engine.putDocument("processed_events", {
    id,
    businessId,
    leadId,
    kind: clean(kind, 40),
    createdAt: nowIso(),
    updatedAt: null,
  });
}

export function resetDomain() {
  for (const collection of [
    "customers", "conversations", "messages", "appointments", "notes",
    "events", "follow_up_jobs", "notifications", "revenue", "integrations", "business_settings", "analytics_events",
    "processed_events",
  ]) {
    for (const doc of engine.listDocuments(collection, { order: "asc" })) {
      engine.deleteDocument(collection, doc.id);
    }
  }
}
