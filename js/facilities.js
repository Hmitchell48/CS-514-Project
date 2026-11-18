// Facilities and booking rules, shared by the booking page (js/booking.js),
// the API Worker (api/src/index.js) and the seed script that loads the
// facilities and facility_schedules tables (api/scripts/build-seed.mjs).
// Change a space or its hours here, then re-run the seed so the database
// matches what the page shows.
(function (root) {
  // ---------- Booking rules ----------
  var SLOTS = [7, 9, 11, 13, 15, 17, 19]; // slot start hours, 24-hour clock
  var SLOT_HOURS = 2;
  var WALKUP_SLOTS = [11, 13];            // 11 am to 3 pm is first come, first served
  var DAYS_AHEAD = 7;                     // how far ahead a student can book
  var HISTORY_DAYS = 7;                   // how far back "Your reservations" goes
  var CHECK_IN_EARLY_MINUTES = 15;
  var LOCKOUT_DAYS = 7;                   // booking lockout after a no-show
  var BAN_AFTER_NO_SHOWS = 3;             // no-shows that end an account's booking

  // ---------- Safety quiz ----------
  // Every student passes it once before their first booking. The API checks
  // the answers; the page uses `why` to explain a wrong one.
  var QUIZ = [
    {
      question: "When can you check in?",
      options: ["Any time that day", "From 15 minutes before your slot until it ends", "Only in the first 5 minutes"],
      answer: 1,
      why: "Check-in opens 15 minutes before your slot and stays open until it ends."
    },
    {
      question: "What happens if you don't show up?",
      options: ["You pay a fee", "Nothing", "A 7-day lockout from reserving. Three no-shows is a permanent ban."],
      answer: 2,
      why: "No-shows keep courts empty, so each one locks you out for a week, and three end your access."
    },
    {
      question: "Between 11 am and 3 pm, every space is...",
      options: ["First come, first served", "Reserved for clubs", "Closed"],
      answer: 0,
      why: "The middle of the day is walk-up only, so anyone can use an open space."
    }
  ];

  // ---------- Facilities ----------
  // Checked against arc.sdsu.edu on 2026-11-17. Hours are the posted weekly
  // hours, Sunday first, [open, close] on a 24-hour clock (25 = 1 am the next
  // day), null = closed. `spots` is how many students can hold the same slot
  // and is loaded into facilities.capacity; 1 means one booking holds the
  // whole space. `kind` drives the type filter on the booking page.
  // SDSU doesn't publish how many tennis or racquetball courts there are, so
  // those counts need confirming. The ARC has 6 courts; the numbering is ours.
  function numbered(id, name, detail, kind, count) {
    var spaces = [];
    for (var i = 1; i <= count; i++) {
      spaces.push({ id: id + "-" + i, name: name + " " + i, detail: detail, kind: kind });
    }
    return spaces;
  }

  var CLIMBING_HOURS = [[13, 18], [14, 21], [10, 21], [14, 21], [14, 21], [13, 18], [13, 18]];

  var VENUES = [
    {
      id: "arc",
      name: "Aztec Recreation Center",
      location: "ARC, 55th Street",
      hours: [[8, 24], [5.5, 25], [5.5, 25], [5.5, 25], [5.5, 24], [5.5, 24], [8, 24]],
      spaces: numbered("arc-court", "Court", "Basketball, volleyball, futsal", "courts", 4).concat([
        { id: "arc-court-5", name: "Court 5", detail: "Pickleball, badminton", kind: "courts" },
        { id: "arc-court-6", name: "Court 6", detail: "Pickleball, badminton", kind: "courts" },
        { id: "arc-climbing-wall", name: "Climbing wall", detail: "41 ft, top rope and auto belay", kind: "climbing", spots: 13, hours: CLIMBING_HOURS },
        { id: "arc-bouldering-wall", name: "Bouldering wall", detail: "12 ft, 30 routes", kind: "climbing", spots: 12, hours: CLIMBING_HOURS },
        { id: "arc-mat-studio", name: "Mat Studio", detail: "Group bookings", kind: "studios" },
        { id: "arc-mckenzie-studio", name: "McKenzie Studio", detail: "Group bookings", kind: "studios" },
        { id: "arc-yoga-studio", name: "Yoga Studio", detail: "Group bookings", kind: "studios" }
      ])
    },
    {
      id: "aquaplex",
      name: "Aztec Aquaplex",
      location: "Next to the tennis center",
      hours: [[9, 19], [9, 21], [9, 21], [9, 21], [9, 21], [9, 19], [9, 19]],
      spaces: [
        { id: "aq-competition-pool", name: "Competition pool", detail: "50 m, lap swim", kind: "pools", spots: 20 },
        { id: "aq-recreation-pool", name: "Recreation pool", detail: "Open swim", kind: "pools", spots: 30 }
      ]
    },
    {
      id: "tennis",
      name: "Aztec Tennis Center",
      location: "Entered through the Aquaplex",
      hours: [[13, 17], [16, 19], [16, 19], [16, 19], [16, 19], null, [13, 17]],
      spaces: numbered("tennis-court", "Tennis court", "Tennis", "courts", 12)
    },
    {
      id: "racquetball",
      name: "Peterson Gym racquetball",
      location: "West side of Peterson Gymnasium",
      hours: [null, [12, 18], [12, 18], [12, 18], [12, 18], null, null],
      spaces: numbered("pg-racquetball", "Racquetball court", "Racquetball", "courts", 6)
    },
    {
      id: "lanes",
      name: "Aztec Lanes",
      location: "Conrad Prebys Aztec Student Union",
      hours: [[11, 22], [10, 22], [10, 22], [10, 22], [10, 24], [10, 24], [11, 24]],
      spaces: numbered("lanes-bowling", "Bowling lane", "Bowling", "lanes", 12).concat(
        numbered("lanes-table-tennis", "Table tennis", "Table tennis", "lanes", 2)
      )
    },
    {
      id: "fields",
      name: "Recreation fields",
      location: "Across campus",
      hours: [[8, 23], [6, 23], [6, 23], [6, 23], [6, 23], [6, 23], [8, 23]],
      spaces: [
        { id: "rec-field", name: "Recreation Field", detail: "Turf, north of Parking Structure 12", kind: "fields" },
        { id: "ens-700-field", name: "ENS 700 Field", detail: "Turf, north of the Calpulli Center", kind: "fields" }
      ]
    }
  ];

  VENUES.forEach(function (venue) {
    venue.spaces.forEach(function (space) {
      space.spots = space.spots || 1;
      space.hours = space.hours || venue.hours;
    });
  });

  // Is the space open for the whole of a slot on that weekday (0 = Sunday)?
  function isOpenOn(space, weekday, slot) {
    var hours = space.hours[weekday];
    return !!hours && slot >= hours[0] && slot + SLOT_HOURS <= hours[1];
  }

  function isWalkup(slot) {
    return WALKUP_SLOTS.indexOf(slot) !== -1;
  }

  var shared = {
    SLOTS: SLOTS,
    SLOT_HOURS: SLOT_HOURS,
    WALKUP_SLOTS: WALKUP_SLOTS,
    DAYS_AHEAD: DAYS_AHEAD,
    HISTORY_DAYS: HISTORY_DAYS,
    CHECK_IN_EARLY_MINUTES: CHECK_IN_EARLY_MINUTES,
    LOCKOUT_DAYS: LOCKOUT_DAYS,
    BAN_AFTER_NO_SHOWS: BAN_AFTER_NO_SHOWS,
    QUIZ: QUIZ,
    VENUES: VENUES,
    isOpenOn: isOpenOn,
    isWalkup: isWalkup
  };

  if (typeof module === "object" && module.exports) {
    module.exports = shared;
  } else {
    root.CourtConnectFacilities = shared;
  }
})(this);
