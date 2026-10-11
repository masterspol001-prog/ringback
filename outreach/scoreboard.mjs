#!/usr/bin/env node
// Outreach scoreboard. Reads prospects.csv and reports whether the experiment
// is working, against the kill criteria in RESEARCH.md.
//
//   node outreach/scoreboard.mjs
//   node outreach/scoreboard.mjs --csv path/to/prospects.csv

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const csvFlag = args.indexOf("--csv");
const csvPath = csvFlag !== -1 ? args[csvFlag + 1] : join(__dirname, "prospects.csv");

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

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
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
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
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

if (!existsSync(csvPath)) {
  console.error(`No file at ${csvPath}`);
  process.exit(1);
}

const rows = parseCsv(readFileSync(csvPath, "utf8"));
if (rows.length === 0) {
  printEmpty();
  process.exit(0);
}

const header = rows[0].map((h) => h.trim());
const records = rows.slice(1).map((r) => {
  const rec = {};
  header.forEach((h, i) => (rec[h] = (r[i] ?? "").trim()));
  return rec;
});

const STATUSES = ["new", "contacted", "replied", "interested", "call_booked", "paid", "lost", "skip"];
const CONTACTED = new Set(["contacted", "replied", "interested", "call_booked", "paid", "lost"]);

const counts = {};
for (const s of STATUSES) counts[s] = 0;
let unknown = 0;
let contacted = 0;
let replied = 0;
let interested = 0;
let calls = 0;
let paid = 0;

for (const r of records) {
  const s = (r.status || "new").toLowerCase();
  if (counts[s] === undefined) {
    unknown++;
    continue;
  }
  counts[s]++;
  if (CONTACTED.has(s)) contacted++;
  if (["replied", "interested", "call_booked", "paid"].includes(s)) replied++;
  if (["interested", "call_booked", "paid"].includes(s)) interested++;
  if (["call_booked", "paid"].includes(s)) calls++;
  if (s === "paid") paid++;
}

const total = records.length;
const replyRate = contacted ? (replied / contacted) * 100 : 0;
const interestRate = contacted ? (interested / contacted) * 100 : 0;
const callRate = contacted ? (calls / contacted) * 100 : 0;
const paidRate = contacted ? (paid / contacted) * 100 : 0;

function pct(n) {
  return `${n.toFixed(1)}%`;
}

function line(label, value, color = "") {
  const pad = label.padEnd(26);
  console.log(`  ${pad}${color}${value}${C.reset}`);
}

console.log("");
console.log(`${C.bold}RingBack outreach scoreboard${C.reset} ${C.dim}(${csvPath})${C.reset}`);
console.log(`${C.dim}${"-".repeat(52)}${C.reset}`);
console.log(`${C.bold}List${C.reset}`);
line("prospects in file", total);
line("contacted", contacted, C.cyan);
line("not yet contacted", counts.new, C.dim);
line("skipped", counts.skip, C.dim);
if (unknown) line("unrecognized status", unknown, C.yellow);

console.log("");
console.log(`${C.bold}Funnel${C.reset}`);
line("replies", `${replied}  ${C.dim}(${pct(replyRate)} of contacted)${C.reset}`, C.green);
line("interested", `${interested}  ${C.dim}(${pct(interestRate)})${C.reset}`, C.green);
line("calls booked", `${calls}  ${C.dim}(${pct(callRate)})${C.reset}`, C.green);
line("paid customers", `${paid}  ${C.dim}(${pct(paidRate)})${C.reset}`, C.green);

console.log("");
console.log(`${C.bold}Status breakdown${C.reset}`);
for (const s of ["new", "contacted", "replied", "interested", "call_booked", "paid", "lost", "skip"]) {
  if (counts[s] === 0) continue;
  const bar = "#".repeat(Math.min(40, counts[s]));
  console.log(`  ${s.padEnd(14)} ${String(counts[s]).padStart(4)}  ${C.cyan}${bar}${C.reset}`);
}

console.log("");
console.log(`${C.bold}Verdict${C.reset}`);

if (contacted === 0) {
  console.log(`  ${C.yellow}Nothing sent yet.${C.reset} The scoreboard is empty until you contact people.`);
  console.log(`  ${C.dim}Target: 25 personalized contacts per day.${C.reset}`);
} else if (contacted < 50) {
  console.log(`  ${C.yellow}Early. Only ${contacted} contacted.${C.reset} Get to 50 before judging the message.`);
  console.log(`  ${C.dim}Current reply rate ${pct(replyRate)} - treat as noise under 50 contacts.${C.reset}`);
} else if (replyRate < 5) {
  console.log(`  ${C.red}KILL SIGNAL: reply rate ${pct(replyRate)} is under 5% after ${contacted} contacts.${C.reset}`);
  console.log(`  ${C.dim}The message is wrong, not necessarily the market. Rewrite the hook, run 50 more.${C.reset}`);
} else if (paid === 0 && interestRate < 3) {
  console.log(`  ${C.yellow}Replies but thin interest (${pct(interestRate)}).${C.reset} Sharpen the offer or cut the price for a paid pilot.`);
} else if (paid === 0) {
  console.log(`  ${C.green}Working.${C.reset} ${pct(interestRate)} interested after ${contacted} contacts. Convert a paid pilot.`);
} else {
  console.log(`  ${C.green}${paid} paying customer${paid === 1 ? "" : "s"}.${C.reset} Double down on the channel that produced them.`);
}

const channels = {};
for (const r of records) {
  const c = (r.channel || "").trim() || "unspecified";
  channels[c] = channels[c] || { contacted: 0, replied: 0, paid: 0 };
  const s = (r.status || "new").toLowerCase();
  if (CONTACTED.has(s)) channels[c].contacted++;
  if (["replied", "interested", "call_booked", "paid"].includes(s)) channels[c].replied++;
  if (s === "paid") channels[c].paid++;
}
const channelKeys = Object.keys(channels);
if (channelKeys.length > 1 || (channelKeys.length === 1 && channelKeys[0] !== "unspecified")) {
  console.log("");
  console.log(`${C.bold}By channel${C.reset}`);
  for (const [c, v] of Object.entries(channels).sort((a, b) => b[1].paid - a[1].paid)) {
    const rr = v.contacted ? pct((v.replied / v.contacted) * 100) : "-";
    console.log(`  ${c.padEnd(16)} contacted ${String(v.contacted).padStart(3)}  replied ${String(v.replied).padStart(3)} (${rr})  paid ${v.paid}`);
  }
}

function printEmpty() {
  console.log("");
  console.log(`${C.bold}RingBack outreach scoreboard${C.reset}`);
  console.log(`  ${C.dim}prospects.csv has a header but no rows yet.${C.reset}`);
  console.log(`  ${C.dim}Fill it in, then re-run this command.${C.reset}`);
}

console.log("");
console.log(`${C.dim}Kill rule: 50+ contacted with under 5% reply -> rewrite the message, not the product.${C.reset}`);
console.log("");
