import "./lib/load-env.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { generateReply, classifyIntent, TEMPLATES, normalizeChannel, CHANNELS, isUrgent, channelLabel } from "./lib/engine.js";
import { aiReply, aiReady, aiStatus } from "./lib/ai.js";
import { coachQueue, polishCoachItem, coachLead, COACH_VERSION } from "./lib/coach.js";
import { followUpTasks, salesReport, salesReportText } from "./lib/tasks.js";
import {
  addLead, listLeads, getLead, updateLead, addSetup, listSetups, updateSetup, stats, toCsv,
  nextId, getBusiness, saveBusiness, listBusinesses, LEAD_STATUSES, addPayment, listPayments, hasSqlite, dbPath,
} from "./lib/store.js";
import { smsReady, smsStatus, parseTwilioInbound, isMissedVoiceStatus, EMPTY_TWIML, smsWebhooks, mapTwilioMessageStatus, smsUnavailableReason } from "./lib/sms.js";
import {
  login, logout, sessionFromRequest, cookieValue, clearCookieValue, authStatus, authEnforced,
  ensureBootstrapUser, parseCookies, SESSION_COOKIE,
} from "./lib/auth.js";
import { PLANS, planList, getPlan, monthlyValue } from "./lib/plans.js";
import { checkoutUrl, billingStatus, billingMode } from "./lib/billing.js";
import { ingest, resolveBusinessConfig, conversationIntelligence, pauseConversation, resumeConversation, automationPaused } from "./lib/conversation.js";
import { decide, explainLeadValue } from "./lib/reception.js";
import { applyStatus } from "./lib/lifecycle.js";
import { normalizeBusiness, TRADES, activationChecklist } from "./lib/business.js";
import { integrationRegistry } from "./lib/integrations.js";
import { rateLimit, clientKey, verifyWebhook } from "./lib/security.js";
import { runDueJobs, cancelForLead, stepsFor, buildFollowUpText } from "./lib/followup.js";
import {
  leadTimeline, listNotes, addNote, addRevenueEntry, listLeadAppointments, listNotifications,
  markNotificationRead, listFollowUpJobs, recordEvent, getConversation, getConversationByLead, listLeadMessages,
  getSettings, saveSettings, findMessageByProviderRef, updateMessage,
} from "./lib/domain.js";
import { seedDemoLeads, seedBusinesses, DEMO_BUSINESSES } from "./lib/seed.js";
import { trackEvent, funnelSummary, FUNNEL_EVENTS } from "./lib/analytics.js";
import { listProspects, addProspect, draftEmail, outreachSummary, demoLink } from "./lib/outreach.js";
import { connectNumberStatus, carrierList } from "./lib/forwarding.js";
import { hoursStatus, quietHoursWindow, minutesToClock } from "./lib/hours.js";
import { onboardingState, canActivateLive } from "./lib/onboarding.js";
import { entitlementsReport } from "./lib/entitlements.js";
import { deleteBusinessAccount, exportBusinessAccount } from "./lib/account.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = Number(process.env.PORT || 4000);
// Bind to loopback by default so a local run is not exposed to the network.
// Containers and hosted platforms set HOST=0.0.0.0.
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}

function redirect(res, location) {
  send(res, 302, "", { Location: location });
}

function wantsHtml(req) {
  return String(req.headers?.accept || "").includes("text/html");
}

async function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(data)));
      }
    });
    req.on("error", reject);
  });
}

function normalizeMessage(msg) {
  return String(msg || "").trim().slice(0, 2000);
}

function historyFrom(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t === "object")
    .slice(-20)
    .map((t) => ({ role: t.role === "out" ? "out" : "in", text: String(t.text || "").slice(0, 1000) }));
}

// Turn the byDay map into a dense, ordered window ending today, so a report
// always has exactly `days` entries and gaps read as zero instead of missing.
function lastNDays(byDay, days) {
  const map = byDay && typeof byDay === "object" ? byDay : {};
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    // UTC arithmetic to match how day keys are derived (ISO timestamp prefix).
    const key = new Date(now - i * 86400000).toISOString().slice(0, 10);
    out.push({ date: key, count: map[key] || 0 });
  }
  return out;
}

function resolveBusiness(params) {
  if (params.business && typeof params.business === "object") {
    return normalizeBusiness({ ...TEMPLATES.DEFAULT_BUSINESS, ...params.business });
  }
  if (params.businessId) {
    return resolveBusinessConfig(params.businessId, params.business);
  }
  return normalizeBusiness(TEMPLATES.DEFAULT_BUSINESS);
}

const CHANNEL_ROUTES = {
  "/api/missed-call": "missed_call",
  "/api/whatsapp": "whatsapp",
  "/api/facebook": "facebook",
  "/api/instagram": "instagram",
  "/api/webchat": "webchat",
  "/api/google-ads": "google_ads",
};

// Admin guard. Allows machine access via ADMIN_TOKEN, human access via session
// cookie, and open access when no credential exists yet.
function authorize(req, url, res) {
  if (!authEnforced()) return true;

  if (sessionFromRequest(req)) return true;

  const supplied = url.searchParams.get("token") || bearer(req);
  if (ADMIN_TOKEN && supplied && supplied === ADMIN_TOKEN) return true;

  if (wantsHtml(req)) {
    redirect(res, `/login?next=${encodeURIComponent(url.pathname)}`);
  } else {
    json(res, 401, { ok: false, error: "unauthorized", login: "/login" });
  }
  return false;
}

function bearer(req) {
  const h = String(req.headers?.authorization || "");
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

function cleanId(value) {
  return String(value || "demo").trim().slice(0, 80) || "demo";
}

async function route(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;

  // ---------------------------------------------------------------- public

  if (pathname === "/health") {
    const integrations = integrationRegistry();
    const s = stats();
    return json(res, 200, {
      ok: true,
      sms: smsReady(),
      smsStatus: smsStatus(),
      ai: aiStatus(),
      billing: billingStatus(),
      auth: authStatus(),
      storage: { engine: hasSqlite() ? "sqlite" : "json", path: dbPath() },
      avgResponseSeconds: s.avgResponseSeconds,
      automationPaused: automationPaused("demo"),
      reliability: s.reliability || null,
      integrations,
      time: new Date().toISOString(),
    });
  }

  if (pathname === "/api/channels" && method === "GET") {
    return json(res, 200, { ok: true, channels: CHANNELS, statuses: LEAD_STATUSES, trades: TRADES });
  }

  if (pathname === "/api/plans" && method === "GET") {
    return json(res, 200, { ok: true, plans: planList(), billing: billingStatus() });
  }

  if (pathname === "/api/billing/status" && method === "GET") {
    return json(res, 200, { ok: true, ...billingStatus() });
  }

  // Framing math for the calculator and for outreach. Pure, no side effects.
  if (pathname === "/api/value" && (method === "GET" || method === "POST")) {
    const params = method === "POST" ? await readBody(req) : Object.fromEntries(searchParams);
    const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
    // Rates are fractions internally (0.3). Accept "30" from URL callers too,
    // where a human thinks in percent, and normalize to a fraction.
    const rate = (v, d) => {
      const n = num(v, d);
      if (n > 1) return n / 100;
      return n < 0 ? 0 : n;
    };
    const inputs = {
      missedCallsPerWeek: num(params.missedCallsPerWeek, 12),
      jobValue: num(params.jobValue, 450),
      closeRate: rate(params.closeRate, 0.3),
      recoveryRate: rate(params.recoveryRate, 0.3),
    };
    // Default the plan cost to the Starter price so the calculator and the
    // pricing table can never disagree.
    const plan = getPlan(params.plan);
    const value = monthlyValue({ ...inputs, planCost: plan ? plan.price : 99 });
    return json(res, 200, {
      ok: true,
      inputs,
      value,
      explanation: value.explanation,
      disclaimer: "This is a model, not a guaranteed result. Estimated potential value is not verified revenue.",
    });
  }

  if (pathname === "/api/analytics" && method === "POST") {
    const params = await readBody(req);
    const limited = rateLimit(`analytics:${clientKey(req)}`, { max: 60 });
    if (!limited.ok) return json(res, 429, { ok: false, error: "rate_limited" });
    const result = trackEvent(params);
    if (!result.ok) return json(res, 400, result);
    return json(res, 201, result);
  }

  if (pathname === "/api/analytics" && method === "GET") {
    if (!authorize(req, url, res)) return;
    return json(res, 200, { ok: true, events: FUNNEL_EVENTS, funnel: funnelSummary(searchParams.get("businessId") || "site") });
  }

  if (pathname === "/api/referral" && method === "POST") {
    const params = await readBody(req);
    if (!params.business || !params.email) {
      return json(res, 400, { ok: false, error: "business and email are required" });
    }
    const setup = addSetup({
      id: nextId("ref"),
      business: String(params.business).slice(0, 120),
      name: String(params.name || "").slice(0, 120),
      email: String(params.email).slice(0, 160),
      phone: String(params.phone || "").slice(0, 40),
      trade: String(params.trade || "HVAC").slice(0, 60),
      plan: "professional",
      status: "referral",
      notes: `Referred by ${String(params.referredBy || "owner").slice(0, 120)}`,
      createdAt: new Date().toISOString(),
    });
    trackEvent({ type: "referral_sent", label: setup.trade, businessId: "site" });
    return json(res, 201, { ok: true, referral: { id: setup.id } });
  }

  // Checkout link for a plan. Never invents a URL: returns not_configured
  // until the operator sets a real payment link.
  if (pathname === "/api/billing/checkout" && (method === "GET" || method === "POST")) {
    const params = method === "POST" ? await readBody(req) : Object.fromEntries(searchParams);
    const result = checkoutUrl(params.plan, {
      source: params.source || "landing",
      businessId: params.businessId || "",
    });
    if (!result.ok) {
      return json(res, 200, {
        ok: false,
        reason: result.reason || "not_configured",
        message:
          result.reason === "unknown_plan"
            ? "Unknown plan."
            : "No payment link configured yet. Set RB_PAYMENT_LINK_* or RB_PAYPAL_ME to enable checkout.",
        fallback: { email: "hello@ringback.app" },
      });
    }
    return json(res, 200, { ok: true, ...result });
  }

  // ---------------------------------------------------------------- auth

  if (pathname === "/api/auth/login" && method === "POST") {
    const params = await readBody(req);
    const result = login(params.email, params.password);
    if (!result) return json(res, 401, { ok: false, error: "invalid_credentials" });
    return send(res, 200, JSON.stringify({ ok: true, user: result.user }), {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": cookieValue(result.token, req),
    });
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = parseCookies(req)[SESSION_COOKIE];
    logout(token);
    return send(res, 200, JSON.stringify({ ok: true }), {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": clearCookieValue(req),
    });
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    const found = sessionFromRequest(req);
    return json(res, 200, {
      ok: true,
      authenticated: Boolean(found),
      user: found ? { email: found.session.email } : null,
      auth: authStatus(),
    });
  }

  // ---------------------------------------------------------------- demo

  if (pathname === "/api/demo" && (method === "GET" || method === "POST")) {
    const params = method === "POST" ? await readBody(req) : Object.fromEntries(searchParams);
    const message = normalizeMessage(params.message || "How much do you charge to fix my AC?");
    const biz = resolveBusiness(params);
    const channel = normalizeChannel(params.channel || "sms");
    const history = historyFrom(params.history);
    let qualification = {};
    let conversation = { state: "greeting", turnCount: 0, proposedSlots: [] };
    for (const turn of history) {
      if (turn.role !== "in") continue;
      const prior = decide({
        conversation,
        qualification,
        message: turn.text,
        business: biz,
        meta: { channel, name: params.name || "Alex" },
      });
      qualification = prior.qualification || qualification;
      conversation = {
        state: prior.nextState || conversation.state,
        turnCount: (conversation.turnCount || 0) + 1,
        proposedSlots: prior.slots?.length ? prior.slots : conversation.proposedSlots,
        selectedSlot: prior.bookingState === "selected" ? prior.slot : conversation.selectedSlot,
        bookingState: prior.bookingState || conversation.bookingState,
      };
    }
    const decision = decide({
      conversation,
      qualification,
      message,
      business: biz,
      meta: { channel, name: params.name || "Alex" },
    });
    let reply = decision.reply;
    let engine = decision.engine;
    let aiFallbackReason;
    if (params.ai !== "false" && aiReady()) {
      const ai = await aiReply(message, biz, { channel, history, name: params.name });
      if (ai.used) {
        reply = ai.reply;
        engine = ai.engine;
      } else {
        aiFallbackReason = ai.reason;
      }
    }
    const followUp = stepsFor(biz).slice(0, 3).map((step, i) => ({
      delayHours: Number(step.delayHours) || [4, 24, 72][i] || 4,
      channel,
      text: buildFollowUpText({ business: biz, lead: { name: params.name || "Alex", channel }, step, qualification: decision.qualification }),
    }));
    while (followUp.length < 3) {
      followUp.push({ delayHours: [4, 24, 72][followUp.length], channel, text: `Just checking in from ${biz.name}.` });
    }
    const severity = decision.severity || (decision.urgent ? "urgent" : "normal");
    const bookingState = decision.bookingState || (decision.stage === "booked" ? "confirmed" : decision.stage === "booking_requested" ? "offered" : "available");
    const ownerSnapshot = {
      name: params.name || "Alex",
      source: channel,
      intent: decision.intent === "repair" || decision.intent === "availability" || decision.intent === "booking" ? "Service request" : decision.intent,
      service: decision.qualification?.service || null,
      location: decision.qualification?.area || decision.qualification?.address || null,
      severity,
      urgency: severity === "emergency" || severity === "urgent" ? "hot" : (decision.qualification?.service ? "warm" : "cold"),
      estimatedValue: decision.estimatedValue || null,
      status: decision.stage || "contacted",
      bookingState,
      appointment: decision.slot || null,
      offeredSlots: decision.slots || [],
      valueExplanation: explainLeadValue(decision.qualification, biz),
      emergencyState: severity === "emergency"
        ? { detected: true, ownerNotified: true, dispatcherConfirmed: false, technicianDispatched: false }
        : null,
      nextAction: severity === "emergency"
        ? "Emergency detected. Owner notified. Dispatcher has not confirmed. Do not invent a technician or a price."
        : bookingState === "confirmed" || decision.stage === "booked"
          ? "Appointment confirmed. Complete the job, then mark won with the invoice."
          : bookingState === "selected"
            ? "Slot selected — not a booking. Reply YES to confirm."
            : decision.stage === "booking_requested"
            ? "Times offered — not a booking. Wait for a numbered choice."
            : "RingBack is qualifying this lead.",
      revenueKind: decision.stage === "won" ? "verified" : (decision.stage === "booked" ? "estimated" : "potential"),
    };
    return json(res, 200, {
      input: message,
      intent: decision.intent,
      urgent: decision.urgent,
      channel,
      channelLabel: channelLabel(channel),
      reply,
      followUp: followUp.slice(0, 3),
      engine,
      aiFallbackReason,
      qualification: decision.qualification || {},
      ownerSnapshot,
    });
  }

  // ---------------------------------------------------------------- billing return pages (honest: visiting is not paid)

  if (pathname === "/pay/success") {
    const wantJson = String(req.headers.accept || "").includes("application/json");
    if (method === "GET" && !wantJson) return serveFile(res, "pay-success.html");
    return json(res, 200, {
      ok: true,
      paid: false,
      mode: billingMode(),
      message: "This page does not confirm payment. Record the payment on the dashboard after money actually arrives.",
    });
  }

  if (pathname === "/pay/cancel") {
    const wantJson = String(req.headers.accept || "").includes("application/json");
    if (method === "GET" && !wantJson) return serveFile(res, "pay-cancel.html");
    return json(res, 200, {
      ok: true,
      paid: false,
      cancelled: true,
      mode: billingMode(),
      message: "Checkout was cancelled. No payment was recorded.",
    });
  }

  // Twilio inbound SMS / missed-call voice. Public; signature checked when a secret is set.
  if ((pathname === "/api/twilio/sms" || pathname === "/api/twilio/voice") && method === "POST") {
    const limited = rateLimit(`twilio:${clientKey(req)}`, { max: 120 });
    if (!limited.ok) {
      return json(res, 429, { ok: false, error: "rate_limited", retryAfter: limited.retryAfter });
    }
    const params = await readBody(req);
    const inbound = parseTwilioInbound(params);
    const secret = process.env.RB_WEBHOOK_SECRET || process.env.TWILIO_AUTH_TOKEN || "";
    const signature = req.headers["x-twilio-signature"] || "";
    const verification = secret
      ? verifyWebhook({ provider: "hmac", secret, payload: params, signature })
      : { ok: false, reason: "not_configured", verified: false };
    if (secret && !verification.ok) {
      return json(res, 401, { ok: false, error: "webhook_failed", webhook: verification });
    }
    if (pathname === "/api/twilio/sms" && inbound.messageStatus && !inbound.body) {
      const mapped = mapTwilioMessageStatus(inbound.messageStatus);
      const sid = inbound.messageSid || params.MessageSid || params.SmsSid || "";
      const found = sid ? findMessageByProviderRef(sid) : null;
      const msg = found && found.direction === "out" ? found : null;
      if (mapped && msg) {
        updateMessage(msg.id, { status: mapped, error: inbound.errorCode || null });
        if (msg.leadId) {
          const lead = getLead(msg.leadId);
          if (lead) {
            const unavailable = smsUnavailableReason(inbound.errorCode, inbound.messageStatus);
            updateLead(lead.id, {
              deliveryStatus: mapped,
              sms: { ...(lead.sms || {}), status: mapped, error: inbound.errorCode || null },
              failureState: mapped === "delivered" ? null : (unavailable || (mapped === "undelivered" ? "sms_failed" : lead.failureState)),
            });
            recordEvent({
              businessId: lead.businessId,
              leadId: lead.id,
              type: mapped === "delivered" ? "sms_delivered" : "sms_status",
              actor: "system",
              summary: mapped === "delivered" ? "Twilio reported delivered." : `Twilio status: ${inbound.messageStatus}.`,
            });
          }
        }
      }
      return json(res, 200, { ok: true, receipt: true, status: mapped || inbound.messageStatus, matched: Boolean(msg) });
    }
    if (pathname === "/api/twilio/voice" && inbound.callStatus && !isMissedVoiceStatus(inbound.callStatus) && inbound.callStatus !== "completed") {
      return send(res, 200, EMPTY_TWIML, { "Content-Type": "text/xml; charset=utf-8" });
    }
    if (!inbound.phone) {
      return json(res, 400, { ok: false, error: "missing_from" });
    }
    const businessId = String(params.businessId || "demo").slice(0, 80);
    const channel = pathname === "/api/twilio/voice" ? "missed_call" : "sms";
    const result = await ingest({
      businessId,
      channel,
      source: channel,
      phone: inbound.phone,
      from: inbound.phone,
      message: inbound.body || (channel === "missed_call" ? "" : inbound.body),
      name: params.name || "",
      providerRef: inbound.callSid || inbound.messageSid || params.CallSid || params.MessageSid || "",
      CallSid: inbound.callSid || params.CallSid || "",
      MessageSid: inbound.messageSid || params.MessageSid || "",
    });
    const wantsXml = String(req.headers.accept || "").includes("xml") || pathname === "/api/twilio/voice";
    if (wantsXml) {
      return send(res, 200, EMPTY_TWIML, { "Content-Type": "text/xml; charset=utf-8" });
    }
    return json(res, result.created ? 201 : 200, {
      ok: true,
      lead: result.lead,
      delivery: result.delivery,
      created: result.created,
      webhook: verification,
    });
  }

  // ---------------------------------------------------------------- webhooks

  if ((pathname === "/api/message" || pathname === "/api/leads" || CHANNEL_ROUTES[pathname]) && method === "POST") {
    const limited = rateLimit(`ingest:${clientKey(req)}`, { max: 120 });
    if (!limited.ok) {
      return json(res, 429, { ok: false, error: "rate_limited", retryAfter: limited.retryAfter });
    }
    const params = await readBody(req);
    const forced = CHANNEL_ROUTES[pathname] || (pathname === "/api/message" ? params.channel : undefined);
    if (!params.message && !params.name && !params.phone && !params.from && !params.leadId) {
      return json(res, 400, { ok: false, error: "provide at least one of name, phone, message" });
    }
    const secret = process.env.RB_WEBHOOK_SECRET || process.env.TWILIO_AUTH_TOKEN || "";
    const signature = req.headers["x-twilio-signature"] || req.headers["x-webhook-signature"] || "";
    const verification = secret
      ? verifyWebhook({ provider: "hmac", secret, payload: params, signature })
      : { ok: false, reason: "not_configured", verified: false };
    if (secret && !verification.ok) {
      return json(res, 401, { ok: false, error: "webhook_failed", webhook: verification });
    }
    const result = await ingest({
      ...params,
      channel: forced || params.channel,
      source: forced || params.source,
      phone: params.phone || params.from,
      ai: params.ai,
    });
    if (!result.ok) return json(res, result.error === "lead_not_found" ? 404 : 400, result);
    return json(res, result.created ? 201 : 200, {
      ok: true,
      lead: result.lead,
      conversation: result.conversation,
      decision: {
        intent: result.decision?.intent,
        urgent: result.decision?.urgent,
        action: result.decision?.action,
        stage: result.decision?.stage,
        outcomes: result.decision?.outcomes,
        escalation: result.decision?.escalation,
      },
      delivery: result.delivery,
      appointment: result.appointment,
      notification: result.notification,
      ownerPing: result.ownerPing,
      hours: result.hours,
      events: result.events,
      webhook: verification,
    });
  }

  // ---------------------------------------------------------------- CRM (protected)

  if (pathname === "/api/leads" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || undefined;
    return json(res, 200, {
      ok: true,
      stats: stats(businessId),
      leads: listLeads(businessId).slice(0, 500),
    });
  }

  if (pathname === "/api/leads/export" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || undefined;
    return send(res, 200, toCsv(businessId), {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ringback-leads.csv"',
    });
  }

  const leadMatch = pathname.match(/^\/api\/leads\/([A-Za-z0-9_]+)$/);
  if (leadMatch) {
    if (!authorize(req, url, res)) return;
    const id = leadMatch[1];
    if (method === "GET") {
      const lead = getLead(id);
      if (!lead) return json(res, 404, { ok: false, error: "lead_not_found" });
      const conversation = lead.conversationId ? getConversation(lead.conversationId) : getConversationByLead(id);
      const appointments = listLeadAppointments(id);
      const followUps = listFollowUpJobs({ leadId: id });
      const intelligence = conversationIntelligence({
        lead,
        conversation,
        appointments,
        business: resolveBusinessConfig(lead.businessId || "demo"),
      });
      const coach = coachLead({
        lead,
        conversation,
        appointments,
        followUps,
        business: resolveBusinessConfig(lead.businessId || "demo"),
      });
      return json(res, 200, {
        ok: true,
        lead,
        timeline: leadTimeline(id),
        notes: listNotes(id),
        appointments,
        messages: listLeadMessages(id),
        conversation,
        followUps,
        intelligence,
        coach,
      });
    }
    if (method === "PATCH" || method === "POST" || method === "PUT") {
      const current = getLead(id);
      if (!current) return json(res, 404, { ok: false, error: "lead_not_found" });
      const patch = await readBody(req);
      const extra = {};
      if (patch.action === "take_over") {
        extra.followUpStatus = "stopped";
        cancelForLead(id, "owner_takeover");
        const conv = current.conversationId ? getConversation(current.conversationId) : getConversationByLead(id);
        if (conv) pauseConversation(conv, patch.pausedReason || "Owner took over the conversation.");
        recordEvent({ businessId: current.businessId, leadId: id, type: "handoff", actor: "owner", summary: "Owner took over the conversation." });
      }
      if (patch.action === "return_to_ai") {
        extra.followUpStatus = "active";
        const conv = current.conversationId ? getConversation(current.conversationId) : getConversationByLead(id);
        if (conv) resumeConversation(conv);
        recordEvent({ businessId: current.businessId, leadId: id, type: "handoff", actor: "owner", summary: "Owner returned the conversation to AI." });
      }
      if (patch.action === "stop_follow_up") {
        extra.followUpStatus = "stopped";
        cancelForLead(id, "stopped_by_owner");
      }
      if (patch.action === "restart_follow_up") extra.followUpStatus = "active";
      if (patch.status) {
        if (patch.status === "won" && !(Number(current.confirmedRevenue) > 0) && !(Number(patch.confirmedRevenue) > 0)) {
          return json(res, 400, { ok: false, error: "invoice_amount_required", message: "Won without an invoice is not verified revenue. POST /revenue with the invoice amount." });
        }
        const lifecycle = applyStatus(current, patch.status, { lostReason: patch.lostReason, invoiceVerified: Number(current.confirmedRevenue) > 0 || Number(patch.confirmedRevenue) > 0 });
        if (lifecycle) Object.assign(extra, lifecycle);
      }
      if (typeof patch.confirmedRevenue === "number") extra.confirmedRevenue = patch.confirmedRevenue;
      if (typeof patch.lostReason === "string") extra.lostReason = patch.lostReason;
      const updated = updateLead(id, { ...patch, ...extra });
      if (patch.status && ["won", "booked", "lost"].includes(updated.status)) {
        recordEvent({ businessId: updated.businessId, leadId: id, type: "status_changed", actor: "owner", summary: `Status set to ${updated.status}.` });
      }
      return json(res, 200, { ok: true, lead: updated });
    }
  }

  const leadNoteMatch = pathname.match(/^\/api\/leads\/([A-Za-z0-9_]+)\/notes$/);
  if (leadNoteMatch && method === "POST") {
    if (!authorize(req, url, res)) return;
    const lead = getLead(leadNoteMatch[1]);
    if (!lead) return json(res, 404, { ok: false, error: "lead_not_found" });
    const params = await readBody(req);
    const note = addNote({ businessId: lead.businessId, leadId: lead.id, author: params.author || "owner", text: params.text || "" });
    recordEvent({ businessId: lead.businessId, leadId: lead.id, type: "note", actor: "owner", summary: String(params.text || "").slice(0, 140) });
    return json(res, 201, { ok: true, note });
  }

  const leadReplyMatch = pathname.match(/^\/api\/leads\/([A-Za-z0-9_]+)\/reply$/);
  if (leadReplyMatch && method === "POST") {
    const lead = getLead(leadReplyMatch[1]);
    if (!lead) return json(res, 404, { ok: false, error: "lead_not_found" });
    const params = await readBody(req);
    if (params.ownerSend || params.fromOwner) {
      if (!authorize(req, url, res)) return;
      const conv = lead.conversationId ? getConversation(lead.conversationId) : getConversationByLead(lead.id);
      if (conv) pauseConversation(conv, "Owner took over the conversation.");
      const text = String(params.text || params.message || "").trim();
      if (!text) return json(res, 400, { ok: false, error: "message_required" });
      const result = await ingest({
        leadId: lead.id,
        businessId: lead.businessId,
        channel: lead.channel || "sms",
        source: lead.source,
        outboundOnly: true,
        outboundText: text,
        ownerSend: true,
        ai: false,
      });
      recordEvent({ businessId: lead.businessId, leadId: lead.id, type: "owner_message", actor: "owner", summary: text.slice(0, 140) });
      return json(res, result.ok ? 200 : 400, result);
    }
    const result = await ingest({
      leadId: lead.id,
      businessId: lead.businessId,
      channel: lead.channel,
      source: lead.source,
      message: params.message || "",
      ai: params.ai,
    });
    return json(res, result.ok ? 200 : 400, result);
  }

  const leadRevenueMatch = pathname.match(/^\/api\/leads\/([A-Za-z0-9_]+)\/revenue$/);
  if (leadRevenueMatch && method === "POST") {
    if (!authorize(req, url, res)) return;
    const lead = getLead(leadRevenueMatch[1]);
    if (!lead) return json(res, 404, { ok: false, error: "lead_not_found" });
    const params = await readBody(req);
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(res, 400, { ok: false, error: "invoice_amount_required", message: "Type the invoice amount. RingBack will not invent $450." });
    }
    const invoiceRef = String(params.invoiceRef || params.reference || "").trim().slice(0, 80);
    const entry = addRevenueEntry({
      businessId: lead.businessId,
      leadId: lead.id,
      amount,
      status: params.status || "won",
      source: params.source || "manual",
      note: params.note || "",
      invoiceRef,
    });
    const updated = updateLead(lead.id, {
      confirmedRevenue: amount,
      revenueStatus: params.status || "won",
      status: params.status === "lost" ? "lost" : "won",
      jobValue: amount,
      invoiceRef,
    });
    recordEvent({ businessId: lead.businessId, leadId: lead.id, type: "revenue", actor: "owner", summary: `Recorded ${amount} ${entry.currency}${invoiceRef ? " invoice " + invoiceRef : ""}.` });
    return json(res, 201, { ok: true, revenue: entry, lead: updated, invoiceRef: invoiceRef || null });
  }

  if (pathname === "/api/coach" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || undefined;
    const limit = Number(searchParams.get("limit") || 8);
    const polish = searchParams.get("polish") === "1" || searchParams.get("ai") === "1";
    const biz = resolveBusinessConfig(businessId || "demo");
    const leads = listLeads(businessId);
    const queue = coachQueue({
      leads,
      business: biz,
      limit,
      getConversation: (lead) => (lead.conversationId ? getConversation(lead.conversationId) : getConversationByLead(lead.id)),
      getAppointments: (lead) => listLeadAppointments(lead.id),
      getFollowUps: (lead) => listFollowUpJobs({ leadId: lead.id }),
    });
    const items = polish
      ? await Promise.all(queue.map((item) => polishCoachItem(item, biz)))
      : queue;
    return json(res, 200, {
      ok: true,
      version: COACH_VERSION,
      ai: aiStatus(),
      polished: polish && aiReady(),
      count: items.length,
      items,
    });
  }

  const coachLeadMatch = pathname.match(/^\/api\/leads\/([A-Za-z0-9_]+)\/coach$/);
  if (coachLeadMatch && method === "GET") {
    if (!authorize(req, url, res)) return;
    const lead = getLead(coachLeadMatch[1]);
    if (!lead) return json(res, 404, { ok: false, error: "lead_not_found" });
    const conversation = lead.conversationId ? getConversation(lead.conversationId) : getConversationByLead(lead.id);
    const appointments = listLeadAppointments(lead.id);
    const followUps = listFollowUpJobs({ leadId: lead.id });
    const biz = resolveBusinessConfig(lead.businessId || "demo");
    let item = coachLead({ lead, conversation, appointments, followUps, business: biz });
    if (searchParams.get("polish") === "1" || searchParams.get("ai") === "1") {
      item = await polishCoachItem(item, biz);
    }
    return json(res, 200, { ok: true, version: COACH_VERSION, item });
  }

  if (pathname === "/api/report" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || undefined;
    const s = stats(businessId);
    const reportHours = hoursStatus(resolveBusinessConfig(businessId || "demo"));
    return json(res, 200, {
      ok: true,
      businessId: businessId || null,
      hours: reportHours,
      generatedAt: new Date().toISOString(),
      headline: {
        leadsCaptured: s.total,
        autoReplied: s.replied,
        urgent: s.urgent,
        booked: (s.byStatus.booked || 0) + (s.byStatus.won || 0),
        recoveredRevenue: s.recovered,
        estimatedRevenue: s.estimatedRevenue || 0,
        verifiedRevenue: s.verifiedRevenue || 0,
        pipelineValue: s.pipelineValue,
        customersRecovered: s.customersRecovered,
        appointmentsBooked: s.appointmentsBooked,
        missedCallsHandled: s.missedCallsHandled,
        qualifiedLeads: s.qualifiedLeads || 0,
        followUpsActive: s.followUpsActive || 0,
        avgResponseSeconds: s.avgResponseSeconds,
        planCost: s.planCost,
        estimatedRoi: s.estimatedRoi,
        verifiedRoi: s.verifiedRoi,
        currency: s.recoveredCurrency,
      },
      rates: { replyRate: s.replyRate, bookedRate: s.bookedRate, conversionRate: s.conversionRate },
      byBucket: s.byBucket,
      byStatus: s.byStatus,
      byChannel: s.byChannel,
      byDay: s.byDay,
      last14Days: lastNDays(s.byDay, 14),
      sales: salesReport({ stats: s, leads: listLeads(businessId), setups: listSetups(), payments: listPayments() }),
       note: "Booked jobs are estimated, not recovered. Only owner-entered invoice amounts are verified revenue. Not a guarantee.",
    });
  }

  if (pathname === "/api/report.txt" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || undefined;
    const s = stats(businessId);
    const report = salesReport({ stats: s, leads: listLeads(businessId), setups: listSetups(), payments: listPayments() });
    return send(res, 200, salesReportText(report), {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ringback-sales-report.txt"',
    });
  }

  if (pathname === "/api/tasks" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || undefined;
    const tasks = followUpTasks({
      leads: listLeads(businessId),
      getFollowUps: (lead) => listFollowUpJobs({ leadId: lead.id }),
      getConversation: (lead) => (lead.conversationId ? getConversation(lead.conversationId) : getConversationByLead(lead.id)),
    });
    return json(res, 200, { ok: true, count: tasks.length, tasks });
  }

  // ---------------------------------------------------------------- setups

  if (pathname === "/api/setup" && method === "POST") {
    const params = await readBody(req);
    if (!params.business || !params.email) {
      return json(res, 400, { ok: false, error: "business and email are required" });
    }
    const setup = {
      id: nextId("setup"),
      business: String(params.business).slice(0, 120),
      name: String(params.name || "").slice(0, 120),
      email: String(params.email).slice(0, 160),
      phone: String(params.phone || "").slice(0, 40),
      trade: String(params.trade || "").slice(0, 60),
      bookingUrl: String(params.bookingUrl || "").slice(0, 300),
      channels: Array.isArray(params.channels) ? params.channels.slice(0, 10) : [],
      plan: String(params.plan || "").slice(0, 40),
      status: "new",
      notes: [
        params.serviceArea ? `Area: ${String(params.serviceArea).slice(0, 120)}` : "",
        params.hours ? `Hours: ${String(params.hours).slice(0, 120)}` : "",
        params.services ? `Services: ${String(params.services).slice(0, 240)}` : "",
        params.emergency ? `Emergency: ${String(params.emergency).slice(0, 240)}` : "",
      ].filter(Boolean).join(" | "),
      createdAt: new Date().toISOString(),
    };
    addSetup(setup);
    trackEvent({ type: "setup_request", label: setup.plan || "professional", businessId: "site" });
    const services = String(params.services || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12);
    const emergencyPolicy = String(params.emergency || "").slice(0, 240);
    const biz = saveBusiness(normalizeBusiness({
      id: setup.id,
      name: setup.business,
      trade: setup.trade || "home services",
      serviceArea: String(params.serviceArea || "").slice(0, 160),
      bookingUrl: setup.bookingUrl,
      phone: setup.phone,
      hours: String(params.hours || "").slice(0, 160),
      offer: "",
      ...(services.length ? { services } : {}),
      ...(emergencyPolicy ? { emergency: { available: true, policy: emergencyPolicy } } : {}),
    }));

    const checkout = checkoutUrl(setup.plan, { source: "setup_form", businessId: setup.id });
    return json(res, 201, {
      ok: true,
      setup,
      businessId: biz.id,
      checkout: checkout.ok ? { url: checkout.url, provider: checkout.provider } : null,
    });
  }

  if (pathname === "/api/setups" && method === "GET") {
    if (!authorize(req, url, res)) return;
    return json(res, 200, { ok: true, setups: listSetups().slice(0, 200), payments: listPayments().slice(0, 100) });
  }

  const setupMatch = pathname.match(/^\/api\/setups\/([A-Za-z0-9_]+)$/);
  if (setupMatch && (method === "PATCH" || method === "POST")) {
    if (!authorize(req, url, res)) return;
    const patch = await readBody(req);
    const updated = updateSetup(setupMatch[1], patch);
    if (!updated) return json(res, 404, { ok: false, error: "setup_not_found" });
    return json(res, 200, { ok: true, setup: updated });
  }

  // ---------------------------------------------------------------- payments

  if (pathname === "/api/payments" && method === "GET") {
    if (!authorize(req, url, res)) return;
    return json(res, 200, { ok: true, payments: listPayments().slice(0, 200) });
  }

  if (pathname === "/api/payments" && method === "POST") {
    if (!authorize(req, url, res)) return;
    const params = await readBody(req);
    const plan = getPlan(params.plan);
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(res, 400, { ok: false, error: "amount must be a positive number" });
    }
    const payment = addPayment({
      id: nextId("pay"),
      businessId: params.businessId ? String(params.businessId).slice(0, 80) : null,
      setupId: params.setupId ? String(params.setupId).slice(0, 80) : null,
      plan: plan ? plan.id : String(params.plan || "").slice(0, 40),
      amount: Math.min(amount, 1_000_000),
      currency: String(params.currency || "USD").slice(0, 8).toUpperCase(),
      provider: String(params.provider || "manual").slice(0, 40),
      reference: String(params.reference || "").slice(0, 120),
      note: String(params.note || "").slice(0, 500),
      createdAt: new Date().toISOString(),
    });
    if (payment.setupId) updateSetup(payment.setupId, { status: "paid" });
    return json(res, 201, { ok: true, payment });
  }

  if (pathname === "/api/businesses" && method === "GET") {
    if (!authorize(req, url, res)) return;
    return json(res, 200, { ok: true, businesses: listBusinesses().slice(0, 50), demos: DEMO_BUSINESSES });
  }

  if (pathname === "/api/settings" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || "demo";
    const business = resolveBusinessConfig(businessId);
    const settings = getSettings(businessId);
    const activation = activationChecklist(business);
    const quiet = quietHoursWindow(business);
    return json(res, 200, {
      ok: true,
      business,
      settings,
      activation,
      integrations: integrationRegistry(business),
      onboarding: onboardingState({ business, settings, activation }),
      entitlements: entitlementsReport(businessId),
      hours: hoursStatus(business),
      quietHours: { ...quiet, startClock: minutesToClock(quiet.startMin), endClock: minutesToClock(quiet.endMin) },
      timeZone: business.timeZone || "",
    });
  }

  if (pathname === "/api/settings" && (method === "POST" || method === "PATCH" || method === "PUT")) {
    if (!authorize(req, url, res)) return;
    const params = await readBody(req);
    const businessId = cleanId(params.businessId || params.id || "demo");
    const biz = saveBusiness(normalizeBusiness({ ...resolveBusinessConfig(businessId), ...params, id: businessId }));
    const settings = saveSettings(businessId, params.settings || params);
    return json(res, 200, { ok: true, business: biz, settings, integrations: integrationRegistry(biz) });
  }

  if (pathname === "/api/automation" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || "demo";
    const settings = getSettings(businessId) || {};
    return json(res, 200, {
      ok: true,
      paused: settings.automationPaused === true,
      pausedAt: settings.automationPausedAt || null,
      pausedBy: settings.automationPausedBy || null,
    });
  }

  if (pathname === "/api/automation" && (method === "POST" || method === "PATCH")) {
    if (!authorize(req, url, res)) return;
    const params = await readBody(req);
    const businessId = cleanId(params.businessId || "demo");
    const pause = params.pause === true || params.paused === true || params.action === "pause";
    const resume = params.pause === false || params.paused === false || params.action === "resume";
    const nextPaused = resume ? false : pause;
    const settings = saveSettings(businessId, {
      automationPaused: nextPaused,
      automationPausedAt: nextPaused ? new Date().toISOString() : null,
      automationPausedBy: nextPaused ? (params.by || "owner") : null,
    });
    recordEvent({
      businessId,
      type: nextPaused ? "automation_paused" : "automation_resumed",
      actor: "owner",
      summary: nextPaused
        ? `Automation paused at ${settings.automationPausedAt} by ${settings.automationPausedBy || "owner"}.`
        : "Automation resumed.",
    });
    return json(res, 200, {
      ok: true,
      paused: settings.automationPaused === true,
      pausedAt: settings.automationPausedAt || null,
      pausedBy: settings.automationPausedBy || null,
    });
  }

  if (pathname === "/api/onboarding" && method === "POST") {
    const params = await readBody(req);
    if (!params.business && !params.name) {
      return json(res, 400, { ok: false, error: "business name is required" });
    }
    const setup = {
      id: nextId("setup"),
      business: String(params.business || params.name).slice(0, 120),
      name: String(params.name || params.owner || "").slice(0, 120),
      email: String(params.email || "").slice(0, 160),
      phone: String(params.phone || "").slice(0, 40),
      trade: String(params.trade || "").slice(0, 60),
      bookingUrl: String(params.bookingUrl || "").slice(0, 300),
      channels: Array.isArray(params.channels) ? params.channels.slice(0, 10) : [],
      plan: String(params.plan || "").slice(0, 40),
      status: "onboarding",
      notes: "",
      createdAt: new Date().toISOString(),
    };
    addSetup(setup);
    trackEvent({ type: "trial_start", label: setup.plan || "professional", businessId: "site" });
    const biz = saveBusiness(normalizeBusiness({
      id: setup.id,
      name: setup.business,
      trade: setup.trade,
      serviceArea: params.serviceArea || "",
      bookingUrl: setup.bookingUrl,
      phone: setup.phone,
      email: setup.email,
      hours: params.hours || "",
      offer: params.offer || "",
      services: params.services,
      emergency: params.emergency,
      followUp: params.followUp,
      notifications: { email: setup.email, phone: setup.phone },
    }));
    saveSettings(biz.id, { onboarded: true, plan: setup.plan });
    const checkout = checkoutUrl(setup.plan, { source: "onboarding", businessId: setup.id });
    const activation = activationChecklist(biz);
    const onboarding = onboardingState({ business: biz, settings: getSettings(biz.id), activation });
    return json(res, 201, {
      ok: true,
      setup,
      business: biz,
      onboarding,
      checkout: checkout.ok ? { url: checkout.url, provider: checkout.provider } : null,
    });
  }

  if (pathname === "/api/onboarding" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || "demo";
    const business = resolveBusinessConfig(businessId);
    const settings = getSettings(businessId);
    const activation = activationChecklist(business);
    return json(res, 200, {
      ok: true,
      businessId,
      onboarding: onboardingState({ business, settings, activation }),
      activation,
      sms: smsStatus(),
    });
  }

  if (pathname === "/api/onboarding/activate" && method === "POST") {
    if (!authorize(req, url, res)) return;
    const params = await readBody(req);
    const businessId = cleanId(params.businessId || "demo");
    const business = resolveBusinessConfig(businessId);
    const activation = activationChecklist(business);
    const snap = onboardingState({ business, settings: getSettings(businessId), activation });
    if (!canActivateLive(snap)) {
      return json(res, 400, {
        ok: false,
        error: "not_ready",
        onboarding: snap,
        note: "Live automation stays off until the checklist and Twilio are complete.",
      });
    }
    const settings = saveSettings(businessId, { live: true });
    const next = onboardingState({ business, settings, activation });
    recordEvent({ businessId, type: "onboarding_live", actor: "owner", summary: "Owner activated live automation." });
    return json(res, 200, { ok: true, onboarding: next, settings });
  }

  if (pathname === "/api/onboarding/test" && method === "POST") {
    if (!authorize(req, url, res)) return;
    const params = await readBody(req);
    const businessId = cleanId(params.businessId || "demo");
    const phone = String(params.phone || params.from || "+15555550100").trim().slice(0, 40);
    const name = String(params.name || "Test caller").trim().slice(0, 80);
    const result = await ingest({
      businessId,
      channel: "missed_call",
      source: "missed_call",
      phone,
      from: phone,
      name,
      message: String(params.message || "").slice(0, 500),
      test: true,
      demo: true,
      forceNew: true,
      ai: false,
    });
    if (result.lead?.id) {
      recordEvent({
        businessId,
        leadId: result.lead.id,
        type: "test_recovery",
        actor: "owner",
        summary: "Test missed-call recovery. Simulated. Not a live text and not verified revenue.",
      });
    }
    return json(res, result.created ? 201 : 200, {
      ok: Boolean(result.ok),
      test: true,
      simulated: true,
      note: "Test recovery. Reply was simulated. This is not a live text and not verified revenue.",
      lead: result.lead,
      delivery: result.delivery,
    });
  }

  if (pathname === "/api/entitlements" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || "demo";
    return json(res, 200, { ok: true, businessId, ...entitlementsReport(businessId) });
  }

  if (pathname === "/api/account" && method === "DELETE") {
    if (!authorize(req, url, res)) return;
    const params = await readBody(req);
    const businessId = String(params.businessId || searchParams.get("businessId") || "").trim().slice(0, 80);
    const result = deleteBusinessAccount(businessId, { confirm: params.confirm });
    if (!result.ok) return json(res, result.error === "confirm_required" ? 400 : 403, result);
    return json(res, 200, result);
  }

  if ((pathname === "/api/account/export" || pathname === "/api/account") && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = String(searchParams.get("businessId") || "").trim().slice(0, 80);
    const result = exportBusinessAccount(businessId);
    if (!result.ok) return json(res, 400, result);
    const download = searchParams.get("download") === "1" || pathname === "/api/account/export";
    if (download) {
      return send(res, 200, JSON.stringify(result, null, 2), {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="ringback-${businessId}-export.json"`,
      });
    }
    return json(res, 200, result);
  }

  if (pathname === "/api/notifications" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || undefined;
    return json(res, 200, { ok: true, notifications: listNotifications(businessId, 50) });
  }

  const notifMatch = pathname.match(/^\/api\/notifications\/([A-Za-z0-9_]+)$/);
  if (notifMatch && (method === "PATCH" || method === "POST")) {
    if (!authorize(req, url, res)) return;
    const updated = markNotificationRead(notifMatch[1]);
    if (!updated) return json(res, 404, { ok: false, error: "notification_not_found" });
    return json(res, 200, { ok: true, notification: updated });
  }

  if (pathname === "/api/follow-up/run" && method === "POST") {
    if (!authorize(req, url, res)) return;
    const params = await readBody(req);
    const businessId = params.businessId || "demo";
    if (automationPaused(businessId)) {
      return json(res, 200, { ok: true, count: 0, results: [], skipped: "automation_paused" });
    }
    const result = await runDueJobs({
      businessId,
      business: resolveBusinessConfig(businessId),
      getLead,
      getConversation: (leadId) => {
        const lead = getLead(leadId);
        return lead?.conversationId ? getConversation(lead.conversationId) : null;
      },
      send: async (job) => {
        const lead = getLead(job.leadId);
        const result = await ingest({
          leadId: job.leadId,
          businessId,
          channel: job.channel || lead?.channel || "sms",
          message: "",
          outboundOnly: true,
          outboundText: job.text,
          ai: false,
        });
        const delivery = result.delivery || {};
        return {
          sent: Boolean(result.ok) && delivery.status !== "failed" && delivery.status !== "not_configured",
          simulated: delivery.simulated !== false,
          status: delivery.status,
          error: delivery.error,
          reason: delivery.reason,
        };
      },
    });
    return json(res, 200, { ok: true, ...result });
  }

  if (pathname === "/api/demo/seed" && method === "POST") {
    if (!authorize(req, url, res)) return;
    const result = await seedDemoLeads();
    return json(res, 201, {
      ...result,
      demo: true,
      note: "Demo recoveries are labeled demo. They do not count as verified dollars.",
    });
  }

  if (pathname === "/api/connect/twilio" && method === "GET") {
    if (!authorize(req, url, res)) return;
    return json(res, 200, { ok: true, ...smsStatus(), webhooks: smsWebhooks() });
  }

  // Connect the shop's own number. RingBack never flips carrier forwarding.
  if (pathname === "/api/connect/number" && method === "GET") {
    if (!authorize(req, url, res)) return;
    const businessId = searchParams.get("businessId") || "demo";
    const saved = getSettings(businessId) || {};
    const status = connectNumberStatus({
      shopPhone: saved.shopPhone || "",
      ownerPhone: saved.ownerPhone || resolveBusinessConfig(businessId).notifications?.phone || "",
      hours: resolveBusinessConfig(businessId).hours || "",
      carrier: saved.carrier || "other",
      forwarded: saved.forwarded === true,
    });
    return json(res, 200, { ok: true, businessId, saved: { ...saved }, carriers: carrierList(), ...status });
  }

  if (pathname === "/api/connect/number" && method === "POST") {
    if (!authorize(req, url, res)) return;
    const params = await readBody(req);
    const businessId = cleanId(params.businessId || "demo");
    const current = getSettings(businessId) || {};
    const shopPhone = String(params.shopPhone ?? current.shopPhone ?? "").slice(0, 40);
    const ownerPhone = String(params.ownerPhone ?? current.ownerPhone ?? "").slice(0, 40);
    const carrier = String(params.carrier ?? current.carrier ?? "other").slice(0, 40);
    const forwarded = params.forwarded === undefined ? current.forwarded === true : params.forwarded === true;
    const settings = saveSettings(businessId, { shopPhone, ownerPhone, carrier, forwarded });
    const biz = resolveBusinessConfig(businessId);
    if (ownerPhone) saveBusiness(normalizeBusiness({ ...biz, notifications: { ...biz.notifications, phone: ownerPhone } }));
    trackEvent({ type: "number_connected", label: carrier, businessId });
    const status = connectNumberStatus({ shopPhone, ownerPhone, hours: biz.hours || "", carrier, forwarded });
    return json(res, 200, { ok: true, businessId, saved: { shopPhone, ownerPhone, carrier, forwarded }, settings, carriers: carrierList(), ...status });
  }

  if (pathname === "/api/outreach" && method === "GET") {
    if (!authorize(req, url, res)) return;
    return json(res, 200, {
      ...outreachSummary(),
      prospects: listProspects().slice(0, 50),
      demoLink: demoLink(),
    });
  }

  if (pathname === "/api/outreach" && method === "POST") {
    if (!authorize(req, url, res)) return;
    const params = await readBody(req);
    const result = addProspect(params);
    if (!result.ok) return json(res, 400, result);
    return json(res, 201, { ...result, draft: draftEmail(result.prospect) });
  }

  if (pathname === "/api/outreach/draft" && method === "POST") {
    if (!authorize(req, url, res)) return;
    const params = await readBody(req);
    const draft = draftEmail(params);
    return json(res, 200, { ...draft, sent: false });
  }

  if (pathname === "/api/analyze" && method === "POST") {
    const params = await readBody(req);
    return json(res, 200, { ok: true, intent: classifyIntent(params.message || ""), urgent: isUrgent(params.message || "") });
  }

  // ---------------------------------------------------------------- static

  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    if (authEnforced() && !sessionFromRequest(req)) {
      return redirect(res, "/login?next=%2Fdashboard");
    }
    return serveFile(res, "dashboard.html");
  }

  if (pathname === "/login" || pathname === "/login/") {
    if (sessionFromRequest(req)) return redirect(res, "/dashboard");
    return serveFile(res, "login.html");
  }

  if (pathname === "/" || pathname === "/index.html") {
    return serveFile(res, "index.html");
  }

  if (pathname === "/hvac" || pathname === "/hvac.html") {
    return serveFile(res, "hvac.html");
  }

  if (pathname === "/robots.txt") {
    return send(res, 200, "User-agent: *\nAllow: /\n", { "Content-Type": "text/plain; charset=utf-8" });
  }

  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const full = join(PUBLIC, safe);
  if (full.startsWith(PUBLIC) && existsSync(full) && !safe.endsWith("/")) {
    const data = await readFile(full);
    return send(res, 200, data, { "Content-Type": MIME[extname(full)] || "application/octet-stream" });
  }

  return send(res, 404, "Not found", { "Content-Type": "text/plain" });
}

async function serveFile(res, name) {
  const full = join(PUBLIC, name);
  if (!existsSync(full)) return send(res, 404, "Not found", { "Content-Type": "text/plain" });
  const data = await readFile(full);
  return send(res, 200, data, { "Content-Type": "text/html; charset=utf-8" });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      return send(res, 204, "", {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Credentials": "true",
      });
    }
    await route(req, res, url);
  } catch (err) {
    console.error("request_error", err?.message || err);
    json(res, 500, { ok: false, error: "internal_error" });
  }
});

ensureBootstrapUser();

server.listen(PORT, HOST, () => {
  console.log(`RingBack running at http://${HOST}:${PORT}`);
  console.log(`Storage: ${hasSqlite() ? "sqlite" : "json"} (${dbPath()})`);
  const sms = smsStatus();
  console.log(`SMS sending: ${sms.ready ? "LIVE (Twilio configured)" : "simulated (set Twilio env to go live)"}`);
  console.log(`AI replies: ${aiReady() ? "LIVE (USER_LLM_* configured)" : "off (deterministic engine)"}`);
  const bill = billingStatus();
  console.log(`Billing: ${bill.ready ? `LIVE mode=${bill.mode}` : "not configured (set RB_PAYMENT_LINK_* or RB_PAYPAL_ME)"}`);
  const auth = authStatus();
  console.log(`Auth: ${auth.enforced ? "ENFORCED" : "open"} (${auth.users} user${auth.users === 1 ? "" : "s"})`);
});

export { server, PLANS };
