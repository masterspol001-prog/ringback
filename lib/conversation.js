// The recovery loop orchestrator.
//
// This is where a missed call becomes a recovered customer:
//   missed call/message -> customer -> lead -> receptionist conversation ->
//   qualification -> booking -> follow-up -> owner alert -> revenue
//
// Every step writes to storage and to the event log, so the dashboard, the lead
// timeline, and the report all read from the same source of truth.

import { generateReply, normalizeChannel, channelLabel, scoreLead, TEMPLATES, inServiceArea } from "./engine.js";
import { normalizeBusiness, activationChecklist } from "./business.js";
import { decide, explainLeadValue, RECEPTIONIST_VERSION } from "./reception.js";
import { applyStatus, revenueStateFrom } from "./lifecycle.js";
import { aiReady, aiReceptionistDecide } from "./ai.js";
import { smsReady, sendSms, validPhone, withSenderIdentity } from "./sms.js";
import { getSettings, findProcessedEvent, recordProcessedEvent } from "./domain.js";
import { ownerAlert, ownerPing } from "./handoff.js";
import { hoursStatus, isQuietHours } from "./hours.js";
import { slotToAppointment } from "./booking.js";
import { checkEntitlement } from "./entitlements.js";
import { STATUS } from "./integrations.js";
import {
  addLead, getLead, updateLead, nextId, getBusiness, findOpenLeadByPhone, findRecentLeadByPhone,
} from "./store.js";
import {
  findOrCreateCustomer, updateCustomer, createConversation, getConversation,
  getConversationByLead, updateConversation, addMessage, listLeadMessages,
  recordEvent, addNotification, saveAppointment, listLeadAppointments,
} from "./domain.js";
import { scheduleFollowUps, cancelForLead } from "./followup.js";

export { RECEPTIONIST_VERSION };

function nowIso() {
  return new Date().toISOString();
}

function clean(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

// Resolves the business config for a request, always returning a complete shape.
export function resolveBusinessConfig(businessId, override) {
  const stored = getBusiness(businessId) || {};
  const base = { ...TEMPLATES.DEFAULT_BUSINESS, ...stored, id: businessId };
  return normalizeBusiness({ ...base, ...(override || {}), id: businessId });
}

// Channel-aware delivery. Never claims success it did not have.
export function automationPaused(businessId) {
  const settings = getSettings(businessId || "demo") || {};
  return settings.automationPaused === true;
}

export async function deliverOutbound({ lead, channel, text, business, test = false }) {
  const ch = normalizeChannel(channel);
  const body = withSenderIdentity(text, business || {});
  const bizId = lead?.businessId || business?.id || "demo";
  if (test) {
    return { status: "simulated", simulated: true, transport: ch, reason: "test_recovery", text: body };
  }
  if (automationPaused(bizId) && !["webchat", "web_form"].includes(ch)) {
    return { status: "not_configured", simulated: true, transport: ch, reason: "automation_paused", text: body };
  }
  if (["webchat", "web_form", "facebook", "instagram"].includes(ch)) {
    return { status: "sent", simulated: false, transport: "in_app", providerRef: null, text: body };
  }
  if (ch === "email") {
    return { status: "not_configured", simulated: true, transport: "email", reason: "email_not_configured", text: body };
  }
  if (!lead?.phone) {
    return { status: "not_configured", simulated: true, transport: ch, reason: "no_phone", text: body };
  }
  if (!validPhone(lead.phone)) {
    return { status: "failed", simulated: false, transport: "sms", error: "invalid_phone", text: body };
  }
  if (!smsReady()) {
    return { status: "simulated", simulated: true, transport: "sms", reason: "twilio_not_configured", text: body };
  }
  const gate = activationChecklist(business || {});
  if (!gate.ready) {
    return { status: "not_configured", simulated: true, transport: "sms", reason: "activation_incomplete", missing: gate.missing, text: body };
  }
  const cap = checkEntitlement(bizId, "sms");
  if (!cap.ok) {
    return { status: "not_configured", simulated: true, transport: "sms", reason: "usage_limit", used: cap.used, limit: cap.limit, text: body };
  }
  const result = await sendSms(lead.phone, body);
  if (result.sent) return { status: "sent", simulated: false, transport: "sms", providerRef: result.sid || null, text: body };
  return { status: "failed", simulated: false, transport: "sms", error: result.error || "send_failed", text: body };
}

function upsertAppointment({ businessId, leadId, customerId, patch, service }) {
  const existing = listLeadAppointments(leadId);
  const latest = existing.length ? existing[existing.length - 1] : null;
  return saveAppointment({
    id: latest?.id,
    businessId,
    leadId,
    customerId,
    service,
    ...patch,
  });
}

// The main entry point. Creates a recovery from a new event, or advances an
// existing one when `leadId` is supplied (a customer reply).
export async function ingest(params = {}) {
  const impliedDemo = params.demo === true || String(params.businessId || "").startsWith("demo-");
  const businessId = clean(params.businessId, 80) || "demo";
  const business = resolveBusinessConfig(businessId, params.business);
  const channel = normalizeChannel(params.channel || params.source || "sms");
  const source = clean(params.source || (channel === "missed_call" ? "missed_call" : channel), 40);
  const inboundText = clean(params.message || "", 2000);
  const allowAi = params.ai !== false && params.ai !== "false" && business.ai.enabled !== false;
  const atClock = params.at ? new Date(params.at) : new Date();
  const hours = hoursStatus(business, atClock);
  const providerRef = clean(params.providerRef || params.CallSid || params.MessageSid || params.callSid || params.messageSid, 120);
  if (providerRef) {
    const seen = findProcessedEvent(providerRef);
    if (seen) {
      const existingLead = seen.leadId ? getLead(seen.leadId) : null;
      return {
        ok: true,
        created: false,
        duplicate: true,
        idempotent: true,
        lead: existingLead,
        customer: null,
        conversation: existingLead?.conversationId ? getConversation(existingLead.conversationId) : null,
        decision: null,
        reply: null,
        delivery: { status: "skipped", reason: "duplicate_webhook", simulated: true, providerRef },
        appointment: null,
        notification: null,
        messages: { inbound: null, outbound: null },
        events: ["duplicate_webhook"],
        hours,
      };
    }
  }

  let lead = params.leadId ? getLead(params.leadId) : null;
  if (params.leadId && !lead) {
    return { ok: false, error: "lead_not_found", leadId: params.leadId };
  }
  let duplicateOf = null;
  if (!lead && !params.forceNew) {
    const phoneHint = clean(params.phone || params.from, 40);
    if (phoneHint) {
      lead = findOpenLeadByPhone(phoneHint, businessId);
      if (!lead && source === "missed_call") {
        lead = findRecentLeadByPhone(phoneHint, businessId, 15 * 60 * 1000, atClock.getTime());
      }
    }
    if (lead) duplicateOf = lead.id;
  }

  const created = !lead;
  let conversation = null;
  let customer = null;
  const events = [];

  // ---- new recovery -------------------------------------------------------
  if (created) {
    const phone = clean(params.phone || params.from, 40);
    customer = findOrCreateCustomer(businessId, {
      name: clean(params.name, 120),
      phone,
      email: clean(params.email, 160),
      address: clean(params.address, 240),
    });

    // Seed the lead with the v1 deterministic fields (score, generated steps)
    // so reporting and CSV stay backward compatible.
    const seed = generateReply(inboundText, business, { name: params.name, channel, hour: new Date().getHours(), history: [] });
    const createdAt = nowIso();
    const fallbackMessage = `New ${channelLabel(channel)} inquiry${params.name ? ` from ${clean(params.name, 60)}` : ""}.`;

    if (phone && !validPhone(phone)) {
      events.push("invalid_phone");
    }
    lead = addLead({
      id: nextId("lead"),
      businessId,
      customerId: customer.id,
      conversationId: null,
      name: clean(params.name, 120) || "Unknown",
      phone,
      message: inboundText || fallbackMessage,
      source,
      channel,
      channelLabel: channelLabel(channel),
      intent: seed.intent,
        urgent: seed.urgent,
        severity: seed.severity || (seed.urgent ? "urgent" : "normal"),
        bookingState: "available",
        reply: seed.reply,
      followUp: [],
      engine: seed.engine,
      score: scoreLead({ message: inboundText, phone, source, severity: seed.severity, urgent: seed.urgent, qualification: {} }),
      status: "new",
      notes: "",
      jobValue: null,
      estimatedValue: null,
      revenueStatus: "unknown",
      qualification: {},
      stageAt: { new: createdAt },
      optedOut: false,
      doNotContact: false,
      followUpStatus: "active",
      afterHours: hours.afterHours === true,
      demo: impliedDemo,
      createdAt,
    });

    conversation = createConversation({
      businessId,
      leadId: lead.id,
      customerId: customer.id,
      channel,
      state: "greeting",
    });
    lead = updateLead(lead.id, { conversationId: conversation.id });

    if (source === "missed_call") {
      recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "missed_call", actor: "system", summary: "Missed call received.", data: { source, channel, at: createdAt } });
      events.push("missed_call");
    }
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "lead_created", actor: "system", summary: `Lead created from ${channelLabel(channel)}.`, data: { source, channel } });
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "customer_created", actor: "system", summary: `Customer ${customer.name || customer.phone || customer.id} on file.` });
    events.push("lead_created", "customer_created");
    if (providerRef) recordProcessedEvent({ providerRef, businessId, leadId: lead.id, kind: source });
    if (phone && !validPhone(phone)) {
      recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "invalid_phone", actor: "system", summary: "Phone number is invalid. Automated SMS will not send." });
    }
  } else {
    conversation = lead.conversationId ? getConversation(lead.conversationId) : getConversationByLead(lead.id);
    if (!conversation) {
      conversation = createConversation({ businessId, leadId: lead.id, customerId: lead.customerId, channel, state: "waiting_for_customer" });
      lead = updateLead(lead.id, { conversationId: conversation.id });
    }
    customer = lead.customerId ? { id: lead.customerId } : null;
    if (providerRef) recordProcessedEvent({ providerRef, businessId, leadId: lead.id, kind: source });
    if (duplicateOf) {
      recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "duplicate_lead", actor: "system", summary: "Matched an open lead for this phone. Continuing that conversation." });
      events.push("duplicate_lead");
      lead = updateLead(lead.id, { failureState: "duplicate_lead" });
      if (source === "missed_call" && !inboundText) {
        return {
          ok: true,
          created: false,
          duplicate: true,
          lead: getLead(lead.id),
          customer,
          conversation,
          decision: null,
          reply: null,
          delivery: { status: "skipped", reason: "duplicate_missed_call", simulated: true },
          appointment: null,
          notification: null,
          messages: { inbound: null, outbound: null },
          events,
        };
      }
    }
  }

  // ---- inbound message ----------------------------------------------------
  let inboundMessage = null;
  if (inboundText) {
    inboundMessage = addMessage({
      businessId,
      conversationId: conversation.id,
      leadId: lead.id,
      direction: "in",
      sender: "customer",
      channel,
      text: inboundText,
      status: "received",
      providerRef: providerRef || null,
    });
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "message_received", actor: "customer", summary: inboundText.slice(0, 140) });
    events.push("message_received");
    // A reply is the whole point of follow-up. Stop the sequence.
    cancelForLead(lead.id, "responded");
  }

  if (!params.outboundOnly && !params.ownerSend && !params.test && automationPaused(businessId)) {
    const at = nowIso();
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "automation_paused", actor: "system", summary: "Automation paused. No auto-reply sent." });
    events.push("automation_paused");
    lead = updateLead(lead.id, { failureState: "automation_paused", updatedAt: at });
    return {
      ok: true,
      created,
      paused: true,
      pausedReason: "Automation paused by owner.",
      lead: getLead(lead.id),
      customer,
      conversation,
      decision: null,
      reply: null,
      delivery: { status: "not_configured", reason: "automation_paused", simulated: true },
      appointment: null,
      notification: null,
      messages: { inbound: inboundMessage, outbound: null },
      events,
    };
  }

  // Owner takeover: keep the conversation open, log inbound, do not auto-reply.
  if (!params.outboundOnly && (conversation.ownerMode === true || conversation.state === "paused")) {
    const at = nowIso();
    const pausedUpdate = updateConversation(conversation.id, {
      lastMessageAt: inboundText ? at : conversation.lastMessageAt,
      turnCount: (conversation.turnCount || 0) + (inboundText ? 1 : 0),
      state: "paused",
      ownerMode: true,
    });
    if (pausedUpdate) conversation = pausedUpdate;
    return {
      ok: true,
      created,
      paused: true,
      pausedReason: conversation.pausedReason || "Owner took over the conversation.",
      lead: getLead(lead.id),
      customer,
      conversation,
      decision: null,
      reply: null,
      delivery: null,
      appointment: null,
      notification: null,
      messages: { inbound: inboundMessage, outbound: null },
      events,
    };
  }

  // Follow-up jobs already have copy. Sending that text must not re-greet.
  if (params.outboundOnly && params.outboundText) {
    const replyText = clean(params.outboundText, 2000);
    const delivery = await deliverOutbound({ lead, channel, text: replyText, business });
    const outboundMessage = addMessage({
      businessId,
      conversationId: conversation.id,
      leadId: lead.id,
      direction: "out",
      sender: params.ownerSend ? "owner" : "ai",
      channel,
      text: delivery.text || replyText,
      status: delivery.status,
      intent: lead.intent || "follow_up",
      providerRef: delivery.providerRef || null,
      error: delivery.error || null,
    });
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "message_sent", actor: "system", summary: replyText.slice(0, 140), data: { delivery: delivery.status, transport: delivery.transport, followUp: true } });
    events.push("message_sent");
    const at = nowIso();
    const followPatch = {
      reply: replyText,
      engine: "followup",
      updatedAt: at,
      deliveryStatus: delivery.status,
      sms: { status: delivery.status, reason: delivery.reason || delivery.error || null, simulated: delivery.simulated === true },
    };
    if (delivery.status === "failed") {
      followPatch.failureState = delivery.error === "invalid_phone" ? "invalid_phone" : (delivery.error === "sms_unavailable" ? "sms_unavailable" : "sms_failed");
    } else if (delivery.reason === "quiet_hours") {
      followPatch.failureState = "quiet_hours";
    } else if (delivery.reason === "usage_limit") {
      followPatch.failureState = "usage_limit";
    }
    lead = updateLead(lead.id, followPatch);
    return {
      ok: true,
      created,
      lead: getLead(lead.id),
      customer,
      conversation,
      decision: null,
      reply: replyText,
      delivery,
      appointment: null,
      notification: null,
      messages: { inbound: inboundMessage, outbound: outboundMessage },
      events,
    };
  }

  // ---- receptionist decision ---------------------------------------------
  const decision = decide({
    conversation,
    qualification: lead.qualification || {},
    message: inboundText,
    business,
    meta: { channel, name: lead.name },
  });

  let replyText = decision.reply;
  let engineName = decision.engine;
  let aiMeta = null;

  if (allowAi && aiReady()) {
    const history = listLeadMessages(lead.id).map((m) => ({ role: m.direction === "out" ? "out" : "in", text: m.text }));
    const ai = await aiReceptionistDecide({
      business,
      qualification: decision.qualification,
      message: inboundText,
      history,
      channel,
      intent: decision.intent,
    });
    if (ai.used) {
      replyText = ai.reply;
      engineName = ai.engine;
      aiMeta = { model: ai.model, promptVersion: ai.promptVersion };
      events.push("ai_response");
      recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "ai_response", actor: "ai", summary: "AI drafted the reply.", data: aiMeta });
    } else {
      recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "ai_fallback", actor: "system", summary: `AI unavailable (${ai.reason}); used deterministic reply.` });
    }
  }

  // ---- outbound message ---------------------------------------------------
  const queuedAt = nowIso();
  recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "message_queued", actor: "system", summary: "Reply queued.", data: { queuedAt } });
  events.push("message_queued");
  let delivery;
  const emergencyNow = decision.severity === "emergency" || decision.escalation?.reason === "emergency";
  const holdQuiet = smsReady() && !params.ownerSend && !params.test && !emergencyNow && isQuietHours(business, atClock) && ["sms", "missed_call", "whatsapp"].includes(channel);
  if (holdQuiet) {
    delivery = { status: "not_configured", simulated: true, transport: channel, reason: "quiet_hours", text: replyText };
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "quiet_hours", actor: "system", summary: "Quiet hours. Automated SMS was not sent." });
    events.push("quiet_hours");
  } else {
    delivery = await deliverOutbound({ lead, channel, text: replyText, business, test: params.test === true });
  }
  const sentAt = nowIso();
  const outboundMessage = addMessage({
    businessId,
    conversationId: conversation.id,
    leadId: lead.id,
    direction: "out",
    sender: "ai",
    channel,
    text: delivery.text || replyText,
    status: delivery.status,
    intent: decision.intent,
    providerRef: delivery.providerRef || null,
    error: delivery.error || null,
  });
  const deliveryType = delivery.status === "failed" ? "sms_failed" : (delivery.status === "simulated" || delivery.status === "not_configured" ? "sms_simulated" : "message_sent");
  recordEvent({
    businessId,
    leadId: lead.id,
    conversationId: conversation.id,
    type: deliveryType,
    actor: "ai",
    summary: delivery.status === "failed"
      ? `SMS send failed: ${delivery.error || "send_failed"}`
      : (delivery.status === "simulated" || delivery.status === "not_configured"
        ? `Reply simulated (${delivery.reason || delivery.status}). Not a live text.`
        : replyText.slice(0, 140)),
    data: { delivery: delivery.status, transport: delivery.transport, queuedAt, sentAt, error: delivery.error || null },
  });
  events.push(deliveryType);
  let notification = null;
  if (delivery.error === "invalid_phone") events.push("invalid_phone");
  if (delivery.error === "sms_unavailable") {
    events.push("sms_unavailable");
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "sms_unavailable", actor: "system", summary: "Caller cannot receive SMS. Owner alerted. This lead was not contacted." });
    notification = addNotification({
      businessId,
      leadId: lead.id,
      kind: "sms_unavailable",
      title: "Caller cannot receive SMS",
      body: `${lead.name || "A caller"} ${lead.phone || ""} cannot receive SMS. Do not mark this lead contacted. Call them back.`,
    });
  }
  if (delivery.reason === "automation_paused") events.push("automation_paused");

  // ---- apply lifecycle ----------------------------------------------------
  const at = nowIso();
  const patch = {
    customerId: lead.customerId || customer?.id || null,
    conversationId: conversation.id,
    reply: replyText,
    engine: engineName,
    intent: decision.intent,
    urgent: decision.urgent,
    severity: decision.severity || (decision.urgent ? "urgent" : "normal"),
    bookingState: decision.bookingState || (decision.stage === "booked" ? "confirmed" : decision.stage === "booking_requested" ? "offered" : lead.bookingState || "available"),
    qualification: {
      ...decision.qualification,
      severity: decision.severity || (decision.urgent ? "urgent" : "normal"),
    },
    estimatedValue: decision.estimatedValue,
    jobValue: lead.jobValue ?? decision.estimatedValue ?? null,
    updatedAt: at,
  };

  // First response timestamp for the response-time metric. Live send only.
  const stageAt = { ...(lead.stageAt || {}) };
  if (!stageAt.missed_call_at && source === "missed_call") stageAt.missed_call_at = lead.createdAt || at;
  if (!stageAt.message_queued_at) stageAt.message_queued_at = queuedAt;
  if (delivery.status === "sent") {
    stageAt.message_sent_at = sentAt;
    if (!stageAt.first_response) stageAt.first_response = sentAt;
  }
  patch.stageAt = stageAt;
  patch.deliveryStatus = delivery.status;
  patch.sms = { status: delivery.status, reason: delivery.reason || delivery.error || null, simulated: delivery.simulated === true };
  if (delivery.status === "failed") {
      patch.failureState = delivery.error === "invalid_phone" ? "invalid_phone" : (delivery.error === "sms_unavailable" ? "sms_unavailable" : "sms_failed");
    } else if (delivery.status === "not_configured" && delivery.reason === "activation_incomplete") {
      patch.failureState = "activation_incomplete";
    } else if (delivery.status === "not_configured" && delivery.reason === "automation_paused") {
      patch.failureState = "automation_paused";
    } else if (delivery.status === "not_configured" && delivery.reason === "quiet_hours") {
      patch.failureState = "quiet_hours";
    } else if (delivery.status === "not_configured" && delivery.reason === "usage_limit") {
      patch.failureState = "usage_limit";
    }
  patch.score = scoreLead({
    message: inboundText || lead.message,
    phone: lead.phone,
    source: lead.source,
    severity: patch.severity,
    urgent: patch.urgent,
    qualification: patch.qualification,
  });

  const lifecycle = applyStatus({ ...lead, stageAt }, decision.stage, { at, lostReason: decision.lostReason });
  if (lifecycle) Object.assign(patch, lifecycle);
  patch.revenueState = revenueStateFrom({ ...lead, ...patch });

  const prevQ = lead.qualification || {};
  const nextQ = patch.qualification || {};
  if (nextQ.service && nextQ.service !== prevQ.service) {
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "service_identified", actor: "system", summary: `Service identified: ${nextQ.service}.` });
    events.push("service_identified");
  }
  if ((nextQ.area || nextQ.address) && (nextQ.area || nextQ.address) !== (prevQ.area || prevQ.address)) {
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "location_identified", actor: "system", summary: `Location identified: ${nextQ.area || nextQ.address}.` });
    events.push("location_identified");
  }
  if (patch.severity && patch.severity !== "normal" && patch.severity !== lead.severity) {
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "urgency_detected", actor: "system", summary: `Urgency detected: ${patch.severity}.` });
    events.push("urgency_detected");
  }

  // Booking state.
  let appointment = null;
  if (decision.stage === "booked" && decision.slot) {
    appointment = upsertAppointment({
      businessId,
      leadId: lead.id,
      customerId: patch.customerId,
      service: decision.qualification.service || "",
      patch: slotToAppointment(decision.slot, { service: decision.qualification.service || "" }),
    });
    patch.appointmentId = appointment.id;
    patch.revenueStatus = "booked";
    cancelForLead(lead.id, "booked");
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "booking_confirmed", actor: "system", summary: `Appointment confirmed for ${decision.slot.label}.`, data: { appointmentId: appointment.id, slot: decision.slot } });
    events.push("booking_confirmed");
  } else if (decision.bookingState === "selected" && decision.slot) {
    appointment = upsertAppointment({
      businessId,
      leadId: lead.id,
      customerId: patch.customerId,
      service: decision.qualification.service || "",
      patch: {
        status: "selected",
        provider: "demo_calendar",
        preferredDate: decision.slot.date,
        preferredTime: decision.slot.time,
        notes: `Selected ${decision.slot.label}. Not confirmed.`,
      },
    });
    patch.appointmentId = appointment.id;
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "booking_selected", actor: "customer", summary: `Selected ${decision.slot.label}. Not a booking.`, data: { appointmentId: appointment.id } });
    events.push("booking_selected");
  } else if (decision.action === "book" && decision.slots?.length) {
    appointment = upsertAppointment({
      businessId,
      leadId: lead.id,
      customerId: patch.customerId,
      service: decision.qualification.service || "",
      patch: {
        status: "offered",
        provider: "demo_calendar",
        preferredDate: decision.slots[0].date,
        preferredTime: decision.slots[0].time,
        notes: `Offered ${decision.slots.map((s) => s.label).join(", ")}.`,
      },
    });
    patch.appointmentId = appointment.id;
     recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "availability_checked", actor: "system", summary: decision.slots.some((s) => s.demo) ? "Demo availability checked." : "Availability checked.", data: { demo: decision.slots.some((s) => s.demo) } });
     recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "booking_requested", actor: "ai", summary: `Times offered — not a booking. ${decision.slots.length} slots.`, data: { appointmentId: appointment.id, slots: decision.slots } });
     events.push("availability_checked", "booking_requested");
    } else if (decision.action === "book" && !decision.slots?.length && decision.stage === "booking_requested") {
     recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "calendar_unavailable", actor: "system", summary: "We couldn't verify availability right now. A team member will follow up." });
     events.push("calendar_unavailable");
     patch.failureState = "calendar_unavailable";
   }
  if (decision.lostReason === "outside_area") patch.failureState = "outside_area";
  if (decision.unknownService) patch.failureState = "unknown_service";
  if (decision.bookingFailed) {
    patch.failureState = "booking_confirmation_failed";
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "booking_confirmation_failed", actor: "system", summary: "Booking confirmation failed. Appointment was not booked." });
    events.push("booking_confirmation_failed");
  }

  // Do-not-contact and opt-out handling.
  if (decision.doNotContact) {
    patch.optedOut = true;
    patch.doNotContact = true;
    if (patch.customerId) updateCustomer(patch.customerId, { optedOut: true, doNotContact: true });
    cancelForLead(lead.id, "do_not_contact");
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "opt_out", actor: "customer", summary: "Customer opted out; follow-up stopped." });
    events.push("opt_out");
  }

  // Closing the loop stops follow-up on its own.
  if (["won", "lost", "unqualified", "spam", "do_not_contact", "booked"].includes(lifecycle?.status)) {
    patch.followUpStatus = "stopped";
  }

  lead = updateLead(lead.id, patch);

  // ---- follow-up scheduling ----------------------------------------------
  if (created && business.followUp.enabled !== false && !decision.doNotContact) {
    const { jobs } = scheduleFollowUps({ business, lead, conversation, qualification: decision.qualification });
    const followUp = jobs.map((j) => ({
      delayHours: Math.round((Date.parse(j.runAt) - Date.parse(at)) / 3600_000),
      channel,
      text: j.text,
    }));
    lead = updateLead(lead.id, { followUp, followUpAt: jobs.length ? jobs[0].runAt : null });
    recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "follow_up_scheduled", actor: "system", summary: `${jobs.length} follow-up steps scheduled.` });
    events.push("follow_up_scheduled");
  }

  // ---- after-hours owner ping on a new missed call ------------------------
  let ownerPingResult = null;
  if (created && source === "missed_call") {
    const pingText = ownerPing({ business, lead, hours, qualification: decision.qualification });
    const [title, ...rest] = pingText.split("\n");
    notification = addNotification({
      businessId,
      leadId: lead.id,
      kind: hours.afterHours ? "after_hours" : "missed_call",
      title,
      body: rest.join("\n") || pingText,
    });
    const ownerPhone = String(business.notifications?.phone || "").trim();
    if (ownerPhone) {
      ownerPingResult = { target: ownerPhone, ...(await sendSms(ownerPhone, pingText)) };
    } else {
      ownerPingResult = { sent: false, simulated: true, reason: "owner_phone_not_configured", target: "" };
      recordEvent({ businessId, leadId: lead.id, conversationId: conversation.id, type: "owner_unavailable", actor: "system", summary: "Owner phone is not configured. Escalation was not sent." });
      events.push("owner_unavailable");
      lead = updateLead(lead.id, { failureState: "owner_unavailable" });
    }
    lead = updateLead(lead.id, { ownerLastNotifiedAt: at, afterHours: hours.afterHours === true });
    recordEvent({
      businessId,
      leadId: lead.id,
      conversationId: conversation.id,
      type: "owner_ping",
      actor: "system",
      summary: pingText.replace(/\n/g, " ").slice(0, 240),
      data: { afterHours: hours.afterHours, sent: ownerPingResult.sent === true, simulated: ownerPingResult.simulated === true, reason: ownerPingResult.reason || null },
    });
    events.push("owner_ping");
  }

  // ---- escalation / owner alert -------------------------------------------
  if (decision.escalation) {
    const alert = ownerAlert({ business, lead, escalation: decision.escalation, qualification: decision.qualification });
    const [title, ...rest] = alert.split("\n");
    notification = addNotification({
      businessId,
      leadId: lead.id,
      kind: decision.escalation.reason,
      title,
      body: rest.join("\n") || alert,
    });
    lead = updateLead(lead.id, { ownerLastNotifiedAt: at });
    const emergencyState = decision.escalation.reason === "emergency"
      ? { detected: true, policyApplied: Boolean(business.emergency?.policy) || business.emergency?.available === true || business.emergency?.available === false, ownerNotified: true, dispatcherConfirmed: false, technicianDispatched: false }
      : null;
    recordEvent({
      businessId,
      leadId: lead.id,
      conversationId: conversation.id,
      type: decision.escalation.reason === "emergency" ? "emergency_detected" : "escalation",
      actor: "system",
      summary: alert.replace(/\n/g, " ").slice(0, 240),
      data: { reason: decision.escalation.reason, priority: decision.escalation.priority, emergencyState },
    });
    events.push("escalation");
    if (decision.escalation.reason === "emergency") events.push("emergency_detected");
  } else if (business.notifications?.onHotLead !== false && (decision.urgent || (lead.score?.bucket === "hot" && !lead.ownerLastNotifiedAt))) {
    const who = lead.name && lead.name !== "Unknown" ? lead.name : "A customer";
    const loc = decision.qualification?.area || decision.qualification?.address || "";
    const svc = decision.qualification?.service || lead.message || "service request";
    notification = addNotification({
      businessId,
      leadId: lead.id,
      kind: "hot_lead",
      title: `HOT LEAD - ${who}`,
      body: `${who} needs ${svc}${loc ? " in " + loc : ""}. ${lead.phone ? "Call " + lead.phone + "." : "Open the conversation."} Estimated value is a model from configured starting prices, not a quote.`,
    });
    lead = updateLead(lead.id, { ownerLastNotifiedAt: at });
    events.push("hot_lead");
  }

  // ---- conversation state -------------------------------------------------
  const conversationUpdate = updateConversation(conversation.id, {
    state: decision.nextState,
    turnCount: (conversation.turnCount || 0) + (inboundText ? 1 : 0),
    lastMessageAt: at,
    summary: decision.qualification.service ? `${decision.qualification.service}${decision.qualification.area ? ` in ${decision.qualification.area}` : ""}` : undefined,
    proposedSlots: decision.slots?.length ? decision.slots : undefined,
    selectedSlot: decision.bookingState === "selected" ? decision.slot : (decision.bookingState === "confirmed" ? decision.slot : conversation.selectedSlot),
    bookingState: decision.bookingState || conversation.bookingState || "available",
  });
  if (conversationUpdate) conversation = conversationUpdate;

  return {
    ok: true,
    created,
    lead: getLead(lead.id),
    customer,
    conversation,
    decision,
    reply: replyText,
    delivery,
    appointment,
    notification,
    ownerPing: ownerPingResult,
    hours,
    messages: { inbound: inboundMessage, outbound: outboundMessage },
    events,
  };
}

export function conversationIntelligence({ lead, conversation, appointments = [], business = {} } = {}) {
  const qual = lead?.qualification || {};
  const paused = conversation?.ownerMode === true || conversation?.state === "paused";
  let nextAction = "Wait for the customer to reply.";
  if (paused) nextAction = "Owner is handling this. Return to AI when ready.";
  else if (lead?.status === "won") nextAction = "Job won. Record any remaining notes.";
  else if (lead?.status === "booked") nextAction = "Appointment confirmed. Complete the job, then mark won with the invoice.";
  else if (lead?.bookingState === "selected") nextAction = "Slot selected — not confirmed. Ask them to reply YES.";
  else if (lead?.status === "booking_requested") nextAction = "Times offered — not a booking. Follow up if they do not choose a slot.";
  else if (lead?.severity === "emergency") nextAction = "Emergency. Alert the owner. Do not invent a technician or a price.";
  else if (qual.service && (qual.area || qual.address) && qual.timing) nextAction = "Ready to book. Offer appointment times.";
  else if (lead?.urgent) nextAction = "Urgent. Take over or book the soonest slot.";
  else if (!qual.service) nextAction = "Ask what service they need.";
  else if (!(qual.area || qual.address)) nextAction = "Ask for the service address.";
  else if (!qual.timing)       nextAction = "Ask when they need the work done.";
  if (lead?.failureState === "sms_unavailable") nextAction = "Caller cannot receive SMS. Call them back.";
  if (lead?.failureState === "automation_paused") nextAction = "Automation is paused. Resume or take over.";
  if (lead?.failureState === "quiet_hours") nextAction = "Quiet hours. Automated SMS is held until morning.";
  if (lead?.failureState === "usage_limit") nextAction = "Plan SMS cap reached. Live texts are recorded, not sent.";

  const parts = [qual.service, qual.area || qual.address, qual.timing].filter(Boolean);
  const heat = lead?.score?.bucket || "cold";
  const verified = Number(lead?.confirmedRevenue) > 0 && lead?.status === "won";
  const revenueKind = verified ? "verified" : (lead?.status === "booked" ? "estimated" : "pipeline");
  return {
    nextAction,
    summary: conversation?.summary || parts.join(" · ") || String(lead?.message || "").slice(0, 140),
    paused,
    pausedReason: paused ? (conversation?.pausedReason || "Owner took over the conversation.") : "",
    ownerMode: Boolean(conversation?.ownerMode),
    state: conversation?.state || null,
    intent: lead?.intent || "general",
    urgent: Boolean(lead?.urgent),
    severity: lead?.severity || (lead?.urgent ? "urgent" : "normal"),
    bookingState: lead?.bookingState || conversation?.bookingState || "available",
    qualification: qual,
    estimatedValue: lead?.estimatedValue ?? lead?.jobValue ?? null,
    valueExplanation: explainLeadValue(qual, business),
    appointmentStatus: appointments.length ? appointments[appointments.length - 1].status : null,
    emergencyState: (lead?.severity === "emergency")
      ? { detected: true, ownerNotified: Boolean(lead?.ownerLastNotifiedAt), dispatcherConfirmed: false, technicianDispatched: false }
      : { detected: false, ownerNotified: false, dispatcherConfirmed: false, technicianDispatched: false },
    name: lead?.name || "",
    phone: lead?.phone || "",
    source: lead?.source || "",
    service: qual.service || "",
    location: qual.area || qual.address || "",
    heat,
    heatReasons: Array.isArray(lead?.score?.reasons) ? lead.score.reasons : [],
    score: lead?.score?.score ?? null,
    revenueKind,
    revenueState: lead?.status === "won" && Number(lead?.confirmedRevenue) > 0 ? "REVENUE_VERIFIED" : (lead?.status === "won" ? "JOB_COMPLETED" : (lead?.status === "booked" ? "BOOKING_CONFIRMED" : (lead?.status === "booking_requested" ? "BOOKING_OFFERED" : (["contacted", "engaged", "qualified"].includes(lead?.status) ? "LEAD_RECOVERED" : "POTENTIAL_VALUE")))),
    failureState: lead?.failureState || null,
    deliveryStatus: lead?.deliveryStatus || lead?.sms?.status || null,
    status: lead?.status || "new",
  };
}

export function pauseConversation(conversation, reason = "Owner took over the conversation.") {
  if (!conversation?.id) return null;
  return updateConversation(conversation.id, {
    resumeState: conversation.state && conversation.state !== "paused" ? conversation.state : (conversation.resumeState || "waiting_for_customer"),
    state: "paused",
    ownerMode: true,
    pausedReason: reason,
  });
}

export function resumeConversation(conversation) {
  if (!conversation?.id) return null;
  return updateConversation(conversation.id, {
    state: conversation.resumeState && conversation.resumeState !== "paused" ? conversation.resumeState : "waiting_for_customer",
    ownerMode: false,
    pausedReason: "",
    resumeState: null,
  });
}

export function ingestMessage(params) {
  return ingest(params);
}
