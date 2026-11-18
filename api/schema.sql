-- CourtConnect schema for Cloudflare D1 (SQLite).
--
-- Follows the ER diagram on technical.html, translated from PostgreSQL types:
--   SERIAL     -> INTEGER PRIMARY KEY AUTOINCREMENT
--   TIMESTAMP  -> TEXT 'YYYY-MM-DD HH:MM', San Diego local time
--   TIME       -> TEXT 'HH:MM'
--   BOOLEAN    -> INTEGER 0 or 1
-- Two columns are not on the diagram: users.password_hash (sign-up needs it)
-- and facilities.code (the space ID the booking page uses, e.g. arc-court-1).
--
-- Running this file drops and recreates every table, so it wipes all data.

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS penalties;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS organizations;
DROP TABLE IF EXISTS reservations;
DROP TABLE IF EXISTS facility_schedules;
DROP TABLE IF EXISTS facilities;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  user_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sdsu_red_id        TEXT    UNIQUE CHECK (sdsu_red_id IS NULL OR (length(sdsu_red_id) = 9 AND sdsu_red_id NOT GLOB '*[^0-9]*')),
  email              TEXT    NOT NULL UNIQUE,
  full_name          TEXT    NOT NULL,
  password_hash      TEXT    NOT NULL,
  role               TEXT    NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'club', 'admin')),
  status             TEXT    NOT NULL DEFAULT 'active'  CHECK (status IN ('active', 'warned', 'banned')),
  safety_quiz_passed INTEGER NOT NULL DEFAULT 0 CHECK (safety_quiz_passed IN (0, 1)),
  no_show_count      INTEGER NOT NULL DEFAULT 0 CHECK (no_show_count >= 0),
  suspended_until    TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M', 'now'))
);

CREATE TABLE facilities (
  facility_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  type          TEXT    NOT NULL CHECK (type IN ('court', 'field', 'pool', 'gym', 'studio', 'other')),
  location_area TEXT,
  capacity      INTEGER NOT NULL CHECK (capacity > 0),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

-- Reservable windows. Time outside them (including the 11 am to 3 pm
-- walk-up block) is first come, first served.
CREATE TABLE facility_schedules (
  schedule_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_id    INTEGER NOT NULL REFERENCES facilities (facility_id) ON DELETE CASCADE,
  day_of_week    INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  bookable_start TEXT    NOT NULL,
  bookable_end   TEXT    NOT NULL,
  CHECK (bookable_end > bookable_start)
);

CREATE INDEX facility_schedules_lookup ON facility_schedules (facility_id, day_of_week);

CREATE TABLE reservations (
  reservation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users (user_id),
  facility_id    INTEGER NOT NULL REFERENCES facilities (facility_id),
  start_time     TEXT    NOT NULL,
  end_time       TEXT    NOT NULL,
  check_in_time  TEXT,
  status         TEXT    NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'checked-in', 'no-show', 'cancelled')),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M', 'now')),
  CHECK (end_time > start_time)
);

-- One reservation per student per day. Cancelled bookings free the day up;
-- a no-show still uses it.
CREATE UNIQUE INDEX reservations_one_per_day
  ON reservations (user_id, date(start_time))
  WHERE status <> 'cancelled';

-- Counting who holds a slot (the capacity check and the day view).
CREATE INDEX reservations_slot ON reservations (facility_id, start_time);

CREATE TABLE organizations (
  org_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL UNIQUE,
  category        TEXT    CHECK (category IN ('club', 'fraternity', 'sorority')),
  contact_user_id INTEGER NOT NULL REFERENCES users (user_id)
);

-- Each event is held on one reservation, which gives it its place and time.
CREATE TABLE events (
  event_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL UNIQUE REFERENCES reservations (reservation_id) ON DELETE CASCADE,
  org_id         INTEGER NOT NULL REFERENCES organizations (org_id),
  title          TEXT    NOT NULL,
  description    TEXT,
  is_public_join INTEGER NOT NULL DEFAULT 0 CHECK (is_public_join IN (0, 1))
);

CREATE TABLE penalties (
  penalty_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users (user_id),
  reservation_id INTEGER REFERENCES reservations (reservation_id),
  issued_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M', 'now')),
  reason         TEXT    NOT NULL
);
