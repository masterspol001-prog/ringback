// Follow-up engine.
//
// Follow-ups are real, scheduled, testable jobs - not just text generated at
// lead time. Each job has a run time and a status, and it is skipped the moment
// the reason for it disappears (the customer replied, booked, opted out, the
// business disabled follow-up, or the lead closed).

import { addFollowUpJob, listFollowUpJobs, updateFollowUpJob, cancelFollowUpJobs } from "./domain.js";
import { isQuietHours, nextQuietHoursEnd } from "./hours.js";
import { smsReady } from "./sms.js";

export const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 15 * 60 * 1000;

export const DEFAULT_STEPS = [
  { delayHours: 4, kind: "check_in" },
  { delayHours: 24, kind: "last_nudge" },
  { delayHours: 72, kind: "close_out" },
];

export function stepsFor(business) {
  const configured = business?.followUp?.steps;
  if (Array.isArray(configured) && configured.length) {
    return configured.map((s, i) => ({ delayHours: Number(s.delayHours) || 0, kind: s.kind || `step_${i + 1}`, text: s.text }));
  }
  return DEFAULT_STEPS;
}

export function buildFollowUpText({ business, lead, step, qualification = {} }) {
  if (step.text) return step.text;
  const who = lead?.name && lead.name !== "Unknown" ? String(lead.name).split(/\s+/)[0] : "";
  const prefix = who ? `${who}, just` : "Just";
  const service = qualification.service || business.trade || "your project";

  if (step.kind === "immediate") {
    return `Sorry we missed you${who ? ", " + who : ""}. This is ${business.name} (texting on behalf of ${business.name}). Still need help with ${service}? Reply and I'll get you a time. Reply STOP to opt out.`;
  }
  if (step.kind === "check_in") {
    return `${prefix} checking whether you still need help with ${service}. Reply YES and I'll get you a time. Reply STOP to opt out.`;
  }
  if (step.kind === "last_nudge") {
    const link = business.bookingUrl ? ` Here's the link: ${business.bookingUrl}` : " Reply BOOK and I'll send times.";
    return `Still looking for someone to help with ${service}?${link}`;
  }
  if (step.kind === "close_out") {
    return `We'll close this out for now. Reply anytime and we'll pick it right back up. - ${business.name}`;
  }
  return `${prefix} checking in about ${service}.`;
}

// Creates the pending jobs for a lead. Only runs when follow-up is enabled.
export function scheduleFollowUps({ business, lead, conversation, qualification = {} }) {
  if (business?.followUp?.enabled === false) return { scheduled: 0, jobs: [] };

  cancelFollowUpJobs(lead.id, "rescheduled");
  const base = Date.now();
  const created = [];
  for (const step of stepsFor(business)) {
    const runAt = new Date(base + Math.max(0, Number(step.delayHours) || 0) * 3600_000).toISOString();
    const job = addFollowUpJob({
      businessId: lead.businessId,
      leadId: lead.id,
      conversationId: conversation?.id || lead.conversationId || null,
      channel: lead.channel || "sms",
      step: created.length + 1,
      text: buildFollowUpText({ business, lead, step, qualification }),
      runAt,
      status: "pending",
      reason: step.kind || null,
    });
    created.push(job);
  }
  return { scheduled: created.length, jobs: created };
}

export function cancelForLead(leadId, reason = "cancelled") {
  return cancelFollowUpJobs(leadId, reason);
}

// Why a job must not fire. Returns null when it is still safe to send.
export function stopReason({ business, lead, conversation, lastInboundAt, now = Date.now() }) {
  if (!lead) return "lead_missing";
  if (business?.followUp?.enabled === false) return "disabled";
  if (lead.doNotContact || lead.optedOut) return "do_not_contact";
  if (lead.followUpStatus && lead.followUpStatus !== "active") return "stopped";
  if (["booked", "won", "lost", "unqualified", "spam", "do_not_contact"].includes(lead.status)) return "closed";
  if (conversation && (conversation.ownerMode === true || ["completed", "escalated", "paused"].includes(conversation.state))) return "conversation_closed";
  if (lead.severity === "emergency") return "emergency";
  if (lead.failureState === "sms_unavailable" || lead.failureState === "invalid_phone") return "unreachable";
  if (lastInboundAt && lastInboundAt >= new Date(now).toISOString()) return "responded";
  if (smsReady() && isQuietHours(business, new Date(now))) return "quiet_hours";
  return null;
}

export function dueJobs(businessId, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  return listFollowUpJobs({ businessId, status: "pending" }).filter((j) => (j.runAt || "") <= stamp);
}

// Executes due jobs. `send` is injected so this stays testable and so the
// caller decides whether delivery is live or simulated.
export async function runDueJobs({ businessId, business, getLead, getConversation, getLastInboundAt, send, now = Date.now() }) {
  const jobs = dueJobs(businessId, now);
  const results = [];
  for (const job of jobs) {
    const lead = getLead(job.leadId);
    const conversation = getConversation(job.leadId);
    const lastInboundAt = getLastInboundAt ? getLastInboundAt(job.leadId) : null;
    const reason = stopReason({ business, lead, conversation, lastInboundAt, now });
    if (reason === "quiet_hours") {
      const resumeAt = nextQuietHoursEnd(business, new Date(now)).toISOString();
      updateFollowUpJob(job.id, { status: "pending", reason: "quiet_hours", runAt: resumeAt });
      results.push({ jobId: job.id, leadId: job.leadId, sent: false, skipped: "quiet_hours", runAt: resumeAt });
      continue;
    }
    if (reason) {
      updateFollowUpJob(job.id, { status: reason === "responded" || reason === "closed" ? "skipped" : "cancelled", reason });
      results.push({ jobId: job.id, leadId: job.leadId, sent: false, skipped: reason });
      continue;
    }
    const delivery = send ? await send(job) : { sent: false, simulated: true, status: "simulated" };
    if (delivery && (delivery.status === "failed" || delivery.status === "not_configured") && delivery.reason !== "quiet_hours") {
      const attempts = (Number(job.attempts) || 0) + 1;
      if (attempts >= MAX_SEND_ATTEMPTS || delivery.error === "sms_unavailable" || delivery.error === "invalid_phone") {
        updateFollowUpJob(job.id, { status: "cancelled", reason: delivery.error || delivery.reason || "send_failed", attempts });
        results.push({ jobId: job.id, leadId: job.leadId, sent: false, delivery, attempts, skipped: "max_retries" });
        continue;
      }
      const retryAt = new Date(now + RETRY_DELAY_MS).toISOString();
      updateFollowUpJob(job.id, { status: "pending", reason: delivery.error || delivery.reason || "send_failed", attempts, runAt: retryAt });
      results.push({ jobId: job.id, leadId: job.leadId, sent: false, delivery, attempts, runAt: retryAt });
      continue;
    }
    updateFollowUpJob(job.id, { status: "sent", sentAt: new Date(now).toISOString(), reason: delivery.status || null, attempts: (Number(job.attempts) || 0) + 1 });
    results.push({ jobId: job.id, leadId: job.leadId, sent: true, delivery });
  }
  return { count: results.length, results };
}
