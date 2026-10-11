// Realistic demo data. No lorem ipsum. Used by /api/demo/seed and by the
// interactive demo so a fresh install looks like a working receptionist.

import { ingest } from "./conversation.js";
import { updateLead, saveBusiness, nextId } from "./store.js";
import { addNote, addRevenueEntry, recordEvent } from "./domain.js";
import { normalizeBusiness } from "./business.js";

export const DEMO_BUSINESSES = {
  hvac: {
    id: "demo-hvac",
    name: "ABC HVAC",
    trade: "hvac",
    serviceArea: "Austin, TX",
    bookingUrl: "https://cal.com/abc-hvac/service",
    phone: "+1 (512) 555-0142",
    hours: "Mon-Sat, 7am-7pm",
    offer: "free estimate on replacements",
    emergency: { available: true, policy: "After-hours emergencies get a same-night dispatch when a tech is available." },
    services: [
      { name: "AC repair", startingPrice: 189 },
      { name: "Furnace repair", startingPrice: 219 },
      { name: "AC installation", startingPrice: 4500 },
      { name: "Maintenance tune-up", startingPrice: 129 },
    ],
    notifications: { email: "owner@abc-hvac.example", phone: "+1 (512) 555-0100" },
    faqs: [
      { q: "Do you offer financing?", a: "Yes, we can look at payment options on replacements and larger jobs." },
      { q: "Are you licensed?", a: "Yes, ABC HVAC is licensed and our work is guaranteed." },
      { q: "Do you charge a diagnostic fee?", a: "Diagnostic visits start at $89, waived if you proceed with the repair." },
    ],
  },
  plumbing: {
    id: "demo-plumbing",
    name: "Rivera Plumbing Co.",
    trade: "plumbing",
    serviceArea: "Denver, CO",
    bookingUrl: "https://cal.com/rivera/visit",
    phone: "+1 (303) 555-0177",
    hours: "Mon-Sat, 7am-8pm",
    offer: "free camera inspection with any drain job",
    emergency: { available: true, policy: "Burst pipes and sewage backups are dispatched immediately." },
    services: [
      { name: "Drain cleaning", startingPrice: 149 },
      { name: "Water heater repair", startingPrice: 249 },
      { name: "Leak repair", startingPrice: 189 },
    ],
  },
  cleaning: {
    id: "demo-cleaning",
    name: "BrightNest Cleaning",
    trade: "cleaning",
    serviceArea: "Phoenix, AZ",
    bookingUrl: "https://cal.com/brightnest/booking",
    phone: "+1 (602) 555-0143",
    hours: "Mon-Sat, 8am-6pm",
    offer: "10% off first deep clean",
    emergency: { available: false },
    services: [
      { name: "Deep clean", startingPrice: 189 },
      { name: "Recurring clean", startingPrice: 129 },
      { name: "Move-out clean", startingPrice: 249 },
    ],
  },
  electrical: {
    id: "demo-electrical",
    name: "Volt & Co. Electric",
    trade: "electrical",
    serviceArea: "Nashville, TN",
    bookingUrl: "https://cal.com/volt/visit",
    phone: "+1 (615) 555-0190",
    hours: "Mon-Fri, 8am-6pm",
    offer: "free panel inspection with any install",
    emergency: { available: true, policy: "Sparking, burning smell, or no power to the house is treated as emergency." },
    services: [
      { name: "Panel upgrade", startingPrice: 1800 },
      { name: "Outlet or switch repair", startingPrice: 129 },
      { name: "Lighting install", startingPrice: 189 },
    ],
  },
  dental: {
    id: "demo-dental",
    name: "Oak Park Dental",
    trade: "dental",
    serviceArea: "Chicago, IL",
    bookingUrl: "https://cal.com/oakpark/appointment",
    phone: "+1 (312) 555-0165",
    hours: "Mon-Fri, 8am-5pm",
    offer: "new-patient exam and x-rays",
    emergency: { available: true, policy: "Tooth pain, swelling, or a broken tooth is flagged so the dentist can call back." },
    services: [
      { name: "New patient exam", startingPrice: 99 },
      { name: "Cleaning", startingPrice: 129 },
      { name: "Emergency visit", startingPrice: 159 },
    ],
    faqs: [
      { q: "Do you take new patients?", a: "Yes, new patients are welcome. We can book an exam once we know the visit type." },
      { q: "Do you accept insurance?", a: "Bring your insurance card to the visit and the front desk will check benefits. We do not quote coverage over text." },
    ],
  },
  medical: {
    id: "demo-medical",
    name: "Riverside Family Clinic",
    trade: "medical",
    serviceArea: "Columbus, OH",
    bookingUrl: "https://cal.com/riverside/visit",
    phone: "+1 (614) 555-0133",
    hours: "Mon-Fri, 8am-6pm",
    offer: "same-week new-patient visits",
    emergency: { available: false, policy: "For chest pain or trouble breathing, call emergency services. The clinic books sick visits during office hours." },
    services: [
      { name: "New patient visit", startingPrice: 149 },
      { name: "Sick visit", startingPrice: 99 },
      { name: "Annual physical", startingPrice: 189 },
    ],
  },
  medspa: {
    id: "demo-medspa",
    name: "Lumen Med Spa",
    trade: "medspa",
    serviceArea: "Scottsdale, AZ",
    bookingUrl: "https://cal.com/lumen/consult",
    phone: "+1 (480) 555-0172",
    hours: "Tue-Sat, 10am-6pm",
    offer: "complimentary consult on first visit",
    emergency: { available: false },
    services: [
      { name: "Consult", startingPrice: 0 },
      { name: "Facial", startingPrice: 149 },
      { name: "Laser", startingPrice: 249 },
    ],
  },
};

export function seedBusinesses() {
  const out = [];
  for (const raw of Object.values(DEMO_BUSINESSES)) {
    out.push(saveBusiness(normalizeBusiness(raw)));
  }
  return out;
}

export async function seedDemoLeads() {
  seedBusinesses();
  const results = [];

  // Emergency plumbing - recovered.
  const plumbing = await ingest({
    businessId: "demo-plumbing",
    channel: "missed_call",
    source: "missed_call",
    name: "Maria Chen",
    phone: "+13035550112",
    message: "Pipe burst in the basement, water everywhere, need someone now",
    ai: false,
  });
  await ingest({
    leadId: plumbing.lead.id,
    businessId: "demo-plumbing",
    channel: "sms",
    message: "It's at 441 Blake Street in Denver. Tonight if you can.",
    ai: false,
  });
  updateLead(plumbing.lead.id, { status: "won", confirmedRevenue: 680, revenueStatus: "won", jobValue: 680, demo: true });
  addRevenueEntry({ businessId: "demo-plumbing", leadId: plumbing.lead.id, amount: 680, status: "won", source: "seed", note: "Burst pipe, after-hours." });
  addNote({ businessId: "demo-plumbing", leadId: plumbing.lead.id, author: "owner", text: "Dispatched Jake. Customer paid on site." });
  recordEvent({ businessId: "demo-plumbing", leadId: plumbing.lead.id, type: "revenue", actor: "owner", summary: "Recorded $680 recovered." });
  results.push(plumbing.lead.id);

  // HVAC request - in progress (the Sarah scenario).
  const hvac = await ingest({
    businessId: "demo-hvac",
    channel: "missed_call",
    source: "missed_call",
    name: "Sarah Patel",
    phone: "+15125558821",
    message: "My AC stopped working and I need someone today.",
    ai: false,
  });
  results.push(hvac.lead.id);

  // Cleaning quote - engaged.
  const cleaning = await ingest({
    businessId: "demo-cleaning",
    channel: "web_form",
    source: "web_form",
    name: "James Ortiz",
    phone: "+16025550144",
    message: "How much for a deep clean of a 3-bed house in Tempe?",
    ai: false,
  });
  results.push(cleaning.lead.id);

  // Dental clinic - appointment request.
  const dental = await ingest({
    businessId: "demo-dental",
    channel: "missed_call",
    source: "missed_call",
    name: "Priya Shah",
    phone: "+13125550166",
    message: "I need a new patient exam this week. Do you take insurance?",
    ai: false,
  });
  results.push(dental.lead.id);

  // Electrician request - escalated.
  const elec = await ingest({
    businessId: "demo-electrical",
    channel: "sms",
    source: "sms",
    name: "Dana Ruiz",
    phone: "+16155550191",
    message: "The outlets are sparking and I smell burning. Can a human call me right now?",
    ai: false,
  });
  results.push(elec.lead.id);

  // Lost customer - opted out after a quote.
  const lost = await ingest({
    businessId: "demo-hvac",
    channel: "facebook",
    source: "facebook",
    name: "Chris Nolan",
    phone: "+15125550177",
    message: "Need a quote for a new AC",
    ai: false,
  });
  await ingest({
    leadId: lost.lead.id,
    businessId: "demo-hvac",
    channel: "facebook",
    message: "stop",
    ai: false,
  });
  results.push(lost.lead.id);

  for (const id of results) updateLead(id, { demo: true });
  return { ok: true, leads: results, demo: true, note: "Demo recoveries are labeled demo. They do not count as verified dollars." };
}

export function demoId() {
  return nextId("demo");
}
