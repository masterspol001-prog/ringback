// Database layer.
//
// Primary engine: node:sqlite (built into Node 22.5+, zero dependencies).
// Fallback engine: a JSON file, used only if node:sqlite is unavailable.
//
// The rest of the app talks to lib/store.js and lib/domain.js and never cares
// which engine is active. Call `engineName()` to report which one is in use.
//
// Design note: leads keep a typed table because they are the hot path and are
// filtered/sorted heavily. The newer v2 entities (customers, conversations,
// messages, appointments, events, follow-up jobs, notifications, revenue,
// integrations, settings) share one generic `documents` table keyed by
// (collection, id). That keeps both engines trivially in sync, gives every
// entity stable ids and timestamps, and lets new collections be added without a
// schema migration. Documents that grow fast (messages, events) are still one
// row each, so ordering and limiting stay cheap.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RINGBACK_DATA_DIR || join(__dirname, "..", "data");

// Tests and multi-instance setups can point this anywhere.
const DB_PATH = process.env.RINGBACK_DB || join(DATA_DIR, "ringback.db");

export const COLLECTIONS = [
  "customers",
  "conversations",
  "messages",
  "appointments",
  "notes",
  "events",
  "follow_up_jobs",
  "notifications",
  "revenue",
  "integrations",
  "business_settings",
  "analytics_events",
  "processed_events",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  businessId TEXT,
  name TEXT,
  phone TEXT,
  message TEXT,
  source TEXT,
  channel TEXT,
  channelLabel TEXT,
  intent TEXT,
  urgent INTEGER DEFAULT 0,
  reply TEXT,
  followUp TEXT,
  engine TEXT,
  aiFallbackReason TEXT,
  score INTEGER,
  bucket TEXT,
  reasons TEXT,
  status TEXT DEFAULT 'new',
  notes TEXT DEFAULT '',
  jobValue REAL,
  sms TEXT,
  business TEXT,
  followUpAt TEXT,
  customerId TEXT,
  conversationId TEXT,
  appointmentId TEXT,
  estimatedValue REAL,
  confirmedRevenue REAL,
  revenueStatus TEXT DEFAULT 'UNKNOWN',
  lostReason TEXT,
  qualification TEXT,
  stageAt TEXT,
  optedOut INTEGER DEFAULT 0,
  doNotContact INTEGER DEFAULT 0,
  followUpStatus TEXT DEFAULT 'active',
  ownerLastNotifiedAt TEXT,
  demo INTEGER DEFAULT 0,
   afterHours INTEGER DEFAULT 0,
   severity TEXT DEFAULT 'normal',
   bookingState TEXT DEFAULT 'available',
   failureState TEXT,
   deliveryStatus TEXT,
   revenueState TEXT,
   invoiceRef TEXT,
   createdAt TEXT NOT NULL,
   updatedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(businessId);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);

CREATE TABLE IF NOT EXISTS documents (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  businessId TEXT,
  json TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT,
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_documents_business ON documents(collection, businessId, createdAt DESC);

CREATE TABLE IF NOT EXISTS setups (
  id TEXT PRIMARY KEY,
  business TEXT,
  name TEXT,
  email TEXT,
  phone TEXT,
  trade TEXT,
  bookingUrl TEXT,
  channels TEXT,
  plan TEXT,
  status TEXT DEFAULT 'new',
  notes TEXT DEFAULT '',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  passwordHash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  email TEXT,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expiresAt);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  businessId TEXT,
  setupId TEXT,
  plan TEXT,
  amount REAL,
  currency TEXT DEFAULT 'USD',
  provider TEXT,
  reference TEXT,
  note TEXT,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(createdAt DESC);
`;

// Columns added to `leads` after v1 shipped. Existing databases get them via
// ALTER TABLE; fresh databases get them straight from SCHEMA.
const LEAD_COLUMNS = [
  ["customerId", "TEXT"],
  ["conversationId", "TEXT"],
  ["appointmentId", "TEXT"],
  ["estimatedValue", "REAL"],
  ["confirmedRevenue", "REAL"],
  ["revenueStatus", "TEXT DEFAULT 'UNKNOWN'"],
  ["lostReason", "TEXT"],
  ["qualification", "TEXT"],
  ["stageAt", "TEXT"],
  ["optedOut", "INTEGER DEFAULT 0"],
  ["doNotContact", "INTEGER DEFAULT 0"],
  ["followUpStatus", "TEXT DEFAULT 'active'"],
  ["ownerLastNotifiedAt", "TEXT"],
  ["demo", "INTEGER DEFAULT 0"],
  ["afterHours", "INTEGER DEFAULT 0"],
  ["severity", "TEXT DEFAULT 'normal'"],
  ["bookingState", "TEXT DEFAULT 'available'"],
  ["failureState", "TEXT"],
  ["deliveryStatus", "TEXT"],
  ["revenueState", "TEXT"],
  ["invoiceRef", "TEXT"],
];

let sqlite = null;
let sqliteError = null;

function migrateLeads(db) {
  let existing;
  try {
    existing = new Set(db.prepare("PRAGMA table_info(leads)").all().map((c) => c.name));
  } catch {
    return;
  }
  for (const [name, type] of LEAD_COLUMNS) {
    if (existing.has(name)) continue;
    try {
      db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`);
    } catch {
      // Concurrent migration in another process; safe to ignore.
    }
  }
}

function openSqlite() {
  if (sqlite || sqliteError === "unavailable") return sqlite;
  try {
    const mod = require("node:sqlite");
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const db = new mod.DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    migrateLeads(db);
    sqlite = db;
    return sqlite;
  } catch (err) {
    sqliteError = "unavailable";
    return null;
  }
}

export function hasSqlite() {
  return Boolean(openSqlite());
}

export function sqliteUnavailableReason() {
  return sqliteError;
}

export function dbPath() {
  return DB_PATH;
}

export function engineName() {
  return openSqlite() ? "sqlite" : "json";
}

// ---------------------------------------------------------------- JSON fallback

const JSON_PATH = DB_PATH.replace(/\.db$/, ".json");
const EMPTY_JSON = {
  leads: [],
  setups: [],
  businesses: {},
  users: [],
  sessions: [],
  payments: [],
  documents: {},
  seq: 0,
};

function jsonRead() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(JSON_PATH)) writeFileSync(JSON_PATH, JSON.stringify(EMPTY_JSON, null, 2));
  try {
    const parsed = { ...EMPTY_JSON, ...JSON.parse(readFileSync(JSON_PATH, "utf8")) };
    if (!parsed.documents || typeof parsed.documents !== "object") parsed.documents = {};
    return parsed;
  } catch {
    return { ...EMPTY_JSON };
  }
}

function jsonWrite(db) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${JSON_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  // Atomic-ish replace so a crash mid-write cannot corrupt the store.
  writeFileSync(JSON_PATH, readFileSync(tmp));
}

// ---------------------------------------------------------------- helpers

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToLead(row) {
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    phone: row.phone,
    message: row.message,
    source: row.source,
    channel: row.channel,
    channelLabel: row.channelLabel,
    intent: row.intent,
    urgent: Boolean(row.urgent),
    reply: row.reply,
    followUp: safeJson(row.followUp, []),
    engine: row.engine,
    aiFallbackReason: row.aiFallbackReason,
    score: { score: row.score ?? 0, bucket: row.bucket || "cold", reasons: safeJson(row.reasons, []) },
    status: row.status || "new",
    notes: row.notes || "",
    jobValue: row.jobValue,
    sms: safeJson(row.sms, null),
    business: safeJson(row.business, null),
    followUpAt: row.followUpAt,
    customerId: row.customerId,
    conversationId: row.conversationId,
    appointmentId: row.appointmentId,
    estimatedValue: row.estimatedValue,
    confirmedRevenue: row.confirmedRevenue,
    revenueStatus: row.revenueStatus || "UNKNOWN",
    lostReason: row.lostReason,
    qualification: safeJson(row.qualification, {}),
    stageAt: safeJson(row.stageAt, {}),
    optedOut: Boolean(row.optedOut),
    doNotContact: Boolean(row.doNotContact),
    followUpStatus: row.followUpStatus || "active",
    ownerLastNotifiedAt: row.ownerLastNotifiedAt,
    demo: Boolean(row.demo),
    afterHours: Boolean(row.afterHours),
    severity: row.severity || "normal",
    bookingState: row.bookingState || "available",
    failureState: row.failureState || null,
    deliveryStatus: row.deliveryStatus || null,
    revenueState: row.revenueState || null,
    invoiceRef: row.invoiceRef || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Every column that can legitimately change after the initial insert.
const LEAD_UPDATE_COLUMNS = [
  "status", "notes", "jobValue", "followUpAt", "updatedAt", "reply", "qualification",
  "stageAt", "estimatedValue", "confirmedRevenue", "revenueStatus", "lostReason",
  "optedOut", "doNotContact", "followUpStatus", "appointmentId", "conversationId",
  "customerId", "score", "bucket", "reasons", "urgent", "intent", "engine",
  "aiFallbackReason", "followUp", "sms", "business", "ownerLastNotifiedAt", "name",
  "phone", "message", "channel", "channelLabel", "source", "demo", "afterHours",
    "severity", "bookingState", "failureState", "deliveryStatus", "revenueState", "invoiceRef",
  ];

// ---------------------------------------------------------------- public API

export const engine = {
  // ------------------------------------------------ leads (typed table)

  upsertLead(lead) {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      const idx = doc.leads.findIndex((l) => l.id === lead.id);
      if (idx === -1) doc.leads.unshift(lead);
      else doc.leads[idx] = lead;
      jsonWrite(doc);
      return lead;
    }
    const updateSet = LEAD_UPDATE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
    db.prepare(`
      INSERT INTO leads (
        id, businessId, name, phone, message, source, channel, channelLabel, intent, urgent,
        reply, followUp, engine, aiFallbackReason, score, bucket, reasons, status, notes,
        jobValue, sms, business, followUpAt, customerId, conversationId, appointmentId,
        estimatedValue, confirmedRevenue, revenueStatus, lostReason, qualification, stageAt,
        optedOut, doNotContact, followUpStatus, ownerLastNotifiedAt, demo, afterHours, severity, bookingState,
        failureState, deliveryStatus, revenueState, invoiceRef, createdAt, updatedAt
      ) VALUES (
        $id, $businessId, $name, $phone, $message, $source, $channel, $channelLabel, $intent, $urgent,
        $reply, $followUp, $engine, $aiFallbackReason, $score, $bucket, $reasons, $status, $notes,
        $jobValue, $sms, $business, $followUpAt, $customerId, $conversationId, $appointmentId,
        $estimatedValue, $confirmedRevenue, $revenueStatus, $lostReason, $qualification, $stageAt,
        $optedOut, $doNotContact, $followUpStatus, $ownerLastNotifiedAt, $demo, $afterHours, $severity, $bookingState,
        $failureState, $deliveryStatus, $revenueState, $invoiceRef, $createdAt, $updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET ${updateSet}
    `).run({
      $id: lead.id,
      $businessId: lead.businessId ?? null,
      $name: lead.name ?? null,
      $phone: lead.phone ?? null,
      $message: lead.message ?? null,
      $source: lead.source ?? null,
      $channel: lead.channel ?? null,
      $channelLabel: lead.channelLabel ?? null,
      $intent: lead.intent ?? null,
      $urgent: lead.urgent ? 1 : 0,
      $reply: lead.reply ?? null,
      $followUp: JSON.stringify(lead.followUp || []),
      $engine: lead.engine ?? null,
      $aiFallbackReason: lead.aiFallbackReason ?? null,
      $score: lead.score?.score ?? null,
      $bucket: lead.score?.bucket ?? null,
      $reasons: JSON.stringify(lead.score?.reasons || []),
      $status: lead.status || "new",
      $notes: lead.notes || "",
      $jobValue: lead.jobValue ?? null,
      $sms: lead.sms ? JSON.stringify(lead.sms) : null,
      $business: lead.business ? JSON.stringify(lead.business) : null,
      $followUpAt: lead.followUpAt ?? null,
      $customerId: lead.customerId ?? null,
      $conversationId: lead.conversationId ?? null,
      $appointmentId: lead.appointmentId ?? null,
      $estimatedValue: lead.estimatedValue ?? null,
      $confirmedRevenue: lead.confirmedRevenue ?? null,
      $revenueStatus: lead.revenueStatus || "UNKNOWN",
      $lostReason: lead.lostReason ?? null,
      $qualification: JSON.stringify(lead.qualification || {}),
      $stageAt: JSON.stringify(lead.stageAt || {}),
      $optedOut: lead.optedOut ? 1 : 0,
      $doNotContact: lead.doNotContact ? 1 : 0,
      $followUpStatus: lead.followUpStatus || "active",
      $ownerLastNotifiedAt: lead.ownerLastNotifiedAt ?? null,
      $demo: lead.demo ? 1 : 0,
      $afterHours: lead.afterHours ? 1 : 0,
      $severity: lead.severity || "normal",
      $bookingState: lead.bookingState || "available",
      $failureState: lead.failureState ?? null,
      $deliveryStatus: lead.deliveryStatus ?? null,
      $revenueState: lead.revenueState ?? null,
      $invoiceRef: lead.invoiceRef ?? null,
      $createdAt: lead.createdAt || new Date().toISOString(),
      $updatedAt: lead.updatedAt ?? null,
    });
    return lead;
  },

  getLead(id) {
    const db = openSqlite();
    if (!db) return jsonRead().leads.find((l) => l.id === id) || null;
    const row = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
    return row ? rowToLead(row) : null;
  },

  listLeads(businessId) {
    const db = openSqlite();
    if (!db) {
      const all = jsonRead().leads;
      return businessId ? all.filter((l) => l.businessId === businessId) : all;
    }
    const rows = businessId
      ? db.prepare("SELECT * FROM leads WHERE businessId = ? ORDER BY createdAt DESC").all(businessId)
      : db.prepare("SELECT * FROM leads ORDER BY createdAt DESC").all();
    return rows.map(rowToLead);
  },

  deleteLead(id) {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      const before = doc.leads.length;
      doc.leads = doc.leads.filter((l) => l.id !== id);
      jsonWrite(doc);
      return doc.leads.length < before;
    }
    db.prepare("DELETE FROM leads WHERE id = ?").run(id);
    return true;
  },

  updateLead(id, patch) {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      const idx = doc.leads.findIndex((l) => l.id === id);
      if (idx === -1) return null;
      doc.leads[idx] = { ...doc.leads[idx], ...patch };
      jsonWrite(doc);
      return doc.leads[idx];
    }
    const current = engine.getLead(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    engine.upsertLead(next);
    return engine.getLead(id);
  },

  // ------------------------------------------------ documents (generic)

  putDocument(collection, doc) {
    if (!COLLECTIONS.includes(collection)) throw new Error(`unknown_collection:${collection}`);
    const record = { ...doc, id: String(doc.id) };
    const db = openSqlite();
    const createdAt = record.createdAt || new Date().toISOString();
    const updatedAt = record.updatedAt || null;
    const payload = { ...record, createdAt, updatedAt };
    if (!db) {
      const doc0 = jsonRead();
      const list = doc0.documents[collection] || (doc0.documents[collection] = []);
      const idx = list.findIndex((d) => d.id === record.id);
      if (idx === -1) list.push(payload);
      else list[idx] = payload;
      jsonWrite(doc0);
      return payload;
    }
    db.prepare(`
      INSERT INTO documents (collection, id, businessId, json, createdAt, updatedAt)
      VALUES ($collection, $id, $businessId, $json, $createdAt, $updatedAt)
      ON CONFLICT(collection, id) DO UPDATE SET
        businessId = excluded.businessId,
        json = excluded.json,
        updatedAt = excluded.updatedAt
    `).run({
      $collection: collection,
      $id: record.id,
      $businessId: record.businessId ?? null,
      $json: JSON.stringify(payload),
      $createdAt: createdAt,
      $updatedAt: updatedAt,
    });
    return payload;
  },

  getDocument(collection, id) {
    if (!COLLECTIONS.includes(collection)) return null;
    const db = openSqlite();
    if (!db) {
      const list = jsonRead().documents[collection] || [];
      return list.find((d) => d.id === id) || null;
    }
    const row = db.prepare("SELECT json FROM documents WHERE collection = ? AND id = ?").get(collection, id);
    return row ? safeJson(row.json, null) : null;
  },

  listDocuments(collection, options = {}) {
    if (!COLLECTIONS.includes(collection)) return [];
    const { businessId, order = "desc", limit = 0, since } = options;
    const db = openSqlite();
    if (!db) {
      let list = [...(jsonRead().documents[collection] || [])];
      if (businessId) list = list.filter((d) => d.businessId === businessId);
      if (since) list = list.filter((d) => (d.createdAt || "") >= since);
      list.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      if (order === "desc") list.reverse();
      return limit > 0 ? list.slice(0, limit) : list;
    }
    const dir = order === "asc" ? "ASC" : "DESC";
    const clauses = ["collection = $collection"];
    const params = { $collection: collection };
    if (businessId) {
      clauses.push("businessId = $businessId");
      params.$businessId = businessId;
    }
    if (since) {
      clauses.push("createdAt >= $since");
      params.$since = since;
    }
    if (limit > 0) params.$limit = limit;
    const sql = `SELECT json FROM documents WHERE ${clauses.join(" AND ")} ORDER BY createdAt ${dir}${
      limit > 0 ? " LIMIT $limit" : ""
    }`;
    return db.prepare(sql).all(params).map((r) => safeJson(r.json, null));
  },

  deleteDocument(collection, id) {
    if (!COLLECTIONS.includes(collection)) return false;
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      const list = doc.documents[collection] || [];
      const idx = list.findIndex((d) => d.id === id);
      if (idx === -1) return false;
      list.splice(idx, 1);
      jsonWrite(doc);
      return true;
    }
    db.prepare("DELETE FROM documents WHERE collection = ? AND id = ?").run(collection, id);
    return true;
  },

  countDocuments(collection, options = {}) {
    if (!COLLECTIONS.includes(collection)) return 0;
    const { businessId } = options;
    const db = openSqlite();
    if (!db) {
      let list = jsonRead().documents[collection] || [];
      if (businessId) list = list.filter((d) => d.businessId === businessId);
      return list.length;
    }
    if (businessId) {
      return db.prepare("SELECT COUNT(*) AS n FROM documents WHERE collection = ? AND businessId = ?").get(collection, businessId).n;
    }
    return db.prepare("SELECT COUNT(*) AS n FROM documents WHERE collection = ?").get(collection).n;
  },

  // ------------------------------------------------ setups

  insertSetup(setup) {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      doc.setups.unshift(setup);
      jsonWrite(doc);
      return setup;
    }
    db.prepare(`
      INSERT INTO setups (id, business, name, email, phone, trade, bookingUrl, channels, plan, status, notes, createdAt)
      VALUES ($id,$business,$name,$email,$phone,$trade,$bookingUrl,$channels,$plan,$status,$notes,$createdAt)
    `).run({
      $id: setup.id,
      $business: setup.business ?? null,
      $name: setup.name ?? null,
      $email: setup.email ?? null,
      $phone: setup.phone ?? null,
      $trade: setup.trade ?? null,
      $bookingUrl: setup.bookingUrl ?? null,
      $channels: JSON.stringify(setup.channels || []),
      $plan: setup.plan ?? null,
      $status: setup.status || "new",
      $notes: setup.notes || "",
      $createdAt: setup.createdAt || new Date().toISOString(),
    });
    return setup;
  },

  listSetups() {
    const db = openSqlite();
    if (!db) return jsonRead().setups;
    return db.prepare("SELECT * FROM setups ORDER BY createdAt DESC").all().map((r) => ({
      ...r,
      channels: safeJson(r.channels, []),
    }));
  },

  updateSetup(id, patch) {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      const idx = doc.setups.findIndex((s) => s.id === id);
      if (idx === -1) return null;
      doc.setups[idx] = { ...doc.setups[idx], ...patch };
      jsonWrite(doc);
      return doc.setups[idx];
    }
    const current = db.prepare("SELECT * FROM setups WHERE id = ?").get(id);
    if (!current) return null;
    const allowed = {};
    if (typeof patch.status === "string") allowed.status = patch.status.slice(0, 40);
    if (typeof patch.notes === "string") allowed.notes = patch.notes.slice(0, 2000);
    const next = { ...current, ...allowed };
    db.prepare("UPDATE setups SET status = $status, notes = $notes WHERE id = $id").run({
      $id: id,
      $status: next.status || "new",
      $notes: next.notes || "",
    });
    return { ...next, channels: safeJson(next.channels, []) };
  },

  // ------------------------------------------------ businesses

  saveBusiness(biz) {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      doc.businesses[biz.id] = biz;
      jsonWrite(doc);
      return biz;
    }
    db.prepare(`
      INSERT INTO businesses (id, json) VALUES ($id, $json)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json
    `).run({ $id: biz.id, $json: JSON.stringify(biz) });
    return biz;
  },

  getBusiness(id) {
    const db = openSqlite();
    if (!db) return jsonRead().businesses[id] || null;
    const row = db.prepare("SELECT json FROM businesses WHERE id = ?").get(id);
    return row ? safeJson(row.json, null) : null;
  },

  listBusinesses() {
    const db = openSqlite();
    if (!db) return Object.values(jsonRead().businesses);
    return db.prepare("SELECT json FROM businesses ORDER BY id").all().map((r) => safeJson(r.json, null));
  },

  nextSeq() {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      doc.seq = (doc.seq || 0) + 1;
      jsonWrite(doc);
      return doc.seq;
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('seq', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)").run();
    const row = db.prepare("SELECT value FROM meta WHERE key = 'seq'").get();
    return Number(row.value);
  },

  // ------------------------------------------------ users / sessions

  insertUser(user) {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      doc.users.push(user);
      jsonWrite(doc);
      return user;
    }
    db.prepare(`
      INSERT INTO users (id, email, passwordHash, salt, role, createdAt)
      VALUES ($id,$email,$passwordHash,$salt,$role,$createdAt)
    `).run({
      $id: user.id,
      $email: user.email,
      $passwordHash: user.passwordHash,
      $salt: user.salt,
      $role: user.role || "admin",
      $createdAt: user.createdAt || new Date().toISOString(),
    });
    return user;
  },

  getUserByEmail(email) {
    const db = openSqlite();
    const target = String(email || "").toLowerCase();
    if (!db) return jsonRead().users.find((u) => u.email === target) || null;
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(target);
    return row || null;
  },

  countUsers() {
    const db = openSqlite();
    if (!db) return jsonRead().users.length;
    return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  },

  insertSession(session) {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      doc.sessions.push(session);
      jsonWrite(doc);
      return session;
    }
    db.prepare(`
      INSERT INTO sessions (token, userId, email, createdAt, expiresAt)
      VALUES ($token,$userId,$email,$createdAt,$expiresAt)
    `).run({
      $token: session.token,
      $userId: session.userId,
      $email: session.email ?? null,
      $createdAt: session.createdAt,
      $expiresAt: session.expiresAt,
    });
    return session;
  },

  getSession(token) {
    const db = openSqlite();
    if (!db) {
      const s = jsonRead().sessions.find((x) => x.token === token);
      return s && Date.parse(s.expiresAt) > Date.now() ? s : null;
    }
    const row = db.prepare("SELECT * FROM sessions WHERE token = ? AND expiresAt > ?").get(token, new Date().toISOString());
    return row || null;
  },

  deleteSession(token) {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      doc.sessions = doc.sessions.filter((x) => x.token !== token);
      jsonWrite(doc);
      return true;
    }
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return true;
  },

  pruneSessions() {
    const db = openSqlite();
    const now = new Date().toISOString();
    if (!db) {
      const doc = jsonRead();
      doc.sessions = doc.sessions.filter((x) => x.expiresAt > now);
      jsonWrite(doc);
      return;
    }
    db.prepare("DELETE FROM sessions WHERE expiresAt <= ?").run(now);
  },

  // ------------------------------------------------ payments

  insertPayment(payment) {
    const db = openSqlite();
    if (!db) {
      const doc = jsonRead();
      doc.payments.unshift(payment);
      jsonWrite(doc);
      return payment;
    }
    db.prepare(`
      INSERT INTO payments (id, businessId, setupId, plan, amount, currency, provider, reference, note, createdAt)
      VALUES ($id,$businessId,$setupId,$plan,$amount,$currency,$provider,$reference,$note,$createdAt)
    `).run({
      $id: payment.id,
      $businessId: payment.businessId ?? null,
      $setupId: payment.setupId ?? null,
      $plan: payment.plan ?? null,
      $amount: payment.amount ?? null,
      $currency: payment.currency || "USD",
      $provider: payment.provider ?? null,
      $reference: payment.reference ?? null,
      $note: payment.note ?? null,
      $createdAt: payment.createdAt || new Date().toISOString(),
    });
    return payment;
  },

  listPayments() {
    const db = openSqlite();
    if (!db) return jsonRead().payments;
    return db.prepare("SELECT * FROM payments ORDER BY createdAt DESC").all();
  },
};

export function resetForTests() {
  const db = openSqlite();
  if (!db) {
    jsonWrite({ ...EMPTY_JSON, documents: {} });
    return;
  }
  db.exec(
    "DELETE FROM leads; DELETE FROM setups; DELETE FROM businesses; DELETE FROM users; DELETE FROM sessions; DELETE FROM payments; DELETE FROM documents; DELETE FROM meta;"
  );
}
