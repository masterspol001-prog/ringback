import { getPlan } from "./plans.js";
import { listLeads, listPayments } from "./store.js";
import { engine } from "./db.js";
import { getSettings } from "./domain.js";

export const PLAN_LIMITS = {
  starter: { numbers: 1, locations: 1, smsPerMonth: 500, conversations: 200, followUps: 3 },
  professional: { numbers: 2, locations: 2, smsPerMonth: 2000, conversations: 1000, followUps: 3 },
  business: { numbers: 10, locations: 10, smsPerMonth: 10000, conversations: 5000, followUps: 5 },
};

export function limitsFor(planId) {
  const plan = getPlan(planId);
  const key = plan ? plan.id : "starter";
  return { plan: key, ...PLAN_LIMITS[key] };
}

export function planForBusiness(businessId) {
  const settings = getSettings(businessId) || {};
  const paid = listPayments().find((p) => p.businessId === businessId || p.setupId === businessId);
  return String(settings.plan || paid?.plan || "starter").toLowerCase();
}

function monthStartIso(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function usageFor(businessId, now = new Date()) {
  const since = monthStartIso(now);
  const leads = listLeads(businessId).filter((l) => (l.createdAt || "") >= since);
  const messages = engine.listDocuments("messages", { businessId, since, order: "asc" });
  const outbound = messages.filter((m) => m.direction === "out");
  const liveSms = outbound.filter((m) => ["sent", "delivered", "undelivered"].includes(m.status) && (m.channel === "sms" || m.channel === "missed_call"));
  const jobs = engine.listDocuments("follow_up_jobs", { businessId, since, order: "asc" });
  const settings = getSettings(businessId) || {};
  const numbers = [settings.shopPhone].filter(Boolean).length;
  return {
    periodStart: since,
    sms: liveSms.length,
    conversations: leads.length,
    followUps: jobs.length,
    numbers,
    locations: 1,
    attemptedSms: outbound.length,
  };
}

export function checkEntitlement(businessId, kind, now = new Date()) {
  const planId = planForBusiness(businessId);
  const limits = limitsFor(planId);
  const usage = usageFor(businessId, now);
  const map = {
    sms: { used: usage.sms, limit: limits.smsPerMonth },
    conversations: { used: usage.conversations, limit: limits.conversations },
    numbers: { used: usage.numbers, limit: limits.numbers },
    followUps: { used: usage.followUps, limit: limits.followUps * Math.max(1, usage.conversations) },
  };
  const row = map[kind] || { used: 0, limit: Infinity };
  const ok = row.used < row.limit;
  return {
    ok,
    kind,
    used: row.used,
    limit: row.limit,
    plan: limits.plan,
    reason: ok ? null : "usage_limit",
  };
}

export function entitlementsReport(businessId, now = new Date()) {
  const planId = planForBusiness(businessId);
  const limits = limitsFor(planId);
  const usage = usageFor(businessId, now);
  return {
    plan: limits.plan,
    limits,
    usage,
    blocked: {
      sms: usage.sms >= limits.smsPerMonth,
      conversations: usage.conversations >= limits.conversations,
      numbers: usage.numbers >= limits.numbers,
    },
    note: "Limits are enforced on the server. Live SMS over the monthly cap is recorded, not sent.",
  };
}
