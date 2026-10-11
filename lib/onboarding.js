import { activationChecklist } from "./business.js";
import { smsReady } from "./sms.js";
import { getSettings } from "./domain.js";
import { listPayments } from "./store.js";

export const ONBOARDING_STATES = [
  "setup_requested",
  "configuration_in_progress",
  "ready_for_testing",
  "live",
];

export function onboardingState({ business = {}, settings = null, activation = null } = {}) {
  const saved = settings || getSettings(business.id || "demo") || {};
  if (saved.deletedAt) {
    return { state: "setup_requested", live: false, reason: "deleted" };
  }
  const gate = activation || activationChecklist(business);
  const smsLive = smsReady();
  const paid = listPayments().some((p) => p.businessId === business.id || p.setupId === business.id);
  if (saved.live === true && gate.ready && smsLive) {
    return { state: "live", live: true, paid, activation: gate, smsLive };
  }
  if (gate.ready && smsLive) {
    return {
      state: "ready_for_testing",
      live: false,
      paid,
      activation: gate,
      smsLive,
      note: "Configured and Twilio is LIVE. Run a test missed call, then activate live automation.",
    };
  }
  const named = Boolean(business.name) && business.name !== "Your Business";
  if (!named || gate.missing.length >= 8) {
    return {
      state: "setup_requested",
      live: false,
      paid,
      activation: gate,
      smsLive,
      note: "Setup requested. Configuration is not complete.",
    };
  }
  return {
    state: "configuration_in_progress",
    live: false,
    paid,
    activation: gate,
    smsLive,
    missing: gate.missing,
    note: "Configuration in progress. Live SMS stays off until the checklist and Twilio are complete.",
  };
}

export function canActivateLive(snapshot) {
  return snapshot.state === "ready_for_testing" || snapshot.state === "live";
}
