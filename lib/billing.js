// Billing.
//
// RingBack does not process cards. It collects money through whatever rail the
// operator already has, using payment links they configure themselves.
//
// Configure any of these and the product becomes able to take money:
//   RB_PAYMENT_LINK_STARTER / _PROFESSIONAL / _BUSINESS  direct plan links
//   RB_PAYMENT_LINK                                      one link for every plan
//   RB_PAYPAL_ME                                         e.g. https://paypal.me/yourname
//   RB_RAZORPAY_LINK                                     e.g. https://rzp.io/l/xxxx
//   RB_STRIPE_LINK                                       e.g. https://buy.stripe.com/xxxx
//
// RingBack never reads platform or runtime credentials. It only reads the
// operator's own configured links. Returning from /pay/success does not mean
// a payment succeeded — the operator records paid on the dashboard.

import { getPlan, PLANS } from "./plans.js";

const ENV = process.env;

function clean(url) {
  let v = String(url || "").trim();
  if (!v) return "";
  if (/^razorpay\.me\/@[\w.-]+$/i.test(v)) v = "https://" + v;
  else if (/^@[\w.-]+$/i.test(v)) v = "https://razorpay.me/" + v;
  if (!/^https:\/\//.test(v)) return "";
  return v;
}

export function providerLinks() {
  return {
    paypal: clean(ENV.RB_PAYPAL_ME),
    razorpay: clean(ENV.RB_RAZORPAY_LINK),
    stripe: clean(ENV.RB_STRIPE_LINK),
    generic: clean(ENV.RB_PAYMENT_LINK),
  };
}

export function planOverride(planId) {
  const key = `RB_PAYMENT_LINK_${String(planId || "").toUpperCase()}`;
  return clean(ENV[key]);
}

export function isBillingReady() {
  const links = providerLinks();
  if (links.paypal || links.razorpay || links.stripe || links.generic) return true;
  return PLANS.some((p) => Boolean(planOverride(p.id)));
}

export function billingMode() {
  const forced = String(ENV.RB_BILLING_MODE || "").trim().toLowerCase();
  if (forced === "test" || forced === "live") return forced;
  if (!isBillingReady()) return "not_configured";
  const urls = [
    ...Object.values(providerLinks()),
    ...PLANS.map((p) => planOverride(p.id)),
  ].filter(Boolean);
  if (urls.some((u) => /\/test[_/?]|sandbox/i.test(u))) return "test";
  return "live";
}

export function publicBaseUrl() {
  return clean(ENV.RB_PUBLIC_URL).replace(/\/+$/, "");
}

export function returnPaths() {
  return { successPath: "/pay/success", cancelPath: "/pay/cancel" };
}

function returnUrls() {
  const base = publicBaseUrl();
  const paths = returnPaths();
  if (!base) return { successUrl: null, cancelUrl: null, ...paths };
  return {
    successUrl: `${base}${paths.successPath}`,
    cancelUrl: `${base}${paths.cancelPath}`,
    ...paths,
  };
}

// Returns a checkout URL for a plan, with metadata appended where the rail
// supports it. Falls back through most-specific to most-generic link.
export function checkoutUrl(planId, { source = "landing", businessId = "" } = {}) {
  const requested = String(planId || "").trim();
  const plan = getPlan(requested) || (!requested ? getPlan("professional") : null);
  if (!plan) return { ok: false, reason: "unknown_plan" };

  const links = providerLinks();
  const specific = planOverride(plan.id);
  const returns = returnUrls();
  const mode = billingMode();

  const extra = {
    mode,
    ...returns,
    paid: false,
    note: "Opening a payment link is not a paid conversion. Record the payment on the dashboard after money actually arrives.",
  };

  if (specific || links.stripe || links.generic) {
    const base = specific || links.stripe || links.generic;
    const razorpayMe = isRazorpayMe(base);
    return {
      ok: true,
      provider: razorpayMe ? "razorpay" : specific ? "plan_link" : links.stripe ? "stripe" : "generic",
      url: appendMeta(base, plan, source, businessId),
      plan: plan.id,
      price: plan.price,
      currency: plan.currency,
      ...extra,
      note: razorpayMe
        ? "Razorpay.me opens a handle where the payer enters the amount in INR. Opening the link is not a paid conversion. Record paid on the dashboard after money arrives."
        : extra.note,
    };
  }

  if (links.paypal) {
    const amount = plan.price.toFixed(2);
    const url = `${links.paypal}/${amount}${plan.currency}`;
    return {
      ok: true,
      provider: "paypal",
      url: appendMeta(url, plan, source, businessId),
      plan: plan.id,
      price: plan.price,
      currency: plan.currency,
      ...extra,
    };
  }

  if (links.razorpay) {
    return {
      ok: true,
      provider: "razorpay",
      url: appendMeta(links.razorpay, plan, source, businessId),
      plan: plan.id,
      price: plan.price,
      currency: plan.currency,
      ...extra,
      note: "Razorpay payment links charge in INR; confirm the rupee amount before sending. Opening the link is not a paid conversion.",
    };
  }

  return { ok: false, reason: "not_configured", mode, ...returns, paid: false };
}

function isRazorpayMe(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "razorpay.me" || host.endsWith(".razorpay.me");
  } catch {
    return false;
  }
}

function appendMeta(base, plan, source, businessId) {
  try {
    const url = new URL(base);
    // razorpay.me payment handles reject extra query params ("Amount not valid").
    if (isRazorpayMe(base)) return `${url.origin}${url.pathname}`.replace(/\/+$/, "") || base;
    url.searchParams.set("plan", plan.id);
    url.searchParams.set("amount", String(plan.price));
    if (source) url.searchParams.set("utm_source", String(source));
    if (businessId) url.searchParams.set("ref", String(businessId));
    return url.toString();
  } catch {
    return base;
  }
}

export function billingStatus() {
  const links = providerLinks();
  const configured = Object.entries(links).filter(([, v]) => Boolean(v)).map(([k]) => k);
  if (PLANS.some((p) => Boolean(planOverride(p.id))) && !configured.includes("plan_link")) {
    configured.push("plan_link");
  }
  const returns = returnUrls();
  return {
    ready: isBillingReady(),
    mode: billingMode(),
    providers: configured,
    currency: "USD",
    ...returns,
    note: "RingBack never processes cards. Payments go through the operator's own payment link. /pay/success does not mean paid.",
    plans: PLANS.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      setupFee: p.setupFee,
      linkConfigured: Boolean(planOverride(p.id)),
    })),
  };
}

export { PLANS };
