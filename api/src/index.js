// CourtConnect API: a Cloudflare Worker in front of the D1 database.
//
// The booking page (js/booking.js on GitHub Pages) calls these routes:
//
//   POST /api/signup                       { name, studentId, email, password }
//   POST /api/login                        { email, password }
//   GET  /api/day?date=YYYY-MM-DD          slot counts and club events for a day
//   GET  /api/reservations                 the signed-in student's reservations
//   POST /api/reservations                 { spaceId, date, slot }
//   POST /api/reservations/:id/cancel
//   POST /api/reservations/:id/check-in
//
// Errors come back as { error: "<code>" }. The codes match the MESSAGES table
// in js/booking.js.
//
// Times are stored as 'YYYY-MM-DD HH:MM' in San Diego local time, the same
// clock the page shows, so "has this slot started" compares plain strings.

import rules from "../../js/facilities.js";

var SLOTS = rules.SLOTS;
var SLOT_HOURS = rules.SLOT_HOURS;
var DAYS_AHEAD = rules.DAYS_AHEAD;
var HISTORY_DAYS = rules.HISTORY_DAYS;
var CHECK_IN_EARLY_MINUTES = rules.CHECK_IN_EARLY_MINUTES;

var TIME_ZONE = "America/Los_Angeles";
var SESSION_DAYS = 7;
var PBKDF2_ITERATIONS = 100000; // the most Workers allows
var MIN_SECRET_LENGTH = 32;

// Longest values accepted from the sign-up and log-in forms.
var MAX_NAME = 100;
var MAX_EMAIL = 254;
var MAX_PASSWORD = 128;

// ---------- Responses ----------
class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function corsHeaders(request, env) {
  var origin = request.headers.get("Origin") || "";
  var allowed = (env.ALLOWED_ORIGINS || "").split(",").map(function (o) { return o.trim(); });
  var isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  var headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (isLocal || allowed.indexOf(origin) !== -1) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }, cors)
  });
}

async function readBody(request) {
  var body;
  try {
    body = await request.json();
  } catch (e) {
    throw new ApiError(400, "bad-request");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "bad-request");
  return body;
}

// Slows down password guessing and mass sign-ups: each IP gets a few
// attempts a minute (the AUTH_LIMITER binding in wrangler.toml).
async function limitAuth(request, env) {
  if (!env.AUTH_LIMITER) return;
  var ip = request.headers.get("CF-Connecting-IP") || "unknown";
  var outcome = await env.AUTH_LIMITER.limit({ key: ip });
  if (!outcome.success) throw new ApiError(429, "too-many-attempts");
}

// ---------- Local time ----------
function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

// 'YYYY-MM-DD HH:MM' right now in San Diego.
function nowLocal() {
  var parts = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date()).forEach(function (part) {
    parts[part.type] = part.value;
  });
  return parts.year + "-" + parts.month + "-" + parts.day + " " + parts.hour + ":" + parts.minute;
}

// Local time strings do arithmetic as if they were UTC, which keeps it simple
// and is exact for the minute and day offsets used here.
function toMs(local) {
  return Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10),
    +(local.slice(11, 13) || 0), +(local.slice(14, 16) || 0));
}

function fromMs(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function addMinutes(local, minutes) {
  return fromMs(toMs(local) + minutes * 60000);
}

function addDays(dateKey, days) {
  return fromMs(toMs(dateKey) + days * 86400000).slice(0, 10);
}

function weekday(dateKey) {
  return new Date(toMs(dateKey)).getUTCDay();
}

function slotTime(dateKey, hour) {
  return dateKey + " " + pad(hour) + ":00";
}

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && fromMs(toMs(value)).slice(0, 10) === value;
}

// ---------- Passwords ----------
function toBase64(bytes) {
  var text = "";
  new Uint8Array(bytes).forEach(function (b) { text += String.fromCharCode(b); });
  return btoa(text);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), function (c) { return c.charCodeAt(0); });
}

function base64url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  var padded = text.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4) padded += "=";
  return fromBase64(padded);
}

async function pbkdf2(password, salt, iterations) {
  var key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: iterations }, key, 256);
}

// Stored as pbkdf2$<iterations>$<salt>$<hash>. api/scripts/build-seed.mjs
// writes the same format.
async function hashPassword(password) {
  var salt = crypto.getRandomValues(new Uint8Array(16));
  var hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return "pbkdf2$" + PBKDF2_ITERATIONS + "$" + toBase64(salt) + "$" + toBase64(hash);
}

async function checkPassword(password, stored) {
  var parts = (stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  var actual = new Uint8Array(await pbkdf2(password, fromBase64(parts[2]), +parts[1]));
  var expected = fromBase64(parts[3]);
  if (actual.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// ---------- Sessions ----------
// A token is <userId>.<expiry ms>.<HMAC of the first two parts>.
async function hmacKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < MIN_SECRET_LENGTH) {
    throw new Error("SESSION_SECRET is missing or shorter than " + MIN_SECRET_LENGTH + " characters");
  }
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeToken(env, userId) {
  var payload = userId + "." + (Date.now() + SESSION_DAYS * 86400000);
  var signature = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(payload));
  return payload + "." + base64url(signature);
}

async function requireUser(request, env) {
  var header = request.headers.get("Authorization") || "";
  var parts = header.replace(/^Bearer\s+/i, "").split(".");
  if (parts.length !== 3) throw new ApiError(401, "signed-out");

  var valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", await hmacKey(env), fromBase64url(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch (e) {
    valid = false;
  }
  if (!valid || +parts[1] < Date.now()) throw new ApiError(401, "signed-out");

  var user = await env.DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(+parts[0]).first();
  if (!user) throw new ApiError(401, "signed-out");
  return user;
}

function publicUser(user) {
  return { studentId: user.sdsu_red_id, name: user.full_name, email: user.email };
}

// ---------- Reservations ----------
// The shape js/booking.js works with.
function toClient(row) {
  return {
    id: String(row.reservation_id),
    facilityId: row.code,
    date: row.start_time.slice(0, 10),
    slot: +row.start_time.slice(11, 13),
    status: row.status,
    checkInTime: row.check_in_time ? row.check_in_time.replace(" ", "T") : null,
    createdAt: row.created_at
  };
}

function reservationById(env, id) {
  return env.DB.prepare(
    "SELECT r.*, f.code FROM reservations r JOIN facilities f ON f.facility_id = r.facility_id WHERE r.reservation_id = ?"
  ).bind(id).first();
}

// ---------- Routes ----------
async function signUp(request, env) {
  await limitAuth(request, env);
  var body = await readBody(request);
  var name = String(body.name || "").trim();
  var studentId = String(body.studentId || "").trim();
  var email = String(body.email || "").trim().toLowerCase();
  var password = String(body.password || "");
  if (!name || name.length > MAX_NAME || !/^\d{9}$/.test(studentId) || email.length > MAX_EMAIL ||
      !/^[^\s@]+@sdsu\.edu$/.test(email) || password.length < 8 || password.length > MAX_PASSWORD) {
    throw new ApiError(400, "bad-request");
  }

  var user;
  try {
    user = await env.DB.prepare(
      "INSERT INTO users (sdsu_red_id, email, full_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *"
    ).bind(studentId, email, name, await hashPassword(password), nowLocal()).first();
  } catch (e) {
    var message = String(e && e.message);
    if (message.indexOf("users.email") !== -1) throw new ApiError(409, "email-taken");
    if (message.indexOf("users.sdsu_red_id") !== -1) throw new ApiError(409, "redid-taken");
    throw e;
  }
  return { user: publicUser(user), token: await makeToken(env, user.user_id) };
}

async function logIn(request, env) {
  await limitAuth(request, env);
  var body = await readBody(request);
  var email = String(body.email || "").trim().toLowerCase();
  var password = String(body.password || "");
  if (!email || email.length > MAX_EMAIL || !password || password.length > MAX_PASSWORD) {
    throw new ApiError(401, "bad-credentials");
  }
  var user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!user || !(await checkPassword(password, user.password_hash))) {
    throw new ApiError(401, "bad-credentials");
  }
  return { user: publicUser(user), token: await makeToken(env, user.user_id) };
}

// taken:  { "<space code>|<slot>": students holding it }
// events: { "<space code>|<slot>": organization name }
async function getDay(url, env) {
  var dateKey = url.searchParams.get("date");
  if (!isDateKey(dateKey)) throw new ApiError(400, "bad-request");

  var result = await env.DB.prepare(
    "SELECT f.code, r.start_time, r.end_time, o.name AS org " +
    "FROM reservations r " +
    "JOIN facilities f ON f.facility_id = r.facility_id " +
    "LEFT JOIN events e ON e.reservation_id = r.reservation_id " +
    "LEFT JOIN organizations o ON o.org_id = e.org_id " +
    "WHERE r.status <> 'cancelled' AND r.start_time >= ? AND r.start_time < ?"
  ).bind(dateKey, addDays(dateKey, 1)).all();

  var taken = {};
  var events = {};
  result.results.forEach(function (row) {
    var start = +row.start_time.slice(11, 13);
    if (row.org) {
      var end = +row.end_time.slice(11, 13);
      SLOTS.forEach(function (slot) {
        if (slot >= start && slot + SLOT_HOURS <= end) events[row.code + "|" + slot] = row.org;
      });
    } else {
      var key = row.code + "|" + start;
      taken[key] = (taken[key] || 0) + 1;
    }
  });
  return { taken: taken, events: events };
}

async function listReservations(request, env) {
  var user = await requireUser(request, env);
  var cutoff = addDays(nowLocal().slice(0, 10), -HISTORY_DAYS);
  var result = await env.DB.prepare(
    "SELECT r.*, f.code FROM reservations r JOIN facilities f ON f.facility_id = r.facility_id " +
    "WHERE r.user_id = ? AND r.status <> 'cancelled' AND r.start_time >= ? " +
    "AND r.reservation_id NOT IN (SELECT reservation_id FROM events) " +
    "ORDER BY r.start_time"
  ).bind(user.user_id, cutoff).all();
  return result.results.map(toClient);
}

async function reserve(request, env) {
  var user = await requireUser(request, env);
  var body = await readBody(request);
  var dateKey = body.date;
  var slot = +body.slot;
  var now = nowLocal();
  var today = now.slice(0, 10);

  if (user.status === "banned" || (user.suspended_until && user.suspended_until > now)) {
    throw new ApiError(403, "suspended");
  }
  if (!isDateKey(dateKey) || SLOTS.indexOf(slot) === -1 || rules.isWalkup(slot) ||
      dateKey < today || dateKey >= addDays(today, DAYS_AHEAD)) {
    throw new ApiError(400, "not-reservable");
  }

  var start = slotTime(dateKey, slot);
  var end = slotTime(dateKey, slot + SLOT_HOURS);
  if (start <= now) throw new ApiError(400, "not-reservable");

  var facility = await env.DB.prepare("SELECT * FROM facilities WHERE code = ? AND is_active = 1")
    .bind(String(body.spaceId)).first();
  if (!facility) throw new ApiError(400, "not-reservable");

  var checks = await env.DB.batch([
    // inside a bookable window that day
    env.DB.prepare(
      "SELECT 1 FROM facility_schedules WHERE facility_id = ? AND day_of_week = ? AND bookable_start <= ? AND bookable_end >= ?"
    ).bind(facility.facility_id, weekday(dateKey), start.slice(11), end.slice(11)),
    // not during a club event
    env.DB.prepare(
      "SELECT 1 FROM reservations r JOIN events e ON e.reservation_id = r.reservation_id " +
      "WHERE r.facility_id = ? AND r.status <> 'cancelled' AND r.start_time < ? AND r.end_time > ?"
    ).bind(facility.facility_id, end, start),
    // not already booked that day
    env.DB.prepare(
      "SELECT 1 FROM reservations WHERE user_id = ? AND date(start_time) = ? AND status <> 'cancelled'"
    ).bind(user.user_id, dateKey)
  ]);
  if (!checks[0].results.length || checks[1].results.length) throw new ApiError(400, "not-reservable");
  if (checks[2].results.length) throw new ApiError(409, "daily-limit");

  // Insert only while the slot has room. One statement, so two students
  // can't both take the last spot.
  var row;
  try {
    row = await env.DB.prepare(
      "INSERT INTO reservations (user_id, facility_id, start_time, end_time, status, created_at) " +
      "SELECT ?1, ?2, ?3, ?4, 'booked', ?5 " +
      "WHERE (SELECT COUNT(*) FROM reservations WHERE facility_id = ?2 AND start_time = ?3 AND status <> 'cancelled') " +
      "    < (SELECT capacity FROM facilities WHERE facility_id = ?2) " +
      "RETURNING reservation_id"
    ).bind(user.user_id, facility.facility_id, start, end, now).first();
  } catch (e) {
    // reservations_one_per_day: a second booking for the same day slipped in
    if (String(e && e.message).indexOf("UNIQUE") !== -1) throw new ApiError(409, "daily-limit");
    throw e;
  }
  if (!row) throw new ApiError(409, "slot-taken");
  return toClient(await reservationById(env, row.reservation_id));
}

async function cancel(request, env, id) {
  var user = await requireUser(request, env);
  var row = await env.DB.prepare(
    "UPDATE reservations SET status = 'cancelled' " +
    "WHERE reservation_id = ? AND user_id = ? AND status = 'booked' AND start_time > ? RETURNING reservation_id"
  ).bind(id, user.user_id, nowLocal()).first();
  if (!row) throw new ApiError(409, "too-late");
  return toClient(await reservationById(env, id));
}

// Check-in opens CHECK_IN_EARLY_MINUTES before the slot and closes when it ends.
async function checkIn(request, env, id) {
  var user = await requireUser(request, env);
  var now = nowLocal();
  var row = await env.DB.prepare(
    "UPDATE reservations SET status = 'checked-in', check_in_time = ? " +
    "WHERE reservation_id = ? AND user_id = ? AND status = 'booked' AND start_time <= ? AND end_time > ? " +
    "RETURNING reservation_id"
  ).bind(now, id, user.user_id, addMinutes(now, CHECK_IN_EARLY_MINUTES), now).first();
  if (!row) throw new ApiError(409, "check-in-closed");
  return toClient(await reservationById(env, id));
}

async function route(request, env) {
  var url = new URL(request.url);
  var path = url.pathname.replace(/\/+$/, "");
  var method = request.method;

  if (method === "POST" && path === "/api/signup") return signUp(request, env);
  if (method === "POST" && path === "/api/login") return logIn(request, env);
  if (method === "GET" && path === "/api/day") return getDay(url, env);
  if (method === "GET" && path === "/api/reservations") return listReservations(request, env);
  if (method === "POST" && path === "/api/reservations") return reserve(request, env);

  var action = path.match(/^\/api\/reservations\/(\d+)\/(cancel|check-in)$/);
  if (method === "POST" && action) {
    return action[2] === "cancel" ? cancel(request, env, +action[1]) : checkIn(request, env, +action[1]);
  }
  throw new ApiError(404, "not-found");
}

export default {
  async fetch(request, env) {
    var cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      return json(await route(request, env), 200, cors);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.code }, error.status, cors);
      console.error(error);
      return json({ error: "unknown" }, 500, cors);
    }
  }
};
