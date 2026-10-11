// Booking.
//
// No calendar provider is required. Without one we run a deterministic demo
// calendar built from the business's configured hours, which is honest: slots
// are labelled "requested" or "proposed" until a customer explicitly confirms,
// and only then does an appointment become "confirmed".
//
// With a provider configured, `provider` records which one, and the same
// statuses apply. This module never claims a confirmation that did not happen.

import { WEEKDAYS } from "./extract.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n) {
  return String(n).padStart(2, "0");
}

// Parses "09:00" into minutes since midnight.
function toMinutes(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function dateKeyFromUtc(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// Deterministic slot proposal. Slots are business-local wall-clock times; we
// carry the date as a plain YYYY-MM-DD string so no timezone can shift a day.
export function proposeSlots(business, options = {}) {
  const now = options.from instanceof Date ? options.from : new Date();
  const count = Math.max(1, Math.min(6, Number(options.count) || 3));
  const rules = business?.bookingRules || {};
  const calendar = business?.calendar || {};
  const days = Array.isArray(calendar.days) && calendar.days.length ? calendar.days : [1, 2, 3, 4, 5, 6];
  const times = Array.isArray(calendar.times) && calendar.times.length ? calendar.times : ["09:00", "13:00", "16:00"];
  const daysAhead = Number(rules.daysAhead) || 7;
  const leadTimeHours = Number(rules.leadTimeHours) || 0;
  const earliest = new Date(now.getTime() + leadTimeHours * 3600_000);
  const source = calendar.provider ? "calendar" : "demo_availability";
  const demo = source !== "calendar";

  const slots = [];
  const cursor = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), earliest.getUTCDate(), 12, 0, 0));
  for (let i = 0; i <= daysAhead && slots.length < count; i++) {
    const day = new Date(cursor.getTime());
    day.setUTCDate(day.getUTCDate() + i);
    if (!days.includes(day.getUTCDay())) continue;
    for (const time of times) {
      if (slots.length >= count) break;
      const minutes = toMinutes(time);
      if (minutes === null) continue;
      const slotDate = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, minutes, 0));
      if (slotDate.getTime() < earliest.getTime()) continue;
      const key = dateKeyFromUtc(slotDate);
      const baseLabel = `${DAY_NAMES[slotDate.getUTCDay()]}, ${MONTHS[slotDate.getUTCMonth()]} ${slotDate.getUTCDate()} at ${formatTime(time)}`;
      slots.push({
        date: key,
        time,
        weekday: slotDate.getUTCDay(),
        label: demo ? `${baseLabel} (Demo availability)` : baseLabel,
        source,
        demo,
      });
    }
  }
  return slots;
}

export function formatTime(hhmm) {
  const minutes = toMinutes(hhmm);
  if (minutes === null) return String(hhmm || "");
  const hour24 = Math.floor(minutes / 60);
  const min = minutes % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${pad(min)} ${suffix}`;
}

// Matches a customer reply to one of the offered slots. Supports "the first
// one", "Tuesday", "9am", "9:00", and "1pm".
export function parseSlotChoice(text, slots = []) {
  const t = String(text || "").toLowerCase();
  if (!t || !slots.length) return null;

  const ordinal = t.match(/\b(first|1st|one|second|2nd|two|third|3rd|three|fourth|4th)\b/);
  if (ordinal) {
    const map = { first: 0, "1st": 0, one: 0, second: 1, "2nd": 1, two: 1, third: 2, "3rd": 2, three: 2, fourth: 3, "4th": 3 };
    const idx = map[ordinal[1]];
    if (idx !== undefined && slots[idx]) return slots[idx];
  }
  const numbered = t.match(/^\s*([1-6])(?:\s*[.)])?\s*$/);
  if (numbered) {
    const idx = Number(numbered[1]) - 1;
    if (slots[idx]) return slots[idx];
  }

  // Explicit time, e.g. "9", "9am", "9:30am", "1pm".
  const timeMatch = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const min = timeMatch[2] ? Number(timeMatch[2]) : 0;
    const suffix = timeMatch[3];
    if (suffix === "pm" && hour !== 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
    const wanted = `${pad(hour)}:${pad(min)}`;
    const hit = slots.find((s) => s.time === wanted);
    if (hit) return hit;
  }

  // A named weekday.
  for (const [name, index] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      const hit = slots.find((s) => s.weekday === index);
      if (hit) return hit;
    }
  }

  return null;
}

export function isConfirmation(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return /^(yes|yep|yeah|yup|sure|ok|okay|k|confirm|confirmed|approved|book it|do it|go ahead|please do|sounds good|that works|works for me|perfect|great)\b/i.test(t) ||
    /\b(book it|confirm|that works|works for me|sounds good|go ahead|lock it in|see you)\b/i.test(t);
}

export function isDecline(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return /^(no|nope|nah|not now|not yet|later|no thanks|no thank you|maybe later|cancel)\b/i.test(t);
}

// Turns a chosen slot into appointment fields.
export function slotToAppointment(slot, extra = {}) {
  return {
    preferredDate: slot.date,
    preferredTime: slot.time,
    status: extra.status || "confirmed",
    provider: extra.provider || "demo_calendar",
    service: extra.service || "",
    notes: extra.notes || `Confirmed for ${slot.label}.`,
  };
}

export const APPOINTMENT_FLOW = ["available", "offered", "selected", "confirmed", "completed", "revenue_verified"];

export function appointmentFlowState({ leadStatus, appointmentStatus, confirmedRevenue } = {}) {
  if (Number(confirmedRevenue) > 0) return "revenue_verified";
  if (appointmentStatus === "completed" || leadStatus === "won") return "completed";
  if (appointmentStatus === "confirmed" || leadStatus === "booked") return "confirmed";
  if (appointmentStatus === "selected") return "selected";
  if (appointmentStatus === "offered" || appointmentStatus === "proposed" || appointmentStatus === "requested" || leadStatus === "booking_requested") return "offered";
  return "available";
}

export function appointmentFlowLabel(state) {
  return {
    available: "Available",
    offered: "Offered — not a booking",
    selected: "Selected — not confirmed",
    confirmed: "Confirmed",
    completed: "Completed",
    revenue_verified: "Revenue verified",
  }[state] || "Available";
}
