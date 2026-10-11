import { test } from "node:test";
import assert from "node:assert/strict";

const { PLANS, getPlan, planList, monthlyValue } = await import("../lib/plans.js");
const billing = await import("../lib/billing.js");

function clearBillingEnv() {
  for (const k of [
    "RB_PAYMENT_LINK", "RB_PAYPAL_ME", "RB_RAZORPAY_LINK", "RB_STRIPE_LINK",
    "RB_PAYMENT_LINK_STARTER", "RB_PAYMENT_LINK_PROFESSIONAL", "RB_PAYMENT_LINK_BUSINESS",
    "RB_BILLING_MODE", "RB_PUBLIC_URL",
  ]) {
    delete process.env[k];
  }
}

test("three plans exist with the documented prices", () => {
  assert.equal(PLANS.length, 3);
  assert.deepEqual(PLANS.map((p) => p.id), ["starter", "professional", "business"]);
  assert.equal(getPlan("starter").price, 99);
  assert.equal(getPlan("Professional").price, 199);
  assert.equal(getPlan("business").price, 349);
  assert.equal(getPlan("business").setupFee, 149);
  assert.equal(getPlan("nope"), null);
});

test("exactly one plan is marked popular", () => {
  assert.equal(PLANS.filter((p) => p.popular).length, 1);
  assert.equal(PLANS.find((p) => p.popular).id, "professional");
});

test("planList exposes only public fields", () => {
  for (const p of planList()) {
    assert.ok(p.id && p.name);
    assert.equal(typeof p.price, "number");
    assert.equal(p.features, undefined, "features should not leak into the compact list");
  }
});

test("monthlyValue math is conservative and self-consistent", () => {
  const v = monthlyValue({ missedCallsPerWeek: 12, jobValue: 450, closeRate: 0.3, recoveryRate: 0.3 });
  const expectedLost = 12 * 4.33 * 0.3 * 450;
  assert.ok(Math.abs(v.lostPerMonth - Math.round(expectedLost)) <= 1);
  assert.ok(v.recoveredPerMonth < v.lostPerMonth, "recovery must be a fraction of the loss");
  assert.equal(v.planCost, 199);
  assert.ok(v.roi > 0);
});

test("monthlyValue handles zero input without dividing by zero", () => {
  const v = monthlyValue({ missedCallsPerWeek: 0, jobValue: 0, closeRate: 0, recoveryRate: 0 });
  assert.equal(v.lostPerMonth, 0);
  assert.equal(v.recoveredPerMonth, 0);
  assert.equal(v.netPerMonth, -199);
});

test("monthlyValue clamps absurd input instead of producing nonsense", () => {
  const v = monthlyValue({ missedCallsPerWeek: 20, jobValue: 450, closeRate: 30, recoveryRate: 30 });
  // closeRate 30 is a fraction over 1, so it must clamp to 1, not multiply by 30.
  assert.ok(v.lostPerMonth <= 20 * 4.33 * 1 * 450 + 1, `lost ${v.lostPerMonth} exceeded the clamped maximum`);
  const neg = monthlyValue({ missedCallsPerWeek: -5, jobValue: -10, closeRate: -1, recoveryRate: -1 });
  assert.equal(neg.lostPerMonth, 0);
  assert.equal(neg.recoveredPerMonth, 0);
});

test("monthlyValue explanation is reproducible and labeled ESTIMATED", () => {
  const v = monthlyValue({ missedCallsPerWeek: 12, jobValue: 460, closeRate: 0.3, recoveryRate: 0.3, planCost: 99 });
  assert.equal(v.label, "ESTIMATED");
  assert.ok(v.explanation);
  assert.equal(v.explanation.inputs.missedCallsPerWeek, 12);
  assert.equal(v.explanation.inputs.weeksPerMonth, 4.33);
  assert.equal(v.explanation.inputs.averageJobValue, 460);
  const jobs = 12 * 4.33 * 0.3 * 0.3;
  assert.ok(Math.abs(v.explanation.steps[1].result - jobs) < 1e-9);
  assert.ok(Math.abs(v.explanation.steps[2].result - jobs * 460) < 1e-6);
  assert.match(v.explanation.status, /not verified/i);
});

test("monthlyValue uses the supplied plan cost", () => {
  const v = monthlyValue({ missedCallsPerWeek: 12, jobValue: 450, closeRate: 0.3, recoveryRate: 0.3, planCost: 99 });
  assert.equal(v.planCost, 99);
  assert.equal(v.netPerMonth, v.recoveredPerMonth - 99);
  assert.ok(Math.abs(v.roi - v.recoveredPerMonth / 99) < 0.2);
});

test("billing is not ready when nothing is configured", () => {
  clearBillingEnv();
  assert.equal(billing.isBillingReady(), false);
  const status = billing.billingStatus();
  assert.equal(status.ready, false);
  assert.deepEqual(status.providers, []);
});

test("checkout reports not_configured instead of inventing a URL", () => {
  clearBillingEnv();
  const r = billing.checkoutUrl("professional");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_configured");
});

test("checkout rejects unknown plans", () => {
  process.env.RB_PAYMENT_LINK = "https://example.com/pay";
  const r = billing.checkoutUrl("enterprise");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_plan");
  clearBillingEnv();
});

test("a generic payment link is used for every plan", () => {
  clearBillingEnv();
  process.env.RB_PAYMENT_LINK = "https://example.com/pay";
  const r = billing.checkoutUrl("starter", { source: "test", businessId: "b1" });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "generic");
  assert.match(r.url, /plan=starter/);
  assert.match(r.url, /amount=99/);
  assert.match(r.url, /utm_source=test/);
  assert.match(r.url, /ref=b1/);
  clearBillingEnv();
});

test("a per-plan link overrides the generic link", () => {
  clearBillingEnv();
  process.env.RB_PAYMENT_LINK = "https://example.com/pay";
  process.env.RB_PAYMENT_LINK_BUSINESS = "https://example.com/business";
  const r = billing.checkoutUrl("business");
  assert.equal(r.provider, "plan_link");
  assert.match(r.url, /example\.com\/business/);
  clearBillingEnv();
});

test("a PayPal.me link is converted to a priced link", () => {
  clearBillingEnv();
  process.env.RB_PAYPAL_ME = "https://paypal.me/acme";
  const r = billing.checkoutUrl("professional");
  assert.equal(r.ok, true);
  assert.equal(r.provider, "paypal");
  assert.match(r.url, /paypal\.me\/acme\/199\.00USD/);
  clearBillingEnv();
});

test("http links are rejected so credentials are never sent in the clear", () => {
  clearBillingEnv();
  process.env.RB_PAYMENT_LINK = "http://insecure.example.com/pay";
  assert.equal(billing.isBillingReady(), false);
  clearBillingEnv();
});

test("a razorpay link is surfaced with an INR caveat", () => {
  clearBillingEnv();
  process.env.RB_RAZORPAY_LINK = "https://rzp.io/l/abc";
  const r = billing.checkoutUrl("starter");
  assert.equal(r.ok, true);
  assert.equal(r.provider, "razorpay");
  assert.match(String(r.note), /INR/);
  clearBillingEnv();
});

test("a razorpay.me handle is used for every plan", () => {
  clearBillingEnv();
  process.env.RB_RAZORPAY_LINK = "razorpay.me/@demo-handle";
  for (const plan of ["starter", "professional", "business"]) {
    const r = billing.checkoutUrl(plan);
    assert.equal(r.ok, true);
    assert.equal(r.provider, "razorpay");
    assert.equal(r.paid, false);
    assert.equal(r.url, "https://razorpay.me/@demo-handle");
    assert.doesNotMatch(r.url, /[?&]amount=/);
  }
  clearBillingEnv();
});

test("a razorpay.me plan link is not given amount query params", () => {
  clearBillingEnv();
  process.env.RB_PAYMENT_LINK = "https://razorpay.me/@demo-handle";
  const r = billing.checkoutUrl("professional", { source: "landing" });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://razorpay.me/@demo-handle");
  assert.doesNotMatch(r.url, /\?/);
  assert.match(String(r.note), /INR/);
  clearBillingEnv();
});

test("billingStatus reports which providers are live", () => {
  clearBillingEnv();
  process.env.RB_STRIPE_LINK = "https://buy.stripe.com/test";
  const status = billing.billingStatus();
  assert.equal(status.ready, true);
  assert.deepEqual(status.providers, ["stripe"]);
  clearBillingEnv();
});

test("a per-plan payment link makes billing ready", () => {
  clearBillingEnv();
  process.env.RB_PAYMENT_LINK_PROFESSIONAL = "https://buy.stripe.com/live_pro";
  assert.equal(billing.isBillingReady(), true);
  const r = billing.checkoutUrl("professional");
  assert.equal(r.ok, true);
  assert.equal(r.paid, false);
  assert.equal(r.mode, "live");
  assert.equal(r.successPath, "/pay/success");
  assert.equal(r.cancelPath, "/pay/cancel");
  const status = billing.billingStatus();
  assert.ok(status.providers.includes("plan_link"));
  clearBillingEnv();
});

test("sandbox stripe URLs report test mode", () => {
  clearBillingEnv();
  process.env.RB_STRIPE_LINK = "https://buy.stripe.com/test_abc";
  assert.equal(billing.billingMode(), "test");
  process.env.RB_BILLING_MODE = "live";
  assert.equal(billing.billingMode(), "live");
  clearBillingEnv();
  delete process.env.RB_BILLING_MODE;
});

test("checkout never claims paid just because a URL exists", () => {
  clearBillingEnv();
  process.env.RB_PAYMENT_LINK = "https://example.com/pay";
  const r = billing.checkoutUrl("professional");
  assert.equal(r.ok, true);
  assert.equal(r.paid, false);
  clearBillingEnv();
});
