// Lead lifecycle and revenue attribution.
//
// The lifecycle is the spine of the product: a missed customer moves through
// NEW -> CONTACTED -> ENGAGED -> QUALIFIED -> BOOKING_REQUESTED -> BOOKED -> WON.
// Off-ramps are LOST / UNQUALIFIED / SPAM / DO_NOT_CONTACT.
//
// Statuses are stored lowercase for backward compatibility with the v1 store
// and CSV, and rendered uppercase in the UI.

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "engaged",
  "qualified",
  "booking_requested",
  "booked",
  "won",
  "lost",
  "unqualified",
  "spam",
  "do_not_contact",
];

// Statuses that end the recovery attempt.
export const TERMINAL_STATUSES = ["won", "lost", "unqualified", "spam", "do_not_contact"];

// Statuses where a customer has committed to an appointment.
export const BOOKED_STATUSES = ["booked", "won"];

// Statuses counted as recovered customers. A booking is not a recovered job.
export const RECOVERED_STATUSES = ["won"];

export const REVENUE_FLOW = [
  "POTENTIAL_VALUE",
  "LEAD_RECOVERED",
  "BOOKING_OFFERED",
  "BOOKING_CONFIRMED",
  "JOB_COMPLETED",
  "REVENUE_VERIFIED",
];

export const STATUS_LABELS = {
  new: "New",
  contacted: "Contacted",
  engaged: "Engaged",
  qualified: "Qualified",
  booking_requested: "Booking requested",
  booked: "Booked",
  won: "Won",
  lost: "Lost",
  unqualified: "Unqualified",
  spam: "Spam",
  do_not_contact: "Do not contact",
};

export const REVENUE_STATUSES = ["unknown", "estimated", "booked", "won", "lost"];

export const LOST_REASONS = [
  { id: "no_response", label: "Customer never responded" },
  { id: "price", label: "Price too high" },
  { id: "outside_area", label: "Outside service area" },
  { id: "no_availability", label: "No appointment available" },
  { id: "competitor", label: "Competitor won" },
  { id: "cancelled", label: "Customer cancelled" },
  { id: "duplicate", label: "Duplicate/spam" },
  { id: "unknown", label: "Unknown" },
];

export function normalizeLostReason(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return LOST_REASONS.some((r) => r.id === key) ? key : (key ? "unknown" : null);
}

// The ordered stages we record a timestamp for. `first_response` is set the
// first time we actually send something back.
export const STAGES = [
  "new",
  "contacted",
  "engaged",
  "qualified",
  "booking_requested",
  "booked",
  "won",
  "first_response",
];

export function normalizeStatus(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return LEAD_STATUSES.includes(key) ? key : null;
}

export function normalizeRevenueStatus(value) {
  const key = String(value || "").trim().toLowerCase();
  return REVENUE_STATUSES.includes(key) ? key : null;
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(normalizeStatus(status));
}

export function isBooked(status) {
  return BOOKED_STATUSES.includes(normalizeStatus(status));
}

export function isRecovered(status) {
  return RECOVERED_STATUSES.includes(normalizeStatus(status));
}

export function revenueStateFrom(lead = {}) {
  if (numberOr(lead.confirmedRevenue, 0) > 0 && (lead.status === "won" || lead.revenueStatus === "won")) {
    return "REVENUE_VERIFIED";
  }
  if (lead.status === "won" || lead.status === "completed") return "JOB_COMPLETED";
  if (lead.status === "booked" || lead.bookingState === "confirmed") return "BOOKING_CONFIRMED";
  if (
    lead.status === "booking_requested" ||
    lead.bookingState === "offered" ||
    lead.bookingState === "selected"
  ) {
    return "BOOKING_OFFERED";
  }
  if (["contacted", "engaged", "qualified"].includes(normalizeStatus(lead.status))) return "LEAD_RECOVERED";
  return "POTENTIAL_VALUE";
}

export function statusLabel(status) {
  return STATUS_LABELS[normalizeStatus(status)] || "New";
}

// Returns a patch that advances a lead to `next`: the status plus a stage
// timestamp, without ever overwriting an earlier timestamp for the same stage.
export function applyStatus(lead, next, options = {}) {
  const status = normalizeStatus(next);
  if (!status) return null;

  const at = options.at || new Date().toISOString();
  const stageAt = { ...(lead?.stageAt || {}) };
  if (!stageAt[status]) stageAt[status] = at;

  // Advancing past NEW means we already contacted them.
  if (!stageAt.new) stageAt.new = lead?.createdAt || at;
  if (["contacted", "engaged", "qualified", "booking_requested", "booked", "won"].includes(status) && !stageAt.contacted) {
    stageAt.contacted = at;
  }

  const patch = { status, stageAt };
  if (options.lostReason) patch.lostReason = normalizeLostReason(options.lostReason) || String(options.lostReason).slice(0, 200);
  if (isTerminal(status)) patch.followUpStatus = "stopped";

  // Keep the v1 fields coherent so the existing CSV/report keep working.
  // Won without an invoice is job-completed, not verified revenue.
  if (status === "won") {
    if (numberOr(lead?.confirmedRevenue, 0) > 0 || options.invoiceVerified) {
      patch.revenueStatus = "won";
    } else {
      patch.revenueStatus = lead?.revenueStatus === "won" ? "booked" : (lead?.revenueStatus && lead.revenueStatus !== "unknown" ? lead.revenueStatus : "booked");
    }
  } else if (status === "lost" || status === "unqualified" || status === "spam") {
    if (!lead?.confirmedRevenue) patch.revenueStatus = "lost";
  } else if (isBooked(status)) {
    patch.revenueStatus = "booked";
  } else if (status !== "new" && (!lead?.revenueStatus || lead.revenueStatus === "unknown")) {
    patch.revenueStatus = "estimated";
  }
  return patch;
}

// Revenue attribution is the product's headline value, so it is computed in one
// place and used by both the dashboard and the report.
export function computeMetrics(leads = []) {
  const byBucket = { hot: 0, warm: 0, cold: 0 };
  const byStatus = {};
  for (const s of LEAD_STATUSES) byStatus[s] = 0;
  const byChannel = {};
  const byDay = {};
  const byLostReason = {};
  for (const r of LOST_REASONS) byLostReason[r.id] = 0;

  let replied = 0;
  let urgent = 0;
  let recoveredRevenue = 0;
  let estimatedRevenue = 0;
  let verifiedRevenue = 0;
  let demoRevenue = 0;
  let pipelineValue = 0;
  let customersRecovered = 0;
  let appointmentsBooked = 0;
  let missedCallsHandled = 0;
  let qualifiedLeads = 0;
  let followUpsActive = 0;
  let responseSamples = 0;
  let responseTotalMs = 0;

  for (const l of leads) {
    const status = normalizeStatus(l.status) || "new";
    byStatus[status] += 1;

    const bucket = l.score?.bucket;
    if (bucket && byBucket[bucket] !== undefined) byBucket[bucket] += 1;

    if (l.reply) replied += 1;
    if (l.urgent) urgent += 1;

    const src = l.source || "unknown";
    byChannel[src] = (byChannel[src] || 0) + 1;
    if (src === "missed_call") missedCallsHandled += 1;

    const dk = String(l.createdAt || "").slice(0, 10);
    if (dk) byDay[dk] = (byDay[dk] || 0) + 1;

    const estimated = numberOr(l.jobValue, numberOr(l.estimatedValue, 450));
    const demo = l.demo === true || String(l.businessId || "").startsWith("demo-");

    if (status === "lost" || status === "unqualified" || status === "spam") {
      const reason = normalizeLostReason(l.lostReason) || (status === "spam" ? "duplicate" : "unknown");
      byLostReason[reason] = (byLostReason[reason] || 0) + 1;
    }

    if (status === "won") {
      const verified = numberOr(l.confirmedRevenue, null);
      if (verified == null) {
        qualifiedLeads += 1;
      } else if (demo) {
        demoRevenue += verified;
        qualifiedLeads += 1;
      } else {
        recoveredRevenue += verified;
        verifiedRevenue += verified;
        customersRecovered += 1;
        qualifiedLeads += 1;
      }
    } else if (status === "booked") {
      if (demo) {
        demoRevenue += estimated;
        qualifiedLeads += 1;
      } else {
        estimatedRevenue += estimated;
        qualifiedLeads += 1;
      }
    } else if (status === "qualified" || status === "booking_requested") {
      qualifiedLeads += 1;
    }
    if (BOOKED_STATUSES.includes(status)) appointmentsBooked += 1;

    if (!TERMINAL_STATUSES.includes(status)) pipelineValue += estimated;
    if (l.followUpStatus === "active" && Array.isArray(l.followUp) && l.followUp.length) followUpsActive += 1;

    const sent = l.stageAt?.message_sent_at || l.stageAt?.first_response;
    const start = l.stageAt?.missed_call_at || l.createdAt;
    const liveSent = l.sms?.status === "sent" || l.deliveryStatus === "sent";
    if (liveSent && sent && start) {
      const delta = Date.parse(sent) - Date.parse(start);
      if (Number.isFinite(delta) && delta >= 0) {
        responseTotalMs += delta;
        responseSamples += 1;
      }
    }
  }

  const total = leads.length;
  return {
    total,
    replied,
    urgent,
    byBucket,
    byStatus,
    byChannel,
    byDay,
    recoveredRevenue: Math.round(recoveredRevenue),
    estimatedRevenue: Math.round(estimatedRevenue),
    verifiedRevenue: Math.round(verifiedRevenue),
    demoRevenue: Math.round(demoRevenue),
    jobsCompleted: byStatus.won || 0,
    lostLeads: (byStatus.lost || 0) + (byStatus.unqualified || 0) + (byStatus.spam || 0),
    byLostReason,
    pipelineValue: Math.round(pipelineValue),
    customersRecovered,
    appointmentsBooked,
    missedCallsHandled,
    qualifiedLeads,
    followUpsActive,
    avgResponseSeconds: responseSamples ? Number((responseTotalMs / responseSamples / 1000).toFixed(1)) : null,
    funnel: {
      lead: total,
      contacted: (byStatus.contacted || 0) + (byStatus.engaged || 0) + (byStatus.qualified || 0) + (byStatus.booking_requested || 0) + (byStatus.booked || 0) + (byStatus.won || 0),
      qualified: (byStatus.qualified || 0) + (byStatus.booking_requested || 0) + (byStatus.booked || 0) + (byStatus.won || 0),
      potential: total,
      recovered: (byStatus.contacted || 0) + (byStatus.engaged || 0) + (byStatus.qualified || 0) + (byStatus.booking_requested || 0) + (byStatus.booked || 0) + (byStatus.won || 0),
      appointmentOffered: Math.max(0, (byStatus.booking_requested || 0) - leads.filter((l) => l.bookingState === "selected").length),
      selected: leads.filter((l) => l.bookingState === "selected").length,
      booked: byStatus.booked || 0,
      completed: byStatus.won || 0,
      verified: customersRecovered,
      verifiedRevenue: Math.round(verifiedRevenue),
    },
    potentialRevenue: Math.round(pipelineValue),
    recoveredCurrency: "USD",
    replyRate: total ? Number(((replied / total) * 100).toFixed(1)) : 0,
    bookedRate: total ? Number((((appointmentsBooked) / total) * 100).toFixed(1)) : 0,
    conversionRate: total ? Number((((appointmentsBooked) / total) * 100).toFixed(1)) : 0,
    reliability: reliabilityFrom(leads),
    recentlyRecovered: recentlyRecoveredFrom(leads),
  };
}

function reliabilityFrom(leads) {
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let simulated = 0;
  let unavailable = 0;
  const failures = [];
  for (const l of leads) {
    const status = l.deliveryStatus || l.sms?.status;
    if (!status) continue;
    attempted += 1;
    if (status === "sent") sent += 1;
    else if (status === "failed") {
      failed += 1;
      failures.push({ leadId: l.id, name: l.name, reason: l.failureState || l.sms?.reason || "sms_failed" });
    } else if (status === "simulated" || status === "not_configured") simulated += 1;
    if (l.failureState === "sms_unavailable") unavailable += 1;
  }
  const liveAttempted = sent + failed;
  return {
    attempted,
    sent,
    failed,
    simulated,
    unavailable,
    smsDeliveryPercent: liveAttempted ? Number(((sent / liveAttempted) * 100).toFixed(1)) : null,
    failedActions: failures.slice(0, 20),
    note: liveAttempted
      ? "Live SMS delivery only. Simulated sends are not counted as contacted."
      : "No live SMS yet. Simulated sends are not delivery.",
  };
}

function recentlyRecoveredFrom(leads) {
  return leads
    .filter((l) => l.status === "won" || l.status === "booked")
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
    .slice(0, 8)
    .map((l) => {
      const demo = l.demo === true || String(l.businessId || "").startsWith("demo-");
      const verified = !demo && l.status === "won" && Number(l.confirmedRevenue) > 0;
      return {
        id: l.id,
        name: l.name,
        service: l.qualification?.service || "",
        status: l.status,
        amount: verified ? Number(l.confirmedRevenue) : Number(l.jobValue || l.estimatedValue || 0),
        kind: verified ? "VERIFIED" : (l.status === "booked" ? "ESTIMATED" : "COMPLETED"),
        demo,
      };
    });
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
