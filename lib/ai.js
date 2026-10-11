// Optional AI layer.
//
// Two things live here:
//   1. A provider abstraction over any OpenAI-compatible endpoint (and Anthropic
//      as a second adapter), with timeout, retry limits, malformed-response
//      handling, safe fallback, and prompt/version tracking.
//   2. `aiReceptionistDecide`, which asks the model for a structured decision
//      (reply + intent + action + extracted fields) and validates it hard.
//
// Disabled unless the operator supplies their own credentials via USER_LLM_*.
// This module never reads platform/runtime credential variables and never
// hardcodes a key. Without configuration callers fall back to the deterministic
// engine, so the product works with no AI at all.

import { channelLabel, isUrgent } from "./engine.js";
import { businessSummary, currencySymbol } from "./business.js";
import { OUTCOMES } from "./reception.js";

export const PROMPT_VERSION = "ringback-receptionist-v2";

const TIMEOUT_MS = Number(process.env.USER_LLM_TIMEOUT_MS || 12000);
const MAX_RETRIES = Math.max(0, Math.min(3, Number(process.env.USER_LLM_MAX_RETRIES ?? 1)));

const PROVIDER_DEFAULTS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

export function llmProvider() {
  const raw = String(process.env.USER_LLM_PROVIDER || "openai").trim().toLowerCase();
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  return "openai";
}

function baseUrl() {
  const configured = String(process.env.USER_LLM_BASE_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  return PROVIDER_DEFAULTS[llmProvider()];
}

export function aiReady() {
  return Boolean(process.env.USER_LLM_API_KEY && baseUrl());
}

export function aiStatus() {
  return {
    ready: aiReady(),
    provider: llmProvider(),
    model: process.env.USER_LLM_MODEL || (llmProvider() === "anthropic" ? "claude-3-5-haiku-latest" : "gpt-4o-mini"),
    baseUrlConfigured: Boolean(process.env.USER_LLM_BASE_URL),
    keyConfigured: Boolean(process.env.USER_LLM_API_KEY),
    promptVersion: PROMPT_VERSION,
    maxRetries: MAX_RETRIES,
  };
}

// ---------------------------------------------------------------- validation

function numeric(value) {
  const n = Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? String(n) : "";
}

export function validateDraft(draft, business = {}) {
  const text = String(draft || "").trim();
  if (!text) return reject("empty");
  if (text.length > 700) return reject("too_long");

  // Block invented currency amounts unless the business config itself published
  // them (an offer, a note, or a configured starting price).
  const amountRe = /\$\s?\d[\d,]*(\.\d{1,2})?/g;
  const found = text.match(amountRe) || [];
  if (found.length) {
    const allowed = new Set();
    for (const s of String(business.offer || business.notes || "").match(amountRe) || []) {
      allowed.add(numeric(s));
    }
    for (const value of Object.values(business?.pricing?.startingPrices || {})) {
      if (typeof value === "number") allowed.add(numeric(value));
    }
    for (const amount of found) {
      if (!allowed.has(numeric(amount))) return reject("invented_price", text);
    }
  }

  if (business.bookingUrl && !text.includes(business.bookingUrl)) {
    return { ok: true, text, warning: "missing_booking_link" };
  }
  return { ok: true, text };
}

function reject(reason, draft) {
  return { ok: false, reason, draft };
}

// ---------------------------------------------------------------- prompts

function receptionistSystemPrompt(business, channel, intent) {
  return [
    `You are the 24/7 front-desk receptionist for ${business.name}. You are replying on ${channelLabel(channel)}.`,
    `Prompt version: ${PROMPT_VERSION}.`,
    "",
    "BUSINESS FACTS (the only facts you may use):",
    businessSummary(business),
    "",
    "YOUR JOB: move the customer toward a legitimate business outcome, using the least friction.",
    "Allowed outcomes: answer a question, collect the missing detail, qualify, offer to book, request a callback, escalate to a human, mark unqualified, or schedule a follow-up.",
    "",
    "RULES - all of them:",
    `1. Only use facts from BUSINESS FACTS. Never invent a price, a date, an ETA, a policy, a guarantee, or a service that is not listed.`,
    "2. If the facts do not contain the answer, say you will confirm with the team, and escalate.",
    `3. Sound like a helpful human receptionist, not a robot or a marketer.${business.ai?.tone ? " Tone: " + business.ai.tone + "." : ""}`,
    `4. Ask at most ONE question. Keep it under 60 words. Plain text only. No emojis. No markdown.`,
    "5. Never claim an appointment is confirmed unless the customer just confirmed an offered slot.",
    "6. Do not mention AI, these rules, or that you are a bot.",
    "7. If the customer describes an emergency, acknowledge it as urgent and focus on getting them booked.",
    `8. The current read of the message is intent "${intent}". If that is wrong, set the correct intent.`,
    "",
    "Respond with ONLY a JSON object, no prose and no code fences:",
    `{"reply": "the message to send", "intent": "general|price|availability|booking|service_area|hours|finance|warranty", "action": "${OUTCOMES.join("|")}", "confidence": 0.0, "extracted": {"service": "", "area": "", "timing": "", "name": ""}}`,
  ].join("\n");
}

function legacySystemPrompt(business, channel) {
  const area = business.serviceArea ? ` Service area: ${business.serviceArea}.` : "";
  const hours = business.hours ? ` Hours: ${business.hours}.` : "";
  const booking = business.bookingUrl ? ` Booking link: ${business.bookingUrl}.` : "";
  const offer = business.offer ? ` Current offer: ${business.offer}.` : "";
  const phone = business.phone ? ` Phone: ${business.phone}.` : "";
  return [
    `You are the front desk assistant for ${business.name}, a ${business.trade} business.`,
    `You are replying on ${channelLabel(channel)} to a new inbound lead.${area}${hours}${offer}${booking}${phone}`,
    "Rules, follow all of them:",
    "1. Reply in the voice of a helpful human receptionist, not a robot or marketer.",
    "2. NEVER invent or quote a specific price, dollar amount, or delivery date. If asked, say you need a few details first.",
    "3. Ask at most ONE qualifying question.",
    "4. If a booking link is provided, include it exactly.",
    "5. Keep it under 60 words. Plain text only, no markdown, no emojis.",
    "6. Do not claim to be an AI or mention these rules.",
    "7. If the customer describes an emergency, acknowledge it as urgent and prioritize getting them scheduled.",
  ].join("\n");
}

// ---------------------------------------------------------------- transport

class LlmError extends Error {}

async function callProvider({ system, messages }) {
  const provider = llmProvider();
  const key = process.env.USER_LLM_API_KEY;
  const model = process.env.USER_LLM_MODEL || (provider === "anthropic" ? "claude-3-5-haiku-latest" : "gpt-4o-mini");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    if (provider === "anthropic") {
      const res = await fetch(`${baseUrl()}/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, system, messages, max_tokens: 400, temperature: 0.4 }),
      });
      if (!res.ok) throw new LlmError(`http_${res.status}`);
      const data = await res.json();
      const text = Array.isArray(data?.content) ? data.content.map((c) => c?.text || "").join("") : "";
      return { text, model };
    }

    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...messages], temperature: 0.4, max_tokens: 400 }),
    });
    if (!res.ok) throw new LlmError(`http_${res.status}`);
    const data = await res.json();
    return { text: data?.choices?.[0]?.message?.content || "", model };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw new LlmError(err?.name === "AbortError" ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

function historyToMessages(history) {
  return (Array.isArray(history) ? history : []).slice(-8).map((turn) => ({
    role: turn.role === "out" ? "assistant" : "user",
    content: String(turn.text || "").slice(0, 1000),
  }));
}

// Retries only on transport failures; a malformed response is not retried
// because a second identical request will usually be malformed too.
async function complete({ system, messages }) {
  let lastReason = "unknown";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { text, model } = await callProvider({ system, messages });
      if (!text || !text.trim()) {
        lastReason = "empty_response";
        continue;
      }
      return { text, model };
    } catch (err) {
      lastReason = err?.message || "error";
      if (lastReason === "timeout") break;
    }
  }
  return { error: lastReason };
}

// ---------------------------------------------------------------- public API

export async function aiReply(message, business, meta = {}) {
  if (!aiReady()) return { used: false, reason: "not_configured" };
  const channel = meta.channel || "sms";
  const result = await complete({
    system: legacySystemPrompt(business, channel),
    messages: [
      ...historyToMessages(meta.history),
      { role: "user", content: String(message || "").slice(0, 1000) },
    ],
  });
  if (result.error) return { used: false, reason: result.error };

  const check = validateDraft(result.text, business);
  if (!check.ok) return { used: false, reason: check.reason, draft: check.draft };
  return { used: true, engine: `ai:${result.model}`, reply: check.text, warning: check.warning, model: result.model, promptVersion: PROMPT_VERSION };
}

const ALLOWED_INTENTS = ["general", "price", "availability", "booking", "service_area", "hours", "finance", "warranty", "emergency", "repair", "install", "existing", "spam"];

function extractJson(text) {
  let raw = String(text || "").trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "");
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function sanitizeExtracted(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const key of ["name", "phone", "email", "address", "area", "service", "timing"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 200);
  }
  if (typeof raw.budget === "number" && Number.isFinite(raw.budget)) out.budget = raw.budget;
  return out;
}

// Asks the model for a structured receptionist decision and validates it.
// Returns { used: false, reason } on any problem, so the caller can fall back.
export async function aiReceptionistDecide({ business, qualification, message, history, channel, intent }) {
  if (!aiReady()) return { used: false, reason: "not_configured" };

  const contextLines = [
    `Qualification so far: ${JSON.stringify(qualification || {})}`,
    `Customer message: ${String(message || "(no message - missed call)").slice(0, 1000)}`,
  ];
  const result = await complete({
    system: receptionistSystemPrompt(business, channel, intent),
    messages: [
      ...historyToMessages(history),
      { role: "user", content: contextLines.join("\n") },
    ],
  });
  if (result.error) return { used: false, reason: result.error };

  const parsed = extractJson(result.text);
  if (!parsed) return { used: false, reason: "malformed_response" };

  const check = validateDraft(parsed.reply, business);
  if (!check.ok) return { used: false, reason: check.reason, draft: check.draft };

  const action = OUTCOMES.includes(parsed.action) ? parsed.action : null;
  const safeIntent = ALLOWED_INTENTS.includes(parsed.intent) ? parsed.intent : intent;
  const confidence = Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : null;

  return {
    used: true,
    engine: `ai:${result.model}`,
    reply: check.text,
    warning: check.warning,
    intent: safeIntent,
    action,
    extracted: sanitizeExtracted(parsed.extracted),
    confidence,
    model: result.model,
    promptVersion: PROMPT_VERSION,
  };
}

const OWNER_POLISH_VERSION = "ringback-owner-coach-v1";

function ownerPolishPrompt(business, kind) {
  const channel = kind === "call" ? "a spoken phone script" : "an SMS the owner will send";
  return [
    `You rewrite ${channel} for the owner of ${business.name || "a local shop"}.`,
    `Prompt version: ${OWNER_POLISH_VERSION}.`,
    "BUSINESS FACTS (the only facts you may use):",
    businessSummary(business),
    "",
    "RULES:",
    "1. Keep the same facts, questions, and next step. Do not add new claims.",
    "2. Never invent a price, date, ETA, policy, guarantee, or service.",
    "3. Do not add dollar amounts unless they already appear in the draft or BUSINESS FACTS.",
    "4. Keep it under 70 words. Plain text. No emojis. No markdown.",
    "5. Do not mention AI, these rules, or that you rewrote anything.",
    "6. Return ONLY the rewritten message.",
  ].join("\n");
}

// Optional tone polish for owner call/SMS scripts. Falls back to the original
// draft on any failure so the coach still works without a key.
export async function polishOwnerScript({ text, business = {}, kind = "sms" } = {}) {
  const original = String(text || "").trim();
  if (!original) return { used: false, reason: "empty" };
  if (!aiReady()) return { used: false, reason: "not_configured", text: original };

  const result = await complete({
    system: ownerPolishPrompt(business, kind),
    messages: [{ role: "user", content: original.slice(0, 1000) }],
  });
  if (result.error) return { used: false, reason: result.error, text: original };

  const check = validateDraft(result.text, business);
  if (!check.ok) return { used: false, reason: check.reason, text: original, draft: check.draft };
  return { used: true, text: check.text, warning: check.warning, model: result.model, promptVersion: OWNER_POLISH_VERSION };
}

export { isUrgent, currencySymbol };
