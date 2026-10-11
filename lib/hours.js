const DAY_NAME = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

function toMinutes(hour, minute, mer) {
  let h = Number(hour);
  const m = Number(minute) || 0;
  const ap = String(mer || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!ap && h === 24) h = 0;
  return h * 60 + m;
}

function parseClock(value) {
  const s = String(value || "").trim();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  const mins = toMinutes(m[1], m[2], m[3]);
  if (!Number.isFinite(mins) || mins < 0 || mins >= 24 * 60) return null;
  return mins;
}

function expandDays(from, to) {
  const a = DAY_NAME[from];
  const b = DAY_NAME[to];
  if (a === undefined || b === undefined) return [];
  const out = [];
  let i = a;
  for (let n = 0; n < 7; n++) {
    out.push(i);
    if (i === b) break;
    i = (i + 1) % 7;
  }
  return out;
}

export function parseHoursString(hours) {
  const text = String(hours || "").trim().toLowerCase();
  if (!text) return null;
  if (/\b24\/7\b|\b24 hours\b/.test(text)) {
    return { days: [0, 1, 2, 3, 4, 5, 6], openMin: 0, closeMin: 24 * 60, source: "hours" };
  }

  let days = [];
  const range = text.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*[-–to]+\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*/);
  if (range) days = expandDays(range[1], range[2]);
  else {
    for (const [name, idx] of Object.entries(DAY_NAME)) {
      if (name.length < 3) continue;
      if (new RegExp(`\\b${name}\\b`).test(text) && !days.includes(idx)) days.push(idx);
    }
  }

  const clocks = [...text.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi)];
  let openMin = null;
  let closeMin = null;
  if (clocks.length >= 2) {
    openMin = toMinutes(clocks[0][1], clocks[0][2], clocks[0][3]);
    closeMin = toMinutes(clocks[1][1], clocks[1][2], clocks[1][3]);
  } else {
    const hm = text.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
    if (hm) {
      openMin = parseClock(hm[1]);
      closeMin = parseClock(hm[2]);
    }
  }
  if (openMin == null || closeMin == null) return days.length ? { days, openMin: null, closeMin: null, source: "hours" } : null;
  return { days: days.length ? days : [1, 2, 3, 4, 5, 6], openMin, closeMin, source: "hours" };
}

export function hoursWindow(business = {}) {
  const parsed = parseHoursString(business.hours);
  const calendar = business.calendar || {};
  const days = parsed?.days?.length
    ? parsed.days
    : (Array.isArray(calendar.days) && calendar.days.length ? calendar.days : [1, 2, 3, 4, 5, 6]);
  const openMin = parsed?.openMin != null ? parsed.openMin : parseClock(calendar.open || "08:00");
  const closeMin = parsed?.closeMin != null ? parsed.closeMin : parseClock(calendar.close || "18:00");
  return {
    days,
    openMin: openMin ?? 8 * 60,
    closeMin: closeMin ?? 18 * 60,
    source: parsed ? "hours" : (calendar.open || calendar.close || calendar.days ? "calendar" : "default"),
    configured: Boolean(business.hours) || Boolean(calendar.open || calendar.close),
  };
}

export function localParts(at, timeZone) {
  const when = at instanceof Date ? at : new Date(at);
  if (!timeZone) {
    return { day: when.getDay(), hours: when.getHours(), minutes: when.getMinutes() };
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(when);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = wd[get("weekday")];
    return {
      day: day === undefined ? when.getDay() : day,
      hours: Number(get("hour")),
      minutes: Number(get("minute")),
    };
  } catch {
    return { day: when.getDay(), hours: when.getHours(), minutes: when.getMinutes() };
  }
}

export function hoursStatus(business = {}, at = new Date()) {
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) {
    return { open: null, afterHours: false, reason: "invalid_time", label: "Hours unknown" };
  }
  const win = hoursWindow(business);
  const local = localParts(when, business.timeZone);
  const day = local.day;
  const mins = local.hours * 60 + local.minutes;
  const dayOpen = win.days.includes(day);
  let open = false;
  if (dayOpen) {
    if (win.closeMin > win.openMin) open = mins >= win.openMin && mins < win.closeMin;
    else open = mins >= win.openMin || mins < win.closeMin;
  }
  return {
    open,
    afterHours: !open,
    day,
    minutes: mins,
    source: win.source,
    configured: win.configured,
    label: open ? "Open" : (dayOpen ? "After hours" : "Closed today"),
  };
}

export function isAfterHours(business = {}, at = new Date()) {
  return hoursStatus(business, at).afterHours === true;
}

export function isOpenNow(business = {}, at = new Date()) {
  return hoursStatus(business, at).open === true;
}

export const DEFAULT_QUIET_HOURS = { startMin: 21 * 60, endMin: 8 * 60 };

export function quietHoursWindow(business = {}) {
  const q = business.quietHours && typeof business.quietHours === "object" ? business.quietHours : {};
  const start = Number.isFinite(Number(q.startMin)) ? Number(q.startMin) : DEFAULT_QUIET_HOURS.startMin;
  const end = Number.isFinite(Number(q.endMin)) ? Number(q.endMin) : DEFAULT_QUIET_HOURS.endMin;
  const enabled = q.enabled !== false;
  return { enabled, startMin: start, endMin: end };
}

export function minutesToClock(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n)) return "";
  const wrapped = ((Math.round(n) % (24 * 60)) + (24 * 60)) % (24 * 60);
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function clockToMinutes(value) {
  return parseClock(value);
}

export function isQuietHours(business = {}, at = new Date()) {
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) return false;
  const win = quietHoursWindow(business);
  if (!win.enabled) return false;
  const local = localParts(when, business.timeZone);
  const mins = local.hours * 60 + local.minutes;
  if (win.startMin === win.endMin) return false;
  if (win.endMin > win.startMin) return mins >= win.startMin && mins < win.endMin;
  return mins >= win.startMin || mins < win.endMin;
}

export function nextQuietHoursEnd(business = {}, at = new Date()) {
  const when = at instanceof Date ? at : new Date(at);
  const win = quietHoursWindow(business);
  const local = localParts(when, business.timeZone);
  const mins = local.hours * 60 + local.minutes;
  let deltaMin;
  if (win.endMin > win.startMin) {
    deltaMin = mins < win.endMin ? win.endMin - mins : (24 * 60 - mins) + win.endMin;
  } else if (mins < win.endMin) {
    deltaMin = win.endMin - mins;
  } else {
    deltaMin = (24 * 60 - mins) + win.endMin;
  }
  return new Date(when.getTime() + Math.max(1, deltaMin) * 60 * 1000);
}
