// Product plans. Single source of truth for the landing page, the billing
// endpoints, and the outreach scripts.

export const PLANS = [
  {
    id: "starter",
    name: "Starter",
    price: 99,
    currency: "USD",
    interval: "month",
    setupFee: 0,
    setupFeeNote: "free for the first 10 customers",
    audience: "One busy owner-operator",
    features: [
      "Missed-call recovery, 24/7",
      "Instant SMS text-back",
      "Lead dashboard + email alerts",
      "Done-for-you setup in 48h",
    ],
  },
  {
    id: "professional",
    name: "Professional",
    price: 199,
    currency: "USD",
    interval: "month",
    setupFee: 0,
    setupFeeNote: "free for the first 10 customers",
    audience: "Growing team that advertises",
    popular: true,
    features: [
      "Everything in Starter",
      "Website, Facebook, and Google Ads leads",
      "Configurable follow-up (4h / 24h / 72h)",
      "Booking links + calendar slots",
      "Hot / warm / cold scoring with reasons",
    ],
  },
  {
    id: "business",
    name: "Business",
    price: 349,
    currency: "USD",
    interval: "month",
    setupFee: 149,
    setupFeeNote: "one-time",
    audience: "Multi-location or high lead volume",
    features: [
      "Everything in Professional",
      "Multiple numbers / locations",
      "Custom playbooks + owner takeover",
      "Estimated vs verified revenue report",
    ],
  },
];

export function getPlan(id) {
  const key = String(id || "").trim().toLowerCase();
  return PLANS.find((p) => p.id === key) || null;
}

export function planList() {
  return PLANS.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    currency: p.currency,
    interval: p.interval,
    setupFee: p.setupFee,
    popular: Boolean(p.popular),
  }));
}

// Rough monthly value of the tool for a given business, used in outreach and
// on the dashboard. Deliberately conservative.
export function monthlyValue({ missedCallsPerWeek = 12, jobValue = 450, closeRate = 0.3, recoveryRate = 0.3, planCost = 199 } = {}) {
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : 0));
  const calls = clamp(missedCallsPerWeek, 0, 100000);
  const job = clamp(jobValue, 0, 1000000);
  const close = clamp(closeRate, 0, 1);
  const recovery = clamp(recoveryRate, 0, 1);
  const cost = clamp(planCost, 0, 1000000);
  const weeksPerMonth = 4.33;
  const perMonth = calls * weeksPerMonth;
  const lost = perMonth * close * job;
  const expectedJobs = perMonth * close * recovery;
  const recovered = expectedJobs * job;
  const explanation = {
    label: "ESTIMATED",
    status: "This is not verified revenue.",
    formula: "missed_calls_per_week × 4.33 × close_rate × recovery_rate × average_job_value",
    inputs: {
      missedCallsPerWeek: calls,
      weeksPerMonth,
      averageJobValue: job,
      currentCloseRate: close,
      estimatedRecoveryRate: recovery,
      subscriptionCost: cost,
    },
    steps: [
      { name: "monthly_missed_calls", formula: `${calls} × ${weeksPerMonth}`, result: perMonth },
      { name: "expected_recovered_jobs", formula: `${perMonth} × ${close} × ${recovery}`, result: expectedJobs },
      { name: "estimated_recoverable_value", formula: `${expectedJobs} × $${job}`, result: recovered },
    ],
    assumptions: [
      "4.33 weeks per month",
      "Close rate is the shop's live-conversation close rate",
      "Recovery rate is an estimate, not a measured result",
      "This is a model, not a guaranteed result",
    ],
  };
  return {
    perMonth,
    expectedJobs,
    lostPerMonth: Math.round(lost),
    recoveredPerMonth: Math.round(recovered),
    planCost: cost,
    netPerMonth: Math.round(recovered - cost),
    roi: cost > 0 ? Number((recovered / cost).toFixed(1)) : 0,
    label: "ESTIMATED",
    explanation,
  };
}
