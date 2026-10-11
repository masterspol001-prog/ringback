// Security helpers: rate limiting, webhook signature verification, and
// conservative input sanitization. All of these fail closed and never throw
// into the request path.

import { createHmac, timingSafeEqual } from "node:crypto";

const WINDOW_MS = Number(process.env.RB_RATE_WINDOW_MS || 60_000);
const MAX_HITS = Number(process.env.RB_RATE_MAX || 60);

const buckets = new Map();

function prune(now) {
  if (buckets.size < 2000) return;
  for (const [key, entry] of buckets) {
    if (now - entry.start > WINDOW_MS * 2) buckets.delete(key);
  }
}

export function rateLimit(key, options = {}) {
  const windowMs = options.windowMs || WINDOW_MS;
  const max = options.max || MAX_HITS;
  const now = Date.now();
  prune(now);
  const entry = buckets.get(key);
  if (!entry || now - entry.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return { ok: true, remaining: max - 1, retryAfter: 0 };
  }
  entry.count += 1;
  if (entry.count > max) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((entry.start + windowMs - now) / 1000) };
  }
  return { ok: true, remaining: max - entry.count, retryAfter: 0 };
}

export function clientKey(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

// Abstraction over common webhook signature schemes. Returns { ok, reason }.
// If no secret is configured the result is `not_configured` so callers can
// still accept the request in demo mode without claiming it was verified.
export function verifyWebhook({ provider, secret, payload, signature, timestamp }) {
  if (!secret) return { ok: false, reason: "not_configured", verified: false };
  if (!signature) return { ok: false, reason: "missing_signature", verified: false };

  const body = typeof payload === "string" ? payload : JSON.stringify(payload || {});
  const p = String(provider || "hmac").toLowerCase();

  try {
    if (p === "twilio") {
      // Twilio signs the full URL + sorted form params. Callers pass that
      // concatenated string as `payload` and the header as `signature`.
      const expected = createHmac("sha1", secret).update(body).digest("base64");
      return compare(expected, signature) ? { ok: true, verified: true } : { ok: false, reason: "bad_signature", verified: false };
    }
    if (p === "stripe") {
      const signed = `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
      return compare(signed, signature) ? { ok: true, verified: true } : { ok: false, reason: "bad_signature", verified: false };
    }
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    return compare(expected, signature) ? { ok: true, verified: true } : { ok: false, reason: "bad_signature", verified: false };
  } catch {
    return { ok: false, reason: "error", verified: false };
  }
}

function compare(expected, actual) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(actual));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function resetRateLimit() {
  buckets.clear();
}
