// Owner follow-up tasks and sales report.
//
// Tasks are derived from real leads and scheduled follow-up jobs. Nothing here
// invents a prospect, a price, or a recovered dollar.

import { isTerminal, normalizeStatus } from "./lifecycle.js";
import { coachLead } from "./coach.js";

export function followUpTasks({ leads = [], getFollowUps, getConversation, now = new Date().toISOString() } = {}) {
  const stamp = typeof now === "number" ? new Date(now).toISOString() : String(now);
  const tasks = [];

  for (const lead of leads) {
    const status = normalizeStatus(lead?.status) || "new";
    const jobs = typeof getFollowUps === "function" ? getFollowUps(lead) : [];
    const conversation = typeof getConversation === "function" ? getConversation(lead) : null;

    if (status === "booked") {
      tasks.push({
        id: `task_won_${lead.id}`,
        leadId: lead.id,
        name: lead.name || "Unknown",
        phone: lead.phone || "",
        kind: "mark_won",
        due: "today",
        title: "Confirm the visit, then mark won with the real invoice amount.",
        text: lead.phone ? `Call ${lead.phone} to confirm the booked job.` : "Confirm the booked job, then mark won.",
      });
    }

    if (isTerminal(status)) continue;

    const dueJobs = (jobs || []).filter((j) => j.status === "pending" && (j.runAt || "") <= stamp);
    for (const job of dueJobs) {
      tasks.push({
        id: `task_fu_${job.id}`,
        leadId: lead.id,
        jobId: job.id,
        name: lead.name || "Unknown",
        phone: lead.phone || "",
        kind: "follow_up",
        due: "now",
        title: `Send follow-up step ${job.step || ""}`.trim(),
        text: job.text || "",
        runAt: job.runAt,
      });
    }

    if (lead.urgent || conversation?.ownerMode || conversation?.state === "paused") {
      const item = coachLead({ lead, conversation, followUps: jobs });
      tasks.push({
        id: `task_call_${lead.id}`,
        leadId: lead.id,
        name: lead.name || "Unknown",
        phone: lead.phone || "",
        kind: "call",
        due: "now",
        title: item.reason,
        text: item.script.call,
      });
    }
  }

  const rank = { now: 3, today: 2, soon: 1 };
  tasks.sort((a, b) => (rank[b.due] || 0) - (rank[a.due] || 0));
  return tasks.slice(0, 25);
}

export function salesReport({ stats, leads = [], setups = [], payments = [], generatedAt } = {}) {
  const s = stats || {};
  const paying = (payments || []).filter((p) => Number(p.amount) > 0);
  const verified = Number(s.verifiedRevenue || 0);
  const estimated = Number(s.estimatedRevenue || 0);
  const planCost = Number(s.planCost || 199);
  const payingShops = new Set(paying.map((p) => p.setupId || p.reference || p.id)).size;
  return {
    generatedAt: generatedAt || new Date().toISOString(),
    scoreboard: {
      payingShops,
      paymentsRecorded: paying.length,
      verifiedRevenue: verified,
      estimatedRevenue: estimated,
      recoveredCompat: Number(s.recovered || s.recoveredRevenue || 0),
      billedModelCost: planCost,
      estimatedRoi: s.estimatedRoi ?? 0,
      verifiedRoi: s.verifiedRoi ?? 0,
      note: "Verified dollars require owner-marked won. Estimated is booked, not won. Not a guarantee.",
    },
    pipeline: {
      leads: s.total || leads.length,
      booked: (s.byStatus?.booked || 0) + (s.byStatus?.won || 0),
      won: s.byStatus?.won || 0,
      missedCalls: s.missedCallsHandled || 0,
      followUpsActive: s.followUpsActive || 0,
      setups: (setups || []).length,
    },
    blockers: [
      paying.length ? null : "No payment recorded yet.",
      verified > 0 ? null : "No job marked won with a real invoice amount.",
      (s.missedCallsHandled || 0) > 0 ? null : "No missed-call recovery in this workspace yet.",
    ].filter(Boolean),
  };
}

export function salesReportText(report) {
  const s = report.scoreboard || {};
  const p = report.pipeline || {};
  const lines = [
    `RingBack sales report ${report.generatedAt || ""}`.trim(),
    `Paying shops recorded: ${s.payingShops || 0}`,
    `Payments recorded: ${s.paymentsRecorded || 0}`,
    `Verified recovered: $${Math.round(s.verifiedRevenue || 0)}`,
    `Estimated recovered: $${Math.round(s.estimatedRevenue || 0)}`,
    `Leads: ${p.leads || 0}  Booked: ${p.booked || 0}  Won: ${p.won || 0}  Missed calls: ${p.missedCalls || 0}`,
    s.note,
  ];
  if (report.blockers?.length) {
    lines.push("Still blocked:");
    for (const b of report.blockers) lines.push(`- ${b}`);
  }
  return lines.join("\n");
}
