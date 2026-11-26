// Tests the API and database rules: runs the real Worker (src/index.js)
// against the real schema.sql and seed.sql in an in-memory SQLite database,
// through a small adapter that behaves like Cloudflare D1, with a clock the
// tests can move (to test check-in windows and no-shows).
//
// Run from api/:  npm test      (needs Node 22 or later, no Cloudflare login)
//
// The results table on technical.html comes from this script.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

// ---------- Controllable clock (America/Los_Angeles wall times) ----------
const RealDate = Date;
let current = RealDate.now();
// San Diego wall time 'YYYY-MM-DD HH:MM' for a timestamp.
function sanDiego(ms) {
  const p = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new RealDate(ms)).forEach((x) => { p[x.type] = x.value; });
  return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute;
}
// Moves the clock to a San Diego wall time, e.g. "2026-11-19T16:50".
// Works in both standard and daylight time.
function setNow(pacific) {
  const wanted = RealDate.parse(pacific + ":00Z");
  let guess = wanted + 8 * 3600000;
  guess += wanted - RealDate.parse(sanDiego(guess) + ":00Z");
  current = guess;
}
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(current); else super(...args); }
  static now() { return current; }
}
globalThis.Date = FakeDate;

// ---------- D1 stand-in over node:sqlite ----------
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(ROOT + "/api/schema.sql", "utf8"));
sqlite.exec(readFileSync(ROOT + "/api/seed.sql", "utf8"));

class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.sql, args); }
  _run() {
    const s = sqlite.prepare(this.sql);
    // D1 numbers ?1 ?2; node:sqlite accepts positional args for both ? and ?N.
    return s.all(...this.args).map((r) => ({ ...r }));
  }
  async first() { return this._run()[0] || null; }
  async all() { return { results: this._run() }; }
  async run() { this._run(); return { success: true }; }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  async batch(stmts) {
    sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => ({ results: s._run() }));
      sqlite.exec("COMMIT");
      return out;
    } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  }
};
const env = { DB, SESSION_SECRET: "x".repeat(40), ALLOWED_ORIGINS: "https://hmitchell48.github.io" };

const worker = (await import(pathToFileURL(ROOT + "/api/src/index.js").href)).default;
const rules = (await import(pathToFileURL(ROOT + "/js/facilities.js").href)).default;

async function call(method, path, body, token) {
  const headers = { Origin: "https://hmitchell48.github.io" };
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const res = await worker.fetch(new Request("https://api.test" + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  }), env);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const q = (sql, ...a) => sqlite.prepare(sql).all(...a).map((r) => ({ ...r }));

// ---------- Test bookkeeping ----------
const results = [];
function check(area, scenario, expected, actual, pass) {
  results.push({ area, scenario, expected, actual, pass: !!pass });
  console.log((pass ? "PASS " : "FAIL ") + area + " | " + scenario + " | expected " + expected + " | got " + actual);
}
const describe = (r) => r.status + (r.data.error ? " " + r.data.error : "");

// Days relative to the seed's "today".
const today = new RealDate(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new RealDate()) + "T00:00:00Z");
function day(n) { const d = new RealDate(today.getTime() + n * 86400000); return d.toISOString().slice(0, 10); }
const D1 = day(1), D2 = day(2), D3 = day(3), D4 = day(4);
const QUIZ_RIGHT = rules.QUIZ.map((x) => x.answer);
const QUIZ_WRONG = rules.QUIZ.map((x) => (x.answer + 1) % x.options.length);

// A space with capacity 1, open 3-9 pm every day, and no club events on D1-D4.
const eventSpaces = new Set(q("SELECT DISTINCT f.code FROM events e JOIN reservations r ON r.reservation_id = e.reservation_id JOIN facilities f ON f.facility_id = r.facility_id").map((r) => r.code));
const freeCourt = q("SELECT code FROM facilities WHERE capacity = 1 AND type = 'court' ORDER BY code").map((r) => r.code).find((c) => !eventSpaces.has(c) && c.startsWith("arc-court"));
const slotTakenBy = (code, date, hour) => q("SELECT COUNT(*) n FROM reservations r JOIN facilities f USING (facility_id) WHERE f.code = ? AND r.start_time = ? AND r.status <> 'cancelled'", code, date + " " + String(hour).padStart(2, "0") + ":00")[0].n;
// Pick a slot on `date` for freeCourt that nobody holds yet.
function freeSlot(date, code = freeCourt) {
  return [15, 17, 19, 7, 9].find((h) => slotTakenBy(code, date, h) === 0);
}

async function newStudent(name, n) {
  const r = await call("POST", "/api/signup", { name, studentId: "9000000" + String(n).padStart(2, "0"), email: "test" + n + "@sdsu.edu", password: "password-" + n });
  return r;
}

setNow(day(0) + "T18:30");

// ---------- Accounts ----------
const a = await newStudent("Test Student A", 1);
check("Accounts", "Sign up with a valid RedID and @sdsu.edu email", "200, account created, quiz not passed", describe(a) + (a.data.user ? ", quizPassed=" + a.data.user.quizPassed : ""), a.status === 200 && a.data.user.quizPassed === false && a.data.token);
const hash = q("SELECT password_hash FROM users WHERE email = 'test1@sdsu.edu'")[0].password_hash;
check("Accounts", "Password is stored hashed, not as plain text", "pbkdf2$100000$… hash", hash.split("$").slice(0, 2).join("$") + "$…", hash.startsWith("pbkdf2$100000$") && !hash.includes("password-1"));
let r = await newStudent("Duplicate", 1);
check("Accounts", "Sign up again with an email already in use", "409 email-taken", describe(r), r.status === 409 && r.data.error === "email-taken");
r = await call("POST", "/api/signup", { name: "Bad", studentId: "12345678", email: "bad@sdsu.edu", password: "password-x" });
check("Accounts", "Sign up with an 8-digit RedID", "400 bad-request", describe(r), r.status === 400);
r = await call("POST", "/api/signup", { name: "Bad", studentId: "900000077", email: "bad@gmail.com", password: "password-x" });
check("Accounts", "Sign up with a non-SDSU email", "400 bad-request", describe(r), r.status === 400);
r = await call("POST", "/api/login", { email: "test1@sdsu.edu", password: "wrong-password" });
check("Accounts", "Log in with the wrong password", "401 bad-credentials", describe(r), r.status === 401 && r.data.error === "bad-credentials");
r = await call("POST", "/api/login", { email: "' OR '1'='1", password: "' OR '1'='1" });
check("Security", "Log in with SQL injection text in both fields", "401 bad-credentials (bound parameters)", describe(r), r.status === 401 && r.data.error === "bad-credentials");
r = await call("GET", "/api/reservations");
check("Security", "List reservations without a token", "401 signed-out", describe(r), r.status === 401 && r.data.error === "signed-out");
const forged = a.data.token.replace(/^\d+\./, "2.");
r = await call("GET", "/api/reservations", null, forged);
check("Security", "Change the user ID inside a token", "401 signed-out (signature no longer matches)", describe(r), r.status === 401);

// ---------- Safety quiz ----------
const A = a.data.token;
let slotA = freeSlot(D1);
r = await call("POST", "/api/reservations", { spaceId: freeCourt, date: D1, slot: slotA }, A);
check("Safety quiz", "Reserve before passing the quiz", "403 quiz-required", describe(r), r.status === 403 && r.data.error === "quiz-required");
r = await call("POST", "/api/quiz", { answers: QUIZ_WRONG }, A);
check("Safety quiz", "Submit the quiz with wrong answers", "400 quiz-failed, lists the wrong questions", describe(r) + " " + JSON.stringify(r.data.wrong), r.status === 400 && r.data.error === "quiz-failed" && r.data.wrong.length === QUIZ_WRONG.length);
r = await call("POST", "/api/quiz", { answers: QUIZ_RIGHT }, A);
check("Safety quiz", "Submit the quiz with correct answers", "200, safety_quiz_passed = 1", describe(r) + ", db=" + q("SELECT safety_quiz_passed p FROM users WHERE email='test1@sdsu.edu'")[0].p, r.status === 200 && r.data.user.quizPassed === true);

// ---------- Reserving ----------
r = await call("POST", "/api/reservations", { spaceId: freeCourt, date: D1, slot: slotA }, A);
const resA = r.data;
check("Reserving", "Reserve an open slot inside a reservation window", "200, status booked", describe(r) + (r.data.status ? ", " + r.data.status : ""), r.status === 200 && r.data.status === "booked");
const slotA2 = freeSlot(D1);
r = await call("POST", "/api/reservations", { spaceId: freeCourt, date: D1, slot: slotA2 }, A);
check("Reserving", "Reserve a second slot on the same day", "409 daily-limit", describe(r), r.status === 409 && r.data.error === "daily-limit");
r = await call("POST", "/api/reservations", { spaceId: freeCourt, date: D2, slot: 11 }, A);
check("Reserving", "Reserve an 11 am walk-up slot", "400 not-reservable", describe(r), r.status === 400 && r.data.error === "not-reservable");
r = await call("POST", "/api/reservations", { spaceId: freeCourt, date: day(-1), slot: 17 }, A);
check("Reserving", "Reserve a slot yesterday", "400 not-reservable", describe(r), r.status === 400);
r = await call("POST", "/api/reservations", { spaceId: freeCourt, date: day(8), slot: 17 }, A);
check("Reserving", "Reserve more than 7 days ahead", "400 not-reservable", describe(r), r.status === 400);
r = await call("POST", "/api/reservations", { spaceId: "no-such-space", date: D2, slot: 17 }, A);
check("Reserving", "Reserve a space that doesn't exist", "400 not-reservable", describe(r), r.status === 400);

// Capacity: B tries A's slot (capacity 1).
const b = await newStudent("Test Student B", 2);
const B = b.data.token;
await call("POST", "/api/quiz", { answers: QUIZ_RIGHT }, B);
r = await call("POST", "/api/reservations", { spaceId: freeCourt, date: D1, slot: slotA }, B);
check("Reserving", "Second student reserves the same 1-person slot", "409 slot-taken", describe(r), r.status === 409 && r.data.error === "slot-taken");

// Club event
const ev = q("SELECT f.code, r.start_time FROM events e JOIN reservations r ON r.reservation_id = e.reservation_id JOIN facilities f ON f.facility_id = r.facility_id WHERE r.start_time > ? AND r.start_time < ? AND r.status <> 'cancelled' ORDER BY r.start_time LIMIT 1", D2, day(7));
if (ev.length) {
  const evDate = ev[0].start_time.slice(0, 10), evHour = +ev[0].start_time.slice(11, 13);
  r = await call("POST", "/api/reservations", { spaceId: ev[0].code, date: evDate, slot: evHour }, B);
  check("Reserving", "Reserve a slot during a club event", "400 not-reservable", describe(r), r.status === 400 && r.data.error === "not-reservable");
}

// Cancelling
r = await call("POST", "/api/reservations/" + resA.id + "/cancel", null, B);
check("Security", "Student B cancels student A's reservation", "409 too-late (row not touched)", describe(r) + ", A's status=" + q("SELECT status FROM reservations WHERE reservation_id=?", +resA.id)[0].status, r.status === 409 && q("SELECT status FROM reservations WHERE reservation_id=?", +resA.id)[0].status === "booked");
r = await call("POST", "/api/reservations/" + resA.id + "/cancel", null, A);
check("Cancelling", "Cancel your own booking before it starts", "200, status cancelled", describe(r) + (r.data.status ? ", " + r.data.status : ""), r.status === 200 && r.data.status === "cancelled");
r = await call("POST", "/api/reservations", { spaceId: freeCourt, date: D1, slot: slotA2 }, A);
const resA2 = r.data;
check("Cancelling", "Book a different slot that day after cancelling", "200 booked (cancelled booking frees the day)", describe(r) + (r.data.status ? ", " + r.data.status : ""), r.status === 200 && r.data.status === "booked");

// ---------- Check-in ----------
const startA2 = slotA2;
setNow(D1 + "T" + String(startA2 - 1).padStart(2, "0") + ":00");
r = await call("POST", "/api/reservations/" + resA2.id + "/check-in", null, A);
check("Check-in", "Check in 60 minutes before the slot", "409 check-in-closed", describe(r), r.status === 409 && r.data.error === "check-in-closed");
setNow(D1 + "T" + String(startA2 - 1).padStart(2, "0") + ":50");
r = await call("POST", "/api/reservations/" + resA2.id + "/check-in", null, A);
check("Check-in", "Check in 10 minutes before the slot", "200, checked-in, check_in_time saved", describe(r) + (r.data.status ? ", " + r.data.status + " at " + r.data.checkInTime : ""), r.status === 200 && r.data.status === "checked-in" && r.data.checkInTime);
r = await call("POST", "/api/reservations/" + resA2.id + "/cancel", null, A);
check("Cancelling", "Cancel a booking you already checked in to", "409 too-late", describe(r), r.status === 409);

// ---------- No-shows ----------
setNow(day(0) + "T18:30");
const c = await newStudent("Test Student C", 3);
const C = c.data.token;
await call("POST", "/api/quiz", { answers: QUIZ_RIGHT }, C);
const sC = freeSlot(D2);
const resC = (await call("POST", "/api/reservations", { spaceId: freeCourt, date: D2, slot: sC }, C)).data;
setNow(D2 + "T" + String(sC + 2).padStart(2, "0") + ":05");
r = await call("GET", "/api/reservations", null, C);
const userC = q("SELECT status, no_show_count, suspended_until FROM users WHERE email='test3@sdsu.edu'")[0];
const penC = q("SELECT COUNT(*) n FROM penalties WHERE reservation_id = ?", +resC.id)[0].n;
check("No-shows", "Slot ends without a check-in, then the student opens the app", "status no-show, 1 penalty, user warned, locked out 7 days", (r.data.find((x) => x.id === resC.id) || {}).status + ", penalties=" + penC + ", " + userC.status + ", until " + userC.suspended_until, (r.data.find((x) => x.id === resC.id) || {}).status === "no-show" && penC === 1 && userC.status === "warned" && userC.suspended_until > D2);
r = await call("POST", "/api/reservations", { spaceId: freeCourt, date: D3, slot: freeSlot(D3) }, C);
check("No-shows", "Student with an active lockout tries to reserve", "403 suspended", describe(r), r.status === 403 && r.data.error === "suspended");
await call("GET", "/api/reservations", null, C);
check("No-shows", "Open the app again (no-show already processed)", "still 1 penalty (no duplicates)", "penalties=" + q("SELECT COUNT(*) n FROM penalties WHERE user_id=(SELECT user_id FROM users WHERE email='test3@sdsu.edu')")[0].n, q("SELECT COUNT(*) n FROM penalties WHERE user_id=(SELECT user_id FROM users WHERE email='test3@sdsu.edu')")[0].n === 1);

setNow(day(0) + "T18:30");
const d = await newStudent("Test Student D", 4);
const Dt = d.data.token;
await call("POST", "/api/quiz", { answers: QUIZ_RIGHT }, Dt);
for (const dd of [D2, D3, D4]) await call("POST", "/api/reservations", { spaceId: freeCourt, date: dd, slot: freeSlot(dd) }, Dt);
setNow(D4 + "T23:30");
await call("GET", "/api/reservations", null, Dt);
const userD = q("SELECT status, no_show_count, suspended_until FROM users WHERE email='test4@sdsu.edu'")[0];
check("No-shows", "Three missed bookings", "no_show_count 3, user banned", "no_show_count=" + userD.no_show_count + ", " + userD.status, userD.no_show_count === 3 && userD.status === "banned");
r = await call("POST", "/api/reservations", { spaceId: freeCourt, date: day(5), slot: freeSlot(day(5)) }, Dt);
check("No-shows", "Banned student tries to reserve", "403 banned", describe(r), r.status === 403 && r.data.error === "banned");

// ---------- Database constraints (directly in SQL, bypassing the API) ----------
function sqlFails(sql, ...args) { try { sqlite.prepare(sql).run(...args); return "accepted"; } catch (e) { return e.message; } }
const uidA = q("SELECT user_id FROM users WHERE email='test1@sdsu.edu'")[0].user_id;
const fid = q("SELECT facility_id FROM facilities WHERE code=?", freeCourt)[0].facility_id;
let m = sqlFails("INSERT INTO reservations (user_id, facility_id, start_time, end_time) VALUES (?, ?, ?, ?)", uidA, fid, D1 + " 07:00", D1 + " 09:00");
check("Constraints", "INSERT a second active reservation for the same student and day", "rejected by reservations_one_per_day", m, /UNIQUE/.test(m));
m = sqlFails("INSERT INTO reservations (user_id, facility_id, start_time, end_time) VALUES (?, ?, ?, ?)", uidA, fid, day(6) + " 09:00", day(6) + " 07:00");
check("Constraints", "INSERT a reservation that ends before it starts", "rejected by CHECK (end_time > start_time)", m, /CHECK/.test(m));
m = sqlFails("INSERT INTO reservations (user_id, facility_id, start_time, end_time, status) VALUES (?, ?, ?, ?, 'pending')", uidA, fid, day(6) + " 07:00", day(6) + " 09:00");
check("Constraints", "INSERT a reservation with an unknown status", "rejected by CHECK on status", m, /CHECK/.test(m));
m = sqlFails("INSERT INTO users (sdsu_red_id, email, full_name, password_hash) VALUES ('12345abcd', 'x@sdsu.edu', 'X', 'h')");
check("Constraints", "INSERT a user whose RedID has letters", "rejected by CHECK on sdsu_red_id", m, /CHECK/.test(m));
m = sqlFails("INSERT INTO facilities (code, name, type, capacity) VALUES ('zero', 'Zero', 'court', 0)");
check("Constraints", "INSERT a facility with capacity 0", "rejected by CHECK (capacity > 0)", m, /CHECK/.test(m));

const passed = results.filter((x) => x.pass).length;
console.log("\n" + passed + "/" + results.length + " passed");
process.exitCode = passed === results.length ? 0 : 1;
