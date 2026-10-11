import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicBaseUrl } from "./billing.js";

const DEFAULT_CSV = join(dirname(fileURLToPath(import.meta.url)), "..", "outreach", "prospects.csv");

function csvFile() {
  return process.env.RINGBACK_OUTREACH_CSV || DEFAULT_CSV;
}

export const PROSPECT_HEADER = [
  "business", "trade", "city", "state", "phone", "email", "website",
  "owner_name", "reviews", "rating", "runs_ads", "status", "channel",
  "date_contacted", "replied", "reply_text", "next_action", "notes",
];

const STATUSES = new Set(["new", "contacted", "replied", "interested", "call_booked", "paid", "lost", "skip"]);

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

export function csvPath() {
  return csvFile();
}

export function listProspects() {
  const CSV_PATH = csvFile();
  if (!existsSync(CSV_PATH)) return [];
  const rows = parseCsv(readFileSync(CSV_PATH, "utf8"));
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => {
    const rec = {};
    header.forEach((h, i) => {
      rec[h] = (r[i] ?? "").trim();
    });
    return rec;
  });
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizeProspect(raw = {}) {
  const business = String(raw.business || "").trim().slice(0, 120);
  const email = String(raw.email || "").trim().slice(0, 160);
  const phone = String(raw.phone || "").trim().slice(0, 40);
  if (!business) return { ok: false, error: "business_required" };
  if (!email && !phone) return { ok: false, error: "phone_or_email_required" };
  if (email && !looksLikeEmail(email)) return { ok: false, error: "invalid_email" };
  const digits = phoneDigits(phone);
  if (phone && digits.length < 7) return { ok: false, error: "invalid_phone" };

  const status = String(raw.status || "new").trim().toLowerCase();
  return {
    ok: true,
    prospect: {
      business,
      trade: String(raw.trade || "hvac").trim().slice(0, 40) || "hvac",
      city: String(raw.city || "").trim().slice(0, 80),
      state: String(raw.state || "").trim().slice(0, 40),
      phone,
      email,
      website: String(raw.website || "").trim().slice(0, 200),
      owner_name: String(raw.owner_name || raw.name || "").trim().slice(0, 80),
      reviews: String(raw.reviews || "").trim().slice(0, 12),
      rating: String(raw.rating || "").trim().slice(0, 8),
      runs_ads: String(raw.runs_ads || "").trim().slice(0, 8),
      status: STATUSES.has(status) ? status : "new",
      channel: String(raw.channel || "").trim().slice(0, 40),
      date_contacted: String(raw.date_contacted || "").trim().slice(0, 40),
      replied: String(raw.replied || "").trim().slice(0, 8),
      reply_text: String(raw.reply_text || "").trim().slice(0, 400),
      next_action: String(raw.next_action || "").trim().slice(0, 200),
      notes: String(raw.notes || "").trim().slice(0, 400),
    },
  };
}

function rowFor(prospect) {
  return PROSPECT_HEADER.map((h) => csvEscape(prospect[h] || "")).join(",");
}

export function addProspect(raw = {}) {
  const parsed = normalizeProspect(raw);
  if (!parsed.ok) return parsed;
  const existing = listProspects();
  const dup = existing.find((p) => {
    const sameBiz = p.business.toLowerCase() === parsed.prospect.business.toLowerCase();
    const sameEmail = parsed.prospect.email && p.email && p.email.toLowerCase() === parsed.prospect.email.toLowerCase();
    const samePhone = parsed.prospect.phone && phoneDigits(p.phone) === phoneDigits(parsed.prospect.phone) && phoneDigits(parsed.prospect.phone).length >= 7;
    return sameBiz && (sameEmail || samePhone);
  });
  if (dup) return { ok: false, error: "duplicate_prospect" };

  const CSV_PATH = csvFile();
  const headerLine = PROSPECT_HEADER.join(",");
  let text = "";
  if (existsSync(CSV_PATH)) text = readFileSync(CSV_PATH, "utf8");
  if (!text.trim()) text = headerLine + "\n";
  else if (!text.endsWith("\n")) text += "\n";
  text += rowFor(parsed.prospect) + "\n";
  writeFileSync(CSV_PATH, text);
  return { ok: true, prospect: parsed.prospect, count: existing.length + 1, sent: false };
}

export function demoLink() {
  return publicBaseUrl() || "";
}

export function draftEmail(prospect = {}, extras = {}) {
  const parsed = prospect.business ? { ok: true, prospect: normalizeProspect(prospect).prospect || prospect } : normalizeProspect(prospect);
  const p = parsed.ok ? parsed.prospect : prospect;
  const name = p.owner_name || "there";
  const business = p.business || "your shop";
  const link = String(extras.demoLink || demoLink() || "").trim();
  const demoLine = link
    ? `If not, no worries — here is the demo so you can judge it yourself: ${link}`
    : "If not, no worries — I can walk you through a missed-call recovery on a screen share.";
  const subject = `${business} — missed call recovery`;
  const body = [
    `Hi ${name},`,
    "",
    `I am not selling ads. HVAC shops lose jobs when a missed call goes to voicemail and the next company on the list answers.`,
    "",
    "RingBack texts the caller back in seconds, asks what they need, and queues them for you. You mark the job won when the invoice is real. Estimated and verified dollars stay separate.",
    "",
    "Want me to set it up on your number for 14 days? You will see recovered conversations in the dashboard before you pay.",
    "",
    demoLine,
    "",
    "I will not blast this. One shop, one email.",
  ].join("\n");
  return {
    ok: true,
    sent: false,
    subject,
    body,
    to: p.email || "",
    note: "Draft only. RingBack does not send cold email. Copy this and send it yourself.",
  };
}

export function outreachSummary() {
  const prospects = listProspects();
  return {
    ok: true,
    count: prospects.length,
    path: "outreach/prospects.csv",
    sent: false,
    note: "Add shops you already looked up. RingBack does not scrape Google Maps or send email.",
  };
}
