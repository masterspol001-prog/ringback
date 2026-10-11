// Deterministic information extraction.
//
// This runs on every inbound message, with or without an LLM. It is the reason
// the product still works when no AI key is configured, and it is what the LLM
// path is validated against.

const OPT_OUT_RE = /(^|\b)(stop|unsubscribe|opt[\s-]?out|remove me|take me off|do not (text|contact|message|call)|don'?t (text|contact|message|call)|not interested|leave me alone|never contact)(\b|$)/i;

const HUMAN_RE = /(speak|talk|chat)\s+(to|with)\s+(a\s+)?(human|person|someone|agent|manager|owner|representative|rep|real person)|real person|call me (back|please)|have someone call|human please/i;

const CALLBACK_RE = /(call|phone|ring)\s+me\b|give me a (call|ring)|callback|call back/i;

const ANGRY_RE = /(angry|furious|ridiculous|terrible|awful|unacceptable|disgusting|useless|incompetent|scam|fraud|worst|complaint|complain|sue|lawsuit|attorney|lawyer)/i;

const UNUSUAL_RE = /(refund|charge ?back|legal action|insurance claim|warranty claim|small claims|better business bureau|bbb|attorney general)/i;

const CONFIRM_RE = /^(yes|yep|yeah|yup|sure|ok|okay|k|confirm|confirmed|approved|book it|do it|go ahead|please do|sounds good|that works|works for me|perfect|great|👍)\b/i;

const NEGATIVE_RE = /^(no|nope|nah|not now|later|no thanks|no thank you|not yet|maybe later)\b/i;

const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
const EMAIL_RE = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;
const MONEY_RE = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/;
const ADDRESS_RE = /(\d{1,6}\s+[a-z0-9][a-z0-9.'-]*(?:\s+[a-z0-9.'-]+){0,4}\s+(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl|circle|cir|terrace|ter|highway|hwy)\b\.?)/i;
const CITY_IN_RE = /\b(?:i(?:['’]?m)?\s+in|in|around|near|from)\s+([a-z][a-z'-]{1,20}(?:\s+[a-z][a-z'-]{1,20}){0,2})(?=[\s.,!?;:]|$)/i;
const STOP_AFTER_CITY = /^(can|could|would|will|and|but|or|so|then|please|somebody|someone|anyone|come|send|need|tonight|today|tomorrow|asap|right|now|this|the|a|an|my|our|we|i|if|when|where|how|what)$/i;
const FRAGMENT_RE = /\b(can|could|would|somebody|someone|anyone|come|please)\b|[?.!]/i;
const US_STATES = {
  al: "AL", alabama: "AL", ak: "AK", alaska: "AK", az: "AZ", arizona: "AZ", ar: "AR", arkansas: "AR",
  ca: "CA", california: "CA", co: "CO", colorado: "CO", ct: "CT", connecticut: "CT", de: "DE", delaware: "DE",
  fl: "FL", florida: "FL", ga: "GA", georgia: "GA", hi: "HI", hawaii: "HI", id: "ID", idaho: "ID",
  il: "IL", illinois: "IL", in: "IN", indiana: "IN", ia: "IA", iowa: "IA", ks: "KS", kansas: "KS",
  ky: "KY", kentucky: "KY", la: "LA", louisiana: "LA", me: "ME", maine: "ME", md: "MD", maryland: "MD",
  ma: "MA", massachusetts: "MA", mi: "MI", michigan: "MI", mn: "MN", minnesota: "MN", ms: "MS", mississippi: "MS",
  mo: "MO", missouri: "MO", mt: "MT", montana: "MT", ne: "NE", nebraska: "NE", nv: "NV", nevada: "NV",
  nh: "NH", "new hampshire": "NH", nj: "NJ", "new jersey": "NJ", nm: "NM", "new mexico": "NM",
  ny: "NY", "new york": "NY", nc: "NC", "north carolina": "NC", nd: "ND", "north dakota": "ND",
  oh: "OH", ohio: "OH", ok: "OK", oklahoma: "OK", or: "OR", oregon: "OR", pa: "PA", pennsylvania: "PA",
  ri: "RI", "rhode island": "RI", sc: "SC", "south carolina": "SC", sd: "SD", "south dakota": "SD",
  tn: "TN", tennessee: "TN", tx: "TX", texas: "TX", ut: "UT", utah: "UT", vt: "VT", vermont: "VT",
  va: "VA", virginia: "VA", wa: "WA", washington: "WA", wv: "WV", "west virginia": "WV",
  wi: "WI", wisconsin: "WI", wy: "WY", wyoming: "WY",
};

function titleCasePlace(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function isFragment(value) {
  const s = String(value || "").trim();
  if (!s) return true;
  if (s.length > 48) return true;
  if (FRAGMENT_RE.test(s)) return true;
  if (s.split(/\s+/).length > 5) return true;
  return false;
}

function cleanPlace(raw, business = {}) {
  let value = String(raw || "").split(/[.?!,;:]/)[0].replace(/[.,!?;:]+$/g, "").trim();
  if (!value) return "";
  const words = value.split(/\s+/).filter(Boolean);
  while (words.length && STOP_AFTER_CITY.test(words[words.length - 1])) words.pop();
  if (!words.length) return "";
  value = words.join(" ");
  if (TIMING_RE.test(value) || /^\d/.test(value) || value.length > 48) return "";
  if (isFragment(value)) return "";
  const known = String(business.serviceArea || "").trim();
  if (known) {
    const lower = value.toLowerCase();
    const knownLower = known.toLowerCase();
    if (knownLower.includes(lower) || lower.includes(knownLower.split(",")[0].trim())) return known;
  }
  const last = words[words.length - 1].toLowerCase();
  if (US_STATES[last] && words.length >= 2) {
    return `${titleCasePlace(words.slice(0, -1).join(" "))}, ${US_STATES[last]}`;
  }
  return titleCasePlace(value);
}

const TIMING_RE = /\b(today|tonight|tomorrow|asap|right now|immediately|this morning|this afternoon|this evening|this week|next week|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|\d{1,2}(?::\d{2})?\s?(?:am|pm))\b/i;

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function firstMatch(re, text) {
  const m = String(text || "").match(re);
  return m ? m[0].trim() : "";
}

function cleanName(raw) {
  const value = String(raw || "").trim().replace(/[.,!]$/, "");
  if (!value) return "";
  if (value.length > 60) return "";
  if (/\d/.test(value)) return "";
  return value;
}

// Tries to pull a person's name out of natural openings like
// "Hi, this is Sarah" or "Sarah here, my AC is out".
const NOT_A_NAME = /^(in|at|on|from|near|around|the|a|an|my|our|not|no|here|there|looking|calling|trying|need|want|just)$/i;

function extractName(text) {
  const patterns = [
    /(?:my name is|this is|it'?s|name'?s)\s+([a-z][a-z'-]{1,20})\b/i,
    /(?:i'?m)\s+([a-z][a-z'-]{1,20})\b(?!\s+(in|at|on|from|near|around)\b)/i,
    /^([a-z][a-z'-]{1,20})\s+(?:here|speaking)\b/i,
    /^hi,?\s+([a-z][a-z'-]{1,20})\s*[.,!]/i,
  ];
  for (const re of patterns) {
    const m = String(text || "").match(re);
    if (m) {
      const candidate = cleanName(m[1]);
      if (candidate && !NOT_A_NAME.test(candidate)) return candidate[0].toUpperCase() + candidate.slice(1);
    }
  }
  return "";
}

const SERVICE_ALIASES = [
  { words: ["air conditioner", "air conditioning", "no ac", "a/c", " ac "], service: "AC repair" },
  { words: ["no heat", "furnace", "heater"], service: "Furnace repair" },
  { words: ["burst", "flood", "leaking", "leak"], service: "Leak repair" },
  { words: ["drain", "clog"], service: "Drain cleaning" },
  { words: ["sparking", "burning smell", "no power"], service: "Outlet or switch repair" },
  { words: ["tooth pain", "toothache", "broken tooth", "swelling"], service: "Emergency visit" },
  { words: ["new patient"], service: "New patient exam" },
  { words: ["cleaning", "hygiene", "checkup"], service: "Cleaning" },
  { words: ["sick visit", "not feeling well"], service: "Sick visit" },
  { words: ["consult", "consultation"], service: "Consult" },
];

function matchService(text, business) {
  const t = ` ${String(text || "").toLowerCase()} `;
  const services = Array.isArray(business?.services) ? business.services : [];
  const names = services.map((s) => (typeof s === "string" ? s : s?.name)).filter(Boolean);
  for (const name of names) {
    const needle = String(name).toLowerCase();
    if (t.includes(needle)) return String(name);
    const words = needle.split(/\s+/).filter((w) => w.length >= 4);
    if (words.length && words.some((w) => t.includes(w))) return String(name);
  }
  for (const alias of SERVICE_ALIASES) {
    if (names.length && !names.includes(alias.service)) continue;
    if (alias.words.some((w) => t.includes(w))) return alias.service;
  }
  if (/\bac\b|air cond/.test(t) && /repair|fix|not working|isn't working|stopped|out|down/.test(t)) return names.find((n) => /ac/i.test(n)) || "AC repair";
  return "";
}

export function extractInfo(text, business = {}) {
  const raw = String(text || "");
  const t = raw.trim();

  const phone = (firstMatch(PHONE_RE, t).match(/\d/g) || []).length >= 7 ? firstMatch(PHONE_RE, t) : "";
  const email = firstMatch(EMAIL_RE, t);
  const address = firstMatch(ADDRESS_RE, t);
  const moneyMatch = t.match(MONEY_RE);

  let area = "";
  if (address) {
    area = address;
  } else {
    const cityMatch = t.match(CITY_IN_RE);
    if (cityMatch) area = cleanPlace(cityMatch[1], business);
  }
  if (area && isFragment(area)) area = "";

  const timingMatch = t.match(TIMING_RE);
  const timing = timingMatch ? timingMatch[1] : "";

  return {
    raw: t,
    name: extractName(t),
    phone,
    email,
    address,
    area,
    service: matchService(t, business),
    timing,
    weekday: timingMatch && WEEKDAYS[timingMatch[1].toLowerCase()] !== undefined ? WEEKDAYS[timingMatch[1].toLowerCase()] : null,
    budget: moneyMatch ? Number(moneyMatch[1].replace(/,/g, "")) : null,
    doNotContact: OPT_OUT_RE.test(t) || /^(stop|unsubscribe|cancel)$/i.test(String(text || "").trim()),
    wantsHelp: /^(help)$/i.test(String(text || "").trim()),
    wantsHuman: HUMAN_RE.test(t),
    wantsCallback: !HUMAN_RE.test(t) && CALLBACK_RE.test(t),
    angry: ANGRY_RE.test(t),
    unusual: UNUSUAL_RE.test(t),
    isConfirmation: CONFIRM_RE.test(t),
    isNegative: NEGATIVE_RE.test(t),
    hasDetails: Boolean(address || area) && Boolean(timing),
  };
}

export { cleanPlace };

export function isOptOut(text) {
  return OPT_OUT_RE.test(String(text || "")) || /^(stop|unsubscribe|cancel)$/i.test(String(text || "").trim());
}

export function isHelp(text) {
  return /^(help)$/i.test(String(text || "").trim());
}

export { WEEKDAYS };
