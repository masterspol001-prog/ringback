import { smsReady, smsStatus, smsWebhooks } from "./sms.js";

const CARRIERS = {
  verizon: {
    id: "verizon",
    label: "Verizon",
    unanswered: "Dial *71, then the RingBack number, then Send. Wait for the confirmation tone.",
    cancel: "Dial *73 and wait for the confirmation tone.",
  },
  att: {
    id: "att",
    label: "AT&T",
    unanswered: "Dial *92, then the RingBack number, then #. Wait for confirmation.",
    cancel: "Dial *93# and wait for confirmation.",
  },
  tmobile: {
    id: "tmobile",
    label: "T-Mobile",
    unanswered: "Dial **61*, then the RingBack number, then #.",
    cancel: "Dial ##61#.",
  },
  other: {
    id: "other",
    label: "Other / landline",
    unanswered: "Ask the carrier to forward unanswered and busy calls to the RingBack number. Do not use unconditional (*72) forwarding or every live call will miss the truck.",
    cancel: "Ask the carrier to turn off no-answer forwarding.",
  },
};

export function carrierGuide(carrier) {
  const key = String(carrier || "other").toLowerCase().replace(/[^a-z]/g, "");
  if (key === "atandt" || key === "att") return CARRIERS.att;
  if (key === "verizon") return CARRIERS.verizon;
  if (key === "tmobile" || key === "tmo") return CARRIERS.tmobile;
  return CARRIERS.other;
}

export function carrierList() {
  return Object.values(CARRIERS).map((c) => ({ id: c.id, label: c.label }));
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function forwardingGuide({ shopPhone = "", twilioNumber = "", carrier = "other" } = {}) {
  const c = carrierGuide(carrier);
  const ringback = twilioNumber || "your RingBack / Twilio number";
  return {
    ok: true,
    flippedByRingBack: false,
    shopPhone: shopPhone || "",
    ringbackNumber: twilioNumber || "",
    carrier: c.id,
    carrierLabel: c.label,
    steps: [
      "Keep the shop number customers already dial. Do not port it.",
      "Forward unanswered and busy calls only. Live answered calls must still ring the truck.",
      c.unanswered.replace("the RingBack number", ringback),
      "Miss a test call on purpose. The caller should get a text. You should get a ping with their number.",
      "To turn it off: " + c.cancel,
    ],
    note: "RingBack cannot flip forwarding at the carrier. You turn it on. Confirm the codes with your carrier if they differ.",
  };
}

export function connectNumberStatus({ shopPhone = "", ownerPhone = "", hours = "", carrier = "other", forwarded = false } = {}) {
  const sms = smsStatus();
  const webhooks = smsWebhooks();
  const shop = digits(shopPhone);
  const owner = digits(ownerPhone);
  const live = sms.ready === true && sms.mode === "live";
  const missing = [];
  if (shop.length < 7) missing.push("shop_phone");
  if (owner.length < 7) missing.push("owner_phone");
  if (!live) missing.push("twilio");
  if (!forwarded) missing.push("forwarding_not_confirmed");
  return {
    ok: true,
    connected: missing.length === 0,
    forwarded: Boolean(forwarded),
    shopPhone: shopPhone || "",
    ownerPhone: ownerPhone || "",
    hours: hours || "",
    carrier: carrierGuide(carrier).id,
    sms: { mode: sms.mode, ready: sms.ready, fromNumber: sms.fromNumber || "" },
    webhooks,
    missing,
    next: missing.length
      ? [
          missing.includes("shop_phone") ? "Save the number customers dial." : null,
          missing.includes("owner_phone") ? "Save your cell so after-hours pings reach you, not the shop line." : null,
          missing.includes("twilio") ? "Set TWILIO_* so a real text can go out. Until then pings stay in the dashboard." : null,
          missing.includes("forwarding_not_confirmed") ? "Forward unanswered calls, then check the box. RingBack cannot verify the carrier." : null,
        ].filter(Boolean)
      : ["Unanswered calls should hit /api/twilio/voice. Test by missing one call."],
    guide: forwardingGuide({ shopPhone, twilioNumber: live ? sms.fromNumber : "", carrier }),
  };
}
