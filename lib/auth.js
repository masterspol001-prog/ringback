// Authentication for the lead CRM.
//
// Design goals:
// - Zero dependencies: scrypt password hashing from node:crypto, opaque
//   session tokens, HttpOnly cookies.
// - Safe by default once a user exists, but never breaks a fresh local demo.
//   Auth is ENFORCED as soon as either an admin account exists in the database
//   or RB_ADMIN_PASSWORD is configured with RB_ENFORCE_AUTH=1.
// - The setup request form and all inbound webhooks stay public; only CRM
//   reads/writes are protected.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { engine, hasSqlite } from "./db.js";
import { nextId } from "./store.js";

export const SESSION_COOKIE = "rb_session";
const SESSION_DAYS = Number(process.env.RB_SESSION_DAYS || 7);
const SCRYPT_KEYLEN = 64;

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(String(password), salt, SCRYPT_KEYLEN).toString("hex");
  return { salt, passwordHash: hash };
}

export function verifyPassword(password, user) {
  if (!user || !user.salt || !user.passwordHash) return false;
  const attempt = scryptSync(String(password), user.salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(user.passwordHash, "hex");
  if (attempt.length !== expected.length) return false;
  return timingSafeEqual(attempt, expected);
}

export function createUser(email, password, role = "admin") {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean || !clean.includes("@")) throw new Error("invalid_email");
  if (String(password || "").length < 8) throw new Error("weak_password");
  if (engine.getUserByEmail(clean)) throw new Error("user_exists");
  const { salt, passwordHash } = hashPassword(password);
  return engine.insertUser({
    id: nextId("user"),
    email: clean,
    passwordHash,
    salt,
    role,
    createdAt: new Date().toISOString(),
  });
}

export function ensureBootstrapUser() {
  const email = process.env.RB_ADMIN_EMAIL;
  const password = process.env.RB_ADMIN_PASSWORD;
  if (!email || !password) return null;
  if (engine.countUsers() > 0) return null;
  try {
    const user = createUser(email, password);
    console.log(`auth: created bootstrap admin ${user.email}`);
    return user;
  } catch (err) {
    console.error(`auth: bootstrap failed - ${err.message}`);
    return null;
  }
}

// Auth is enforced when we actually have a credential to check against.
export function authEnforced() {
  if (process.env.RB_ENFORCE_AUTH === "0") return false;
  if (process.env.RB_ENFORCE_AUTH === "1") return true;
  return engine.countUsers() > 0;
}

export function authConfigured() {
  return engine.countUsers() > 0 || Boolean(process.env.RB_ADMIN_PASSWORD);
}

export function login(email, password) {
  const user = engine.getUserByEmail(String(email || "").trim().toLowerCase());
  if (!user) return null;
  if (!verifyPassword(password, user)) return null;
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  const session = {
    token,
    userId: user.id,
    email: user.email,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_DAYS * 86400_000).toISOString(),
  };
  engine.pruneSessions();
  engine.insertSession(session);
  return { token, user: { id: user.id, email: user.email, role: user.role } };
}

export function logout(token) {
  if (token) engine.deleteSession(token);
}

export function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

export function sessionFromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = engine.getSession(token);
  if (!session) return null;
  return { token, session };
}

export function cookieValue(token, req, maxAgeSeconds = SESSION_DAYS * 86400) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearCookieValue(req) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function isSecureRequest(req) {
  const proto = req.headers?.["x-forwarded-proto"];
  if (typeof proto === "string" && proto.split(",")[0].trim() === "https") return true;
  return Boolean(process.env.RB_SECURE_COOKIES === "1");
}

export function authStatus() {
  return {
    enforced: authEnforced(),
    configured: authConfigured(),
    users: engine.countUsers(),
    storage: hasSqlite() ? "sqlite" : "json",
  };
}
