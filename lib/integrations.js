// Integration status registry.
//
// Every external dependency reports an honest state: live, simulated,
// not_configured, or error. Nothing in the product may claim an external action
// happened when it did not.

import { aiReady, aiStatus } from "./ai.js";
import { smsReady } from "./sms.js";
import { isBillingReady, billingStatus } from "./billing.js";
import { setIntegration, listIntegrations } from "./domain.js";

export const STATUS = {
  LIVE: "live",
  SIMULATED: "simulated",
  NOT_CONFIGURED: "not_configured",
  ERROR: "error",
};

export const STATUS_LABELS = {
  live: "LIVE",
  simulated: "SIMULATED",
  not_configured: "NOT CONFIGURED",
  error: "ERROR",
};

function envTruthy(name) {
  const v = process.env[name];
  return Boolean(v && v.trim() && v !== "false" && v !== "0");
}

export function calendarProvider() {
  if (envTruthy("RB_CALENDAR_PROVIDER")) return String(process.env.RB_CALENDAR_PROVIDER);
  return null;
}

export function integrationRegistry(business = {}) {
  const sms = smsReady();
  const ai = aiReady();
  const billing = isBillingReady();
  const calendar = calendarProvider();

  const channels = Array.isArray(business.channels) && business.channels.length
    ? business.channels
    : ["missed_call", "sms", "webchat", "web_form"];

  return [
    {
      provider: "sms",
      label: "Outbound SMS (Twilio)",
      status: sms ? STATUS.LIVE : STATUS.SIMULATED,
      detail: sms ? "Twilio credentials configured." : "No Twilio credentials. Messages are recorded and marked simulated.",
    },
    {
      provider: "ai",
      label: "AI receptionist (LLM)",
      status: ai ? STATUS.LIVE : STATUS.NOT_CONFIGURED,
      detail: ai
        ? `Using ${aiStatus().model}.`
        : "No USER_LLM_API_KEY. Running the deterministic receptionist instead.",
    },
    {
      provider: "calendar",
      label: "Calendar / booking",
      status: calendar ? STATUS.LIVE : STATUS.SIMULATED,
      detail: calendar ? `Provider: ${calendar}.` : "No calendar provider. Using the built-in demo calendar (slots need customer confirmation).",
    },
    {
      provider: "billing",
      label: "Billing / checkout",
      status: billing ? STATUS.LIVE : STATUS.NOT_CONFIGURED,
      detail: billing ? "Payment link configured." : "No payment link configured. Checkout returns not_configured.",
    },
    {
      provider: "channels",
      label: "Messaging channels",
      status: STATUS.LIVE,
      detail: `Enabled: ${channels.join(", ")}.`,
    },
    {
      provider: "owner_alerts",
      label: "Owner alerts",
      status: sms || envTruthy("RB_ALERT_EMAIL") ? STATUS.LIVE : STATUS.SIMULATED,
      detail:
        sms || envTruthy("RB_ALERT_EMAIL")
          ? "Alerts are delivered to the configured contact."
          : "Alerts are recorded in-app only (no SMS/email credentials).",
    },
  ];
}

export function syncIntegrations(business) {
  const registry = integrationRegistry(business);
  for (const item of registry) {
    setIntegration({
      businessId: business.id,
      provider: item.provider,
      status: item.status,
      note: item.detail,
    });
  }
  return registry;
}

export function storedIntegrations(businessId) {
  return listIntegrations(businessId);
}

export { billingStatus, aiStatus };
