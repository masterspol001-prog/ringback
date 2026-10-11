// Optional outbound SMS. Enabled only when Twilio env vars are present.
// If they are not set, RingBack runs in simulated mode so the demo never breaks.
import { publicBaseUrl } from "./billing.js";

export function validPhone(value) {
  const d = String(value || "").replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15;
}

export function smsUnavailableReason(error, detail = "") {
  const hay = `${error || ""} ${detail || ""}`.toLowerCase();
  if (/21614|21612|30003|30006|landline|unreachable|not a mobile|cannot receive sms/.test(hay)) {
    return "sms_unavailable";
  }
  return null;
}

export function withSenderIdentity(text, business = {}) {
  const body = String(text || "").trim();
  const name = String(business.senderIdentity || business.name || "").trim();
  if (!body) return body;
  const auth = name && name !== "Your Business"
    ? `${name} (texting on behalf of ${name}).`
    : "";
  const hasStop = /\bstop\b/i.test(body);
  const stop = hasStop ? "" : " Reply STOP to opt out.";
  if (auth && body.toLowerCase().includes(name.toLowerCase())) return `${body}${stop}`.trim();
  if (auth) return `${auth} ${body}${stop}`.trim();
  return `${body}${stop}`.trim();
}

export function smsReady() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER
  );
}

function maskPhone(value) {
  const d = String(value || "").replace(/\D/g, "");
  if (d.length < 4) return "";
  return "..." + d.slice(-4);
}

export function smsWebhooks() {
  const base = publicBaseUrl();
  const smsPath = "/api/twilio/sms";
  const voicePath = "/api/twilio/voice";
  return {
    smsPath,
    voicePath,
    smsUrl: base ? `${base}${smsPath}` : null,
    voiceUrl: base ? `${base}${voicePath}` : null,
    publicUrlConfigured: Boolean(base),
    note: base
      ? "Paste these URLs into the Twilio console. RingBack never claims a text was delivered unless Twilio is LIVE."
      : "Set RB_PUBLIC_URL so these become absolute URLs. Paths still work on this host.",
  };
}

export function smsStatus() {
  const webhooks = smsWebhooks();
  if (smsReady()) {
    return {
      ready: true,
      mode: "live",
      provider: "twilio",
      simulated: false,
      fromNumber: maskPhone(process.env.TWILIO_FROM_NUMBER),
      webhooks,
    };
  }
  return {
    ready: false,
    mode: "simulated",
    provider: "twilio",
    simulated: true,
    reason: "twilio_not_configured",
    fromNumber: "",
    webhooks,
    next: [
      "Create a Twilio account and a number that can send SMS.",
      "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER in .env.",
      "Point the Twilio SMS webhook at /api/twilio/sms.",
      "Point missed-call / status callback at /api/twilio/voice.",
      "Restart RingBack. Health must show sms mode live before a real text is claimed.",
    ],
  };
}

export function parseTwilioInbound(params = {}) {
  const phone = String(params.From || params.from || params.phone || "").trim();
  const to = String(params.To || params.to || "").trim();
  const body = String(params.Body || params.body || params.message || "").trim();
  const callSid = String(params.CallSid || params.callSid || "").trim();
  const messageSid = String(params.MessageSid || params.SmsSid || params.messageSid || "").trim();
  const callStatus = String(params.CallStatus || params.DialCallStatus || params.callStatus || "").trim().toLowerCase();
  const messageStatus = String(params.MessageStatus || params.SmsStatus || params.messageStatus || "").trim().toLowerCase();
  const errorCode = String(params.ErrorCode || params.errorCode || "").trim();
  const isVoice = Boolean(callSid) && !messageSid;
  return { phone, to, body, callSid, messageSid, callStatus, messageStatus, errorCode, isVoice };
}

export function mapTwilioMessageStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "delivered") return "delivered";
  if (s === "sent" || s === "queued" || s === "accepted" || s === "sending") return "sent";
  if (s === "failed" || s === "undelivered") return "undelivered";
  return null;
}

export function isMissedVoiceStatus(status) {
  return ["no-answer", "busy", "failed", "canceled", "cancelled"].includes(String(status || "").toLowerCase());
}

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function sendSms(to, body) {
  if (!smsReady()) {
    return { sent: false, simulated: true, reason: "twilio_not_configured" };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const form = new URLSearchParams({ To: to, From: from, Body: body });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text();
      const unavailable = smsUnavailableReason(`twilio_${res.status}`, detail);
      return { sent: false, simulated: false, error: unavailable || `twilio_${res.status}`, detail: detail.slice(0, 300) };
    }
    const data = await res.json();
    return { sent: true, simulated: false, sid: data.sid };
  } catch (err) {
    return { sent: false, simulated: false, error: "network", detail: String(err).slice(0, 200) };
  }
}
