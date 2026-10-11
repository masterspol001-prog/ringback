import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbFile = join(tmpdir(), `ringback-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.RINGBACK_DB = dbFile;
process.env.RB_SESSION_DAYS = "1";
delete process.env.RB_ENFORCE_AUTH;

const auth = await import("../lib/auth.js");

test("password hashing is salted and verifiable", () => {
  const a = auth.hashPassword("correct horse battery");
  const b = auth.hashPassword("correct horse battery");
  assert.notEqual(a.passwordHash, b.passwordHash, "same password must not produce the same hash");
  assert.ok(a.passwordHash.length > 60);

  const user = { salt: a.salt, passwordHash: a.passwordHash };
  assert.equal(auth.verifyPassword("correct horse battery", user), true);
  assert.equal(auth.verifyPassword("wrong password", user), false);
});

test("verifyPassword is safe against malformed users", () => {
  assert.equal(auth.verifyPassword("x", null), false);
  assert.equal(auth.verifyPassword("x", {}), false);
  assert.equal(auth.verifyPassword("x", { salt: "aa", passwordHash: "zz" }), false);
});

test("createUser validates email and password strength", () => {
  assert.throws(() => auth.createUser("not-an-email", "longenough1"), /invalid_email/);
  assert.throws(() => auth.createUser("a@b.com", "short"), /weak_password/);
});

test("createUser normalizes email and rejects duplicates", () => {
  const user = auth.createUser("Owner@Example.com ", "supersecret1");
  assert.equal(user.email, "owner@example.com");
  assert.ok(user.id.startsWith("user_"));
  assert.throws(() => auth.createUser("owner@example.com", "supersecret1"), /user_exists/);
});

test("login rejects a wrong password and accepts the right one", () => {
  auth.createUser("login@example.com", "supersecret2");
  assert.equal(auth.login("login@example.com", "nope"), null);
  const result = auth.login("LOGIN@example.com", "supersecret2");
  assert.ok(result && result.token);
  assert.equal(result.user.email, "login@example.com");
});

test("sessions resolve, expire, and can be deleted", () => {
  auth.createUser("session@example.com", "supersecret3");
  const { token } = auth.login("session@example.com", "supersecret3");

  const row = auth.sessionFromRequest({ headers: { cookie: `${auth.SESSION_COOKIE}=${token}` } });
  assert.ok(row, "session should resolve from the cookie");
  assert.equal(row.session.email, "session@example.com");

  assert.equal(auth.sessionFromRequest({ headers: { cookie: `${auth.SESSION_COOKIE}=bogus` } }), null);
  assert.equal(auth.sessionFromRequest({ headers: {} }), null);

  auth.logout(token);
  assert.equal(auth.sessionFromRequest({ headers: { cookie: `${auth.SESSION_COOKIE}=${token}` } }), null);
});

test("parseCookies handles multiple and encoded cookies", () => {
  const parsed = auth.parseCookies({
    headers: { cookie: "a=1; rb_session=abc%20def; b=2" },
  });
  assert.equal(parsed.a, "1");
  assert.equal(parsed.rb_session, "abc def");
  assert.equal(parsed.b, "2");
});

test("cookie value is HttpOnly, SameSite, and Path scoped", () => {
  const value = auth.cookieValue("tok", { headers: {} });
  assert.match(value, /rb_session=tok/);
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Lax/);
  assert.match(value, /Path=\//);
  assert.doesNotMatch(value, /Secure/, "no Secure flag over plain http");
});

test("cookie value adds Secure behind a TLS proxy", () => {
  const value = auth.cookieValue("tok", { headers: { "x-forwarded-proto": "https" } });
  assert.match(value, /Secure/);
});

test("clearing a cookie expires it", () => {
  assert.match(auth.clearCookieValue({ headers: {} }), /Max-Age=0/);
});

test("auth is enforced once a user exists", () => {
  assert.equal(auth.authEnforced(), true);
  assert.equal(auth.authConfigured(), true);
  const status = auth.authStatus();
  assert.equal(status.enforced, true);
  assert.ok(status.users >= 1);
  assert.equal(status.storage, "sqlite");
});

test("RB_ENFORCE_AUTH=0 disables enforcement even with users", () => {
  process.env.RB_ENFORCE_AUTH = "0";
  assert.equal(auth.authEnforced(), false);
  delete process.env.RB_ENFORCE_AUTH;
  assert.equal(auth.authEnforced(), true);
});

test("ensureBootstrapUser creates exactly one admin from env", () => {
  const before = auth.authStatus().users;
  process.env.RB_ADMIN_EMAIL = "boot@example.com";
  process.env.RB_ADMIN_PASSWORD = "bootstrapped1";
  const created = auth.ensureBootstrapUser();
  assert.equal(created, null, "should not create a second user");
  assert.equal(auth.authStatus().users, before);
  delete process.env.RB_ADMIN_EMAIL;
  delete process.env.RB_ADMIN_PASSWORD;
});
