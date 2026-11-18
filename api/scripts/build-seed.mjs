// Writes api/seed.sql: facilities and their bookable windows (from
// js/facilities.js), demo logins, sample students with bookings over the past
// and coming week, and club events.
//
// Dates are relative to today, so run it again before a demo:
//   DEMO_PASSWORD='something-private' npm run db:seed:remote
// The SQL starts by deleting every row, so it is safe to re-run.
//
// Only the two demo accounts can log in. They use DEMO_PASSWORD, which
// defaults to "courtconnect-dev" for local use. That default is public (it's
// in this repo and its history), so always set DEMO_PASSWORD for the deployed
// database. Every other seeded account gets a random password nobody knows.

import { createRequire } from "node:module";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

var require = createRequire(import.meta.url);
var rules = require("../../js/facilities.js");
var { SLOTS, SLOT_HOURS, DAYS_AHEAD, HISTORY_DAYS, VENUES } = rules;

var OUT = fileURLToPath(new URL("../seed.sql", import.meta.url));
var LOCAL_DEMO_PASSWORD = "courtconnect-dev";
var DEMO_PASSWORD = process.env.DEMO_PASSWORD || LOCAL_DEMO_PASSWORD;
var REMOTE = process.argv.indexOf("--remote") !== -1;

if (REMOTE && DEMO_PASSWORD === LOCAL_DEMO_PASSWORD) {
  console.error("Refusing to seed the deployed database with the public demo password.\n" +
    "Run it as: DEMO_PASSWORD='something-private' npm run db:seed:remote");
  process.exit(1);
}
if (DEMO_PASSWORD.length < 8) {
  console.error("DEMO_PASSWORD must be at least 8 characters.");
  process.exit(1);
}
var EVENT_WEEKS = 4;

// ---------- Helpers ----------
function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

function q(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function insert(table, columns, rows) {
  var lines = [];
  for (var i = 0; i < rows.length; i += 100) {
    lines.push("INSERT INTO " + table + " (" + columns.join(", ") + ") VALUES\n  " +
      rows.slice(i, i + 100).map(function (row) {
        return "(" + row.map(q).join(", ") + ")";
      }).join(",\n  ") + ";");
  }
  return lines.join("\n");
}

function unknownPassword() {
  return randomBytes(32).toString("base64");
}

function hashPassword(password) {
  var salt = randomBytes(16);
  var hash = pbkdf2Sync(password, salt, 100000, 32, "sha256");
  return "pbkdf2$100000$" + salt.toString("base64") + "$" + hash.toString("base64");
}

// 'YYYY-MM-DD HH:MM' in San Diego, matching the Worker.
function nowLocal() {
  var parts = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
  return parts.year + "-" + parts.month + "-" + parts.day + " " + parts.hour + ":" + parts.minute;
}

function toMs(local) {
  return Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10),
    +(local.slice(11, 13) || 0), +(local.slice(14, 16) || 0));
}

function fromMs(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function addDays(dateKey, days) {
  return fromMs(toMs(dateKey) + days * 86400000).slice(0, 10);
}

function addMinutes(local, minutes) {
  return fromMs(toMs(local) + minutes * 60000);
}

function weekday(dateKey) {
  return new Date(toMs(dateKey)).getUTCDay();
}

function at(dateKey, hour) {
  return dateKey + " " + pad(hour) + ":00";
}

// Small seeded random generator, so a given day always gets the same bookings.
function random(seedText) {
  var h = 2166136261;
  for (var i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  return function () {
    h = (h + 0x6d2b79f5) | 0;
    var t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function typeOf(space) {
  var id = space.id;
  if (/field/.test(id)) return "field";
  if (/^aq-/.test(id)) return "pool";
  if (/studio/.test(id)) return "studio";
  if (/^arc-court-|north-court|south-court|racquetball|tennis/.test(id)) return "court";
  if (/cardio|weight|olympic|turf|fit-zone|^express-|track|aztrack|mat-room/.test(id)) return "gym";
  return "other";
}

// ---------- Facilities and windows ----------
var spaces = [];
VENUES.forEach(function (venue) {
  venue.spaces.forEach(function (space) {
    spaces.push(Object.assign({ facilityId: spaces.length + 1, venue: venue }, space));
  });
});
var spaceByCode = {};
spaces.forEach(function (space) { spaceByCode[space.id] = space; });

// Bookable slots that weekday: open for the whole slot and not walk-up time.
function bookableSlots(space, day) {
  return SLOTS.filter(function (slot) {
    return rules.isOpenOn(space, day, slot) && !rules.isWalkup(slot);
  });
}

var facilityRows = spaces.map(function (space) {
  return [space.facilityId, space.id, space.name, typeOf(space), space.venue.name, space.spots, 1];
});

var scheduleRows = [];
spaces.forEach(function (space) {
  for (var day = 0; day < 7; day++) {
    var windows = [];
    bookableSlots(space, day).forEach(function (slot) {
      var last = windows[windows.length - 1];
      if (last && last[1] === slot) last[1] = slot + SLOT_HOURS;
      else windows.push([slot, slot + SLOT_HOURS]);
    });
    windows.forEach(function (w) {
      scheduleRows.push([space.facilityId, day, pad(w[0]) + ":00", pad(w[1]) + ":00"]);
    });
  }
});

// ---------- Users ----------
var FIRST = ["Aaliyah", "Ben", "Carmen", "Diego", "Emma", "Farah", "Gabe", "Hana", "Isaac", "Jasmine",
  "Kai", "Lena", "Marco", "Nadia", "Omar", "Priya", "Quinn", "Rosa", "Sam", "Tara", "Uriel", "Vanessa",
  "Wes", "Ximena", "Yusuf", "Zoe"];
var LAST = ["Alvarez", "Brooks", "Chen", "Delgado", "Evans", "Flores", "Garcia", "Hughes", "Ibarra",
  "Johnson", "Kim", "Lopez", "Martinez", "Nguyen", "Ortiz", "Patel", "Reyes", "Santos", "Tran", "Walker"];

var now = nowLocal();
var today = now.slice(0, 10);
var users = [];

function addUser(name, email, role, password) {
  var user = {
    userId: users.length + 1,
    redId: String(800000001 + users.length),
    name: name,
    email: email,
    role: role,
    hash: password,
    noShows: 0
  };
  users.push(user);
  return user;
}

var dev = addUser("Dev Tester", "dev@sdsu.edu", "student", hashPassword(DEMO_PASSWORD));
addUser("Second Tester", "dev2@sdsu.edu", "student", hashPassword(DEMO_PASSWORD));

var CLUBS = [
  { name: "Spikeball Club", spaceId: "ens-700-field", day: 2, slots: [13], contact: "Riley Spike" },
  { name: "Volleyball Club", spaceId: "arc-court-1", day: 2, slots: [17, 19], contact: "Jordan Setter" },
  { name: "Swim Club", spaceId: "aq-competition-pool", day: 3, slots: [17], contact: "Morgan Lane" },
  { name: "Soccer Club", spaceId: "rec-field", day: 4, slots: [17, 19], contact: "Alex Keeper" }
];
CLUBS.forEach(function (club, i) {
  club.orgId = i + 1;
  club.user = addUser(club.contact, club.name.toLowerCase().replace(/\s+/g, "") + "@sdsu.edu", "club", hashPassword(unknownPassword()));
});

// Sample students can't log in: one random password, thrown away.
var sampleHash = hashPassword(unknownPassword());
var students = [];
for (var s = 0; s < 50; s++) {
  var first = FIRST[s % FIRST.length];
  var last = LAST[(s * 7) % LAST.length];
  students.push(addUser(first + " " + last, (first + "." + last + s).toLowerCase() + "@sdsu.edu", "student", sampleHash));
}

// ---------- Reservations ----------
var reservations = [];
var taken = {};       // "<facilityId>|<start>" -> count
var eventBlocks = []; // { facilityId, start, end }
var penalties = [];

function statusFor(start, end, rand, user) {
  if (end <= now) {
    if (rand() < 0.8) return { status: "checked-in", checkIn: addMinutes(start, -Math.floor(rand() * 15)) };
    user.noShows++;
    return { status: "no-show", checkIn: null };
  }
  if (start <= now) return { status: "checked-in", checkIn: addMinutes(start, -Math.floor(rand() * 15)) };
  return { status: "booked", checkIn: null };
}

function addReservation(user, space, start, end, picked) {
  var row = {
    id: reservations.length + 1,
    user: user,
    facilityId: space.facilityId,
    start: start,
    end: end,
    checkIn: picked.checkIn,
    status: picked.status,
    createdAt: addMinutes(start, -60 * 24 * 2)
  };
  reservations.push(row);
  if (row.status === "no-show") {
    penalties.push([user.userId, row.id, end, "No-show: " + space.name + ", " + start]);
  }
  return row;
}

// Club events first, so students book around them.
var events = [];
for (var d = -HISTORY_DAYS; d < EVENT_WEEKS * 7; d++) {
  var dateKey = addDays(today, d);
  CLUBS.forEach(function (club) {
    if (weekday(dateKey) !== club.day) return;
    var space = spaceByCode[club.spaceId];
    var start = at(dateKey, Math.min.apply(null, club.slots));
    var end = at(dateKey, Math.max.apply(null, club.slots) + SLOT_HOURS);
    var picked = end <= now || start <= now
      ? { status: "checked-in", checkIn: addMinutes(start, -10) }
      : { status: "booked", checkIn: null };
    var row = addReservation(club.user, space, start, end, picked);
    eventBlocks.push({ facilityId: space.facilityId, start: start, end: end });
    events.push([row.id, club.orgId, club.name + " practice", "Weekly " + club.name.toLowerCase() + " session.", 0]);
  });
}

function clashesWithEvent(space, start, end) {
  return eventBlocks.some(function (b) {
    return b.facilityId === space.facilityId && b.start < end && b.end > start;
  });
}

// Courts and lanes people fight over show up more often.
var weighted = [];
spaces.forEach(function (space) {
  var weight = space.spots === 1 ? 3 : 1;
  for (var w = 0; w < weight; w++) weighted.push(space);
});

for (var day = -HISTORY_DAYS; day < DAYS_AHEAD; day++) {
  var key = addDays(today, day);
  var rand = random("courtconnect" + key);
  students.forEach(function (student) {
    if (rand() > 0.7) return;
    for (var attempt = 0; attempt < 6; attempt++) {
      var space = weighted[Math.floor(rand() * weighted.length)];
      var slots = bookableSlots(space, weekday(key));
      if (!slots.length) continue;
      var slot = slots[Math.floor(rand() * slots.length)];
      var start = at(key, slot);
      var end = at(key, slot + SLOT_HOURS);
      var slotId = space.facilityId + "|" + start;
      if ((taken[slotId] || 0) >= space.spots || clashesWithEvent(space, start, end)) continue;
      taken[slotId] = (taken[slotId] || 0) + 1;
      addReservation(student, space, start, end, statusFor(start, end, rand, student));
      return;
    }
  });
}

// A little history for the main demo account.
(function () {
  var key = addDays(today, -2);
  var space = spaceByCode["arc-court-1"];
  var slot = bookableSlots(space, weekday(key))[0];
  if (slot === undefined || (taken[space.facilityId + "|" + at(key, slot)] || 0) >= space.spots) return;
  addReservation(dev, space, at(key, slot), at(key, slot + SLOT_HOURS),
    { status: "checked-in", checkIn: addMinutes(at(key, slot), -6) });
})();

// ---------- SQL ----------
var sql = [
  "-- Generated by api/scripts/build-seed.mjs on " + now + " (San Diego time). Do not edit by hand.",
  "DELETE FROM penalties;",
  "DELETE FROM events;",
  "DELETE FROM organizations;",
  "DELETE FROM reservations;",
  "DELETE FROM facility_schedules;",
  "DELETE FROM facilities;",
  "DELETE FROM users;",
  insert("users",
    ["user_id", "sdsu_red_id", "email", "full_name", "password_hash", "role", "status", "safety_quiz_passed", "no_show_count", "created_at"],
    users.map(function (u) {
      return [u.userId, u.redId, u.email, u.name, u.hash, u.role, u.noShows ? "warned" : "active", 1, u.noShows, addDays(today, -30) + " 09:00"];
    })),
  insert("facilities", ["facility_id", "code", "name", "type", "location_area", "capacity", "is_active"], facilityRows),
  insert("facility_schedules", ["facility_id", "day_of_week", "bookable_start", "bookable_end"], scheduleRows),
  insert("reservations",
    ["reservation_id", "user_id", "facility_id", "start_time", "end_time", "check_in_time", "status", "created_at"],
    reservations.map(function (r) {
      return [r.id, r.user.userId, r.facilityId, r.start, r.end, r.checkIn, r.status, r.createdAt];
    })),
  insert("organizations", ["org_id", "name", "category", "contact_user_id"],
    CLUBS.map(function (c) { return [c.orgId, c.name, "club", c.user.userId]; })),
  insert("events", ["reservation_id", "org_id", "title", "description", "is_public_join"], events),
  penalties.length ? insert("penalties", ["user_id", "reservation_id", "issued_at", "reason"], penalties) : ""
].filter(Boolean).join("\n\n") + "\n";

writeFileSync(OUT, sql);
console.log("Wrote " + OUT + ": " + users.length + " users, " + spaces.length + " facilities, " +
  scheduleRows.length + " windows, " + reservations.length + " reservations, " + events.length + " events, " +
  penalties.length + " penalties.");
