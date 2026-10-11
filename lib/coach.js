// Owner productivity coach.
//
// Deterministic by default: ranks open recoveries and writes call/SMS scripts
// from facts already on the lead. No LLM required. Optional USER_LLM_* polish
// rewrites tone only and is rejected if it invents a price.

import { isTerminal, normalizeStatus } from "./lifecycle.js";
import { aiReady, polishOwnerScript, validateDraft } from "./ai.js";

export const COACH_VERSION = "ringback-coach-v1";

const PRIORITY_RANK = { now: 4, today: 3, soon: 2, done: 1 };

function nowMs(now) {
  const t = now ? Date.parse(now) : Date.now();
  return Number.isFinite(t) ? t : Date.now();
}

function ageMinutes(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((nowMs(now) - t) / 60000));
}

function firstName(lead) {
  const name = String(lead?.name || "").trim();
  if (!name || name === "Unknown") return "";
  return name.split(/\s+/)[0];
}

function serviceOf(lead, business) {
  return lead?.qualification?.service || business?.trade || "the job";
}

function shop(business) {
  return business?.name || "the shop";
}

function safeScript(text, business) {
  const check = validateDraft(text, business || {});
  if (check.ok) return check.text;
  return String(text || "")
    .replace(/\$\s?\d[\d,]*(\.\d{1,2})?/g, "the price we confirm after we see the job")
    .trim()
    .slice(0, 700);
}

function missingFields(lead) {
  const qual = lead?.qualification || {};
  const missing = [];
  if (!qual.service) missing.push("service");
  if (!(qual.area || qual.address)) missing.push("address");
  if (!qual.timing) missing.push("timing");
  if (!lead?.phone) missing.push("phone");
  return missing;
}

function intelFrom({ lead, conversation, appointments = [] }) {
  const qual = lead?.qualification || {};
  const paused = conversation?.ownerMode === true || conversation?.state === "paused";
  const revenueKind = lead?.status === "won" ? "verified" : (lead?.status === "booked" ? "estimated" : "pipeline");
  return {
    paused,
    pausedReason: paused ? (conversation?.pausedReason || "Owner took over the conversation.") : "",
    urgent: Boolean(lead?.urgent),
    qualification: qual,
    estimatedValue: lead?.estimatedValue ?? lead?.jobValue ?? null,
    appointmentStatus: appointments.length ? appointments[appointments.length - 1].status : null,
    location: qual.area || qual.address || "",
    heat: lead?.score?.bucket || "cold",
    revenueKind,
    nextAction: paused ? "Owner is handling this. Return to AI when ready." : "",
  };
}

function classifyKind(lead, conversation, intel) {
  const status = normalizeStatus(lead?.status) || "new";
  if (isTerminal(status)) return "close";
  if (intel.paused || conversation?.ownerMode) return "call";
  if (lead?.urgent || intel.urgent) return "call";
  if (status === "booked") return "confirm";
  if (status === "booking_requested") return "text";
  if (!missingFields(lead).includes("service") && !missingFields(lead).includes("address") && !missingFields(lead).includes("timing")) {
    return "call";
  }
  return "text";
}

function rank({ lead, conversation, intel, followUps = [], now }) {
  const status = normalizeStatus(lead?.status) || "new";
  if (isTerminal(status)) {
    return { priority: "done", score: 0, reason: status === "won" ? "Job already marked won." : "Lead is closed." };
  }

  const age = ageMinutes(conversation?.lastMessageAt || lead?.updatedAt || lead?.createdAt, now);
  const heat = lead?.score?.bucket || intel.heat || "cold";
  const missing = missingFields(lead);
  const ready = missing.filter((f) => f !== "phone").length === 0;
  const dueFollow = followUps.some((j) => j.status === "pending" && Date.parse(j.runAt) <= nowMs(now));

  if (lead?.urgent || intel.urgent) {
    return { priority: "now", score: 1000 + Math.min(age, 240), reason: "Urgent. Call before the customer calls someone else." };
  }
  if (intel.paused || conversation?.ownerMode) {
    return { priority: "now", score: 920 + Math.min(age, 180), reason: "You took this over. Finish the call or return it to RingBack." };
  }
  if (status === "booked") {
    return { priority: "today", score: 640 + Math.min(age, 480), reason: "Appointment is booked. Confirm the visit, then mark won with the real invoice amount." };
  }
  if (ready && status !== "booking_requested") {
    return { priority: "now", score: 860 + Math.min(age, 180), reason: "Ready to book. Offer times from your calendar." };
  }
  if (status === "booking_requested" && age >= 120) {
    return { priority: "today", score: 780 + Math.min(age, 360), reason: "Times were offered. Follow up if they have not picked a slot." };
  }
  if (status === "booking_requested") {
    return { priority: "today", score: 720, reason: "Waiting on a time choice. Nudge if they go quiet." };
  }
  if (heat === "hot" && lead?.source === "missed_call") {
    return { priority: "now", score: 800 + Math.min(age, 180), reason: "Hot missed call. Call back or send the next text." };
  }
  if (dueFollow) {
    return { priority: "today", score: 700, reason: "A follow-up is due. Send it or call." };
  }
  if (missing.length && heat === "hot") {
    return { priority: "today", score: 660, reason: `Still missing ${missing.join(", ")}.` };
  }
  if (status === "qualified" || status === "engaged") {
    return { priority: "today", score: 520 + (heat === "warm" ? 40 : 0), reason: "In motion. Keep them moving toward a booked slot." };
  }
  if (heat === "warm" || status === "contacted") {
    return { priority: "soon", score: 360 + Math.min(age / 2, 120), reason: "Warm. A short check-in keeps this from going cold." };
  }
  return { priority: "soon", score: 200, reason: "Open lead. Handle after hotter recoveries." };
}

function callScript({ lead, business, intel, missing, rankInfo }) {
  const name = firstName(lead);
  const hi = name ? `Hi ${name}, ` : "Hi, ";
  const svc = serviceOf(lead, business);
  const loc = intel.location ? ` at ${intel.location}` : "";
  const when = intel.qualification?.timing ? ` You mentioned ${intel.qualification.timing}.` : "";

  if (lead?.urgent || intel.urgent) {
    return safeScript(
      `${hi}this is ${shop(business)} calling you back. We saw this is urgent — ${svc}${loc}.${when} Are you still in the same spot? I can get you on the schedule. What is the best address and a window that works?`,
      business,
    );
  }
  if (intel.paused) {
    return safeScript(
      `${hi}this is ${shop(business)}. I have your note about ${svc}${loc}. I am taking this personally — tell me what you need and I will get it handled.`,
      business,
    );
  }
  if (missing.includes("service")) {
    return safeScript(
      `${hi}this is ${shop(business)} calling you back. What do you need help with — repair, install, or a tune-up?`,
      business,
    );
  }
  if (missing.includes("address")) {
    return safeScript(
      `${hi}this is ${shop(business)}. We can help with ${svc}. What is the service address?`,
      business,
    );
  }
  if (missing.includes("timing")) {
    return safeScript(
      `${hi}this is ${shop(business)}. We can help with ${svc}${loc}. When do you need someone there?`,
      business,
    );
  }
  if (rankInfo.priority === "now" || !missing.filter((f) => f !== "phone").length) {
    return safeScript(
      `${hi}this is ${shop(business)}. We can get ${svc}${loc} on the schedule.${when} I have openings — what window works for you? I will confirm the price after we see the job.`,
      business,
    );
  }
  return safeScript(
    `${hi}this is ${shop(business)} calling you back about ${svc}. Do you still need help?`,
    business,
  );
}

function smsScript({ lead, business, intel, missing, rankInfo }) {
  const name = firstName(lead);
  const prefix = name ? `${name}, ` : "";
  const svc = serviceOf(lead, business);
  const loc = intel.location ? ` at ${intel.location}` : "";
  const booking = business?.bookingUrl ? ` Book here: ${business.bookingUrl}` : " Reply with a window that works.";
  const offer = business?.offer ? ` ${business.offer}.` : "";

  if (normalizeStatus(lead?.status) === "booked") {
    return safeScript(
      `${prefix}this is ${shop(business)}. Checking that the ${svc} visit is still on. Reply YES if we are good, or send a better window.`,
      business,
    );
  }
  if (lead?.urgent || intel.urgent) {
    return safeScript(
      `${prefix}this is ${shop(business)}. Got your urgent ${svc} request${loc}. Reply with the address and a window and I will get you on the schedule.${offer}`,
      business,
    );
  }
  if (intel.paused) {
    return safeScript(
      `${prefix}this is the owner at ${shop(business)}. I have your ${svc} request. What is the one thing you need from me right now?`,
      business,
    );
  }
  if (missing.includes("service")) {
    return safeScript(
      `${prefix}this is ${shop(business)}. What do you need help with — repair, install, or a tune-up?`,
      business,
    );
  }
  if (missing.includes("address")) {
    return safeScript(
      `${prefix}this is ${shop(business)}. We can help with ${svc}. What is the service address?`,
      business,
    );
  }
  if (missing.includes("timing")) {
    return safeScript(
      `${prefix}this is ${shop(business)}. We can help with ${svc}${loc}. When do you need someone there?`,
      business,
    );
  }
  if (!missing.filter((f) => f !== "phone").length || rankInfo.priority === "now") {
    return safeScript(
      `${prefix}this is ${shop(business)}. We can get ${svc}${loc} booked.${booking} I will confirm the price after we see the job.`,
      business,
    );
  }
  return safeScript(
    `${prefix}just checking whether you still need help with ${svc}. Reply YES and I will get you a time.`,
    business,
  );
}

export function coachLead({ lead, conversation, appointments = [], followUps = [], business = {}, now } = {}) {
  const intel = intelFrom({ lead, conversation, appointments });
  const missing = missingFields(lead);
  const rankInfo = rank({ lead, conversation, intel, followUps, now });
  const kind = classifyKind(lead, conversation, intel);
  const call = callScript({ lead, business, intel, missing, rankInfo });
  const sms = smsScript({ lead, business, intel, missing, rankInfo });
  const nextAction = rankInfo.priority === "done" ? intel.nextAction : rankInfo.reason;

  return {
    leadId: lead?.id || null,
    name: lead?.name || "",
    phone: lead?.phone || "",
    status: lead?.status || "new",
    heat: intel.heat,
    urgent: Boolean(lead?.urgent || intel.urgent),
    paused: Boolean(intel.paused),
    priority: rankInfo.priority,
    score: rankInfo.score,
    reason: rankInfo.reason,
    nextAction,
    kind,
    missing,
    estimatedValue: intel.estimatedValue,
    revenueKind: intel.revenueKind,
    ageMinutes: ageMinutes(conversation?.lastMessageAt || lead?.updatedAt || lead?.createdAt, now),
    script: {
      call,
      sms,
      why: rankInfo.reason,
    },
    engine: "deterministic",
    version: COACH_VERSION,
  };
}

export function coachQueue({
  leads = [],
  getConversation,
  getAppointments,
  getFollowUps,
  business = {},
  now,
  limit = 8,
} = {}) {
  const items = [];
  for (const lead of leads) {
    const status = normalizeStatus(lead?.status) || "new";
    if (isTerminal(status)) continue;
    const conversation = typeof getConversation === "function" ? getConversation(lead) : null;
    const appointments = typeof getAppointments === "function" ? getAppointments(lead) : [];
    const followUps = typeof getFollowUps === "function" ? getFollowUps(lead) : [];
    items.push(coachLead({ lead, conversation, appointments, followUps, business, now }));
  }
  items.sort((a, b) => {
    const pr = (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0);
    if (pr) return pr;
    return (b.score || 0) - (a.score || 0);
  });
  const cap = Math.max(1, Math.min(25, Number(limit) || 8));
  return items.slice(0, cap);
}

export async function polishCoachItem(item, business = {}) {
  if (!item?.script) return item;
  if (!aiReady()) return { ...item, engine: "deterministic", polish: { used: false, reason: "not_configured" } };

  const sms = await polishOwnerScript({ text: item.script.sms, business, kind: "sms" });
  const call = await polishOwnerScript({ text: item.script.call, business, kind: "call" });
  const nextSms = sms.used ? sms.text : item.script.sms;
  const nextCall = call.used ? call.text : item.script.call;
  const used = Boolean(sms.used || call.used);
  return {
    ...item,
    script: { ...item.script, sms: nextSms, call: nextCall },
    engine: used ? "ai" : "deterministic",
    polish: {
      used,
      sms: sms.used,
      call: call.used,
      reason: used ? undefined : sms.reason || call.reason,
    },
  };
}
