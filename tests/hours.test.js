import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHoursString, hoursWindow, hoursStatus, isAfterHours, isOpenNow, isQuietHours, nextQuietHoursEnd, localParts, minutesToClock } from "../lib/hours.js";

// 2026-09-21 is a Monday.
const MON_10AM = new Date("2026-09-21T10:00:00");
const MON_11PM = new Date("2026-09-21T23:00:00");
const SUN_10AM = new Date("2026-09-20T10:00:00");

test("parses a weekday range with hours", () => {
  const p = parseHoursString("Mon-Sat, 7am-7pm");
  assert.deepEqual(p.days, [1, 2, 3, 4, 5, 6]);
  assert.equal(p.openMin, 7 * 60);
  assert.equal(p.closeMin, 19 * 60);
});

test("parses 24/7 as every day all day", () => {
  const p = parseHoursString("24/7");
  assert.equal(p.days.length, 7);
  assert.equal(p.openMin, 0);
  assert.equal(p.closeMin, 24 * 60);
});

test("marks an after-hours call on a weekday night", () => {
  const biz = { hours: "Mon-Sat, 7am-7pm" };
  assert.equal(isOpenNow(biz, MON_10AM), true);
  assert.equal(isAfterHours(biz, MON_11PM), true);
  assert.equal(hoursStatus(biz, MON_11PM).label, "After hours");
});

test("marks a closed day as closed, not open", () => {
  const biz = { hours: "Mon-Sat, 7am-7pm" };
  assert.equal(isOpenNow(biz, SUN_10AM), false);
  assert.equal(hoursStatus(biz, SUN_10AM).label, "Closed today");
});

test("falls back to the calendar when hours are missing", () => {
  const biz = { calendar: { days: [1, 2, 3, 4, 5], open: "09:00", close: "17:00" } };
  const win = hoursWindow(biz);
  assert.deepEqual(win.days, [1, 2, 3, 4, 5]);
  assert.equal(win.source, "calendar");
  assert.equal(isOpenNow(biz, MON_10AM), true);
});

test("hands over at the close minute, not after", () => {
  const biz = { hours: "Mon-Fri, 8am-5pm" };
  assert.equal(isOpenNow(biz, new Date("2026-09-21T16:59:00")), true);
  assert.equal(isOpenNow(biz, new Date("2026-09-21T17:00:00")), false);
});

test("quiet hours wrap overnight 21:00-08:00 by default", () => {
  const biz = {};
  assert.equal(isQuietHours(biz, new Date("2026-09-21T21:00:00")), true);
  assert.equal(isQuietHours(biz, new Date("2026-09-21T23:30:00")), true);
  assert.equal(isQuietHours(biz, new Date("2026-09-22T07:59:00")), true);
  assert.equal(isQuietHours(biz, new Date("2026-09-21T08:00:00")), false);
  assert.equal(isQuietHours(biz, new Date("2026-09-21T20:59:00")), false);
  const end = nextQuietHoursEnd(biz, new Date("2026-09-21T22:00:00"));
  assert.equal(end.getHours(), 8);
  assert.equal(end.getDate(), 22);
});

test("quiet hours can be disabled on the business", () => {
  const biz = { quietHours: { enabled: false } };
  assert.equal(isQuietHours(biz, new Date("2026-09-21T23:00:00")), false);
});

test("quiet hours use business timeZone when set", () => {
  const late = new Date("2026-09-21T04:00:00.000Z");
  const noon = new Date("2026-09-21T16:00:00.000Z");
  const parts = localParts(late, "America/Chicago");
  assert.equal(parts.hours, 23);
  assert.equal(minutesToClock(21 * 60), "21:00");
  const biz = { timeZone: "America/Chicago" };
  assert.equal(isQuietHours(biz, late), true);
  assert.equal(isQuietHours(biz, noon), false);
});
