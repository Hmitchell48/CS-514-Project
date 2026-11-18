// Facilities and booking rules, shared by the booking page (js/booking.js),
// the API Worker (api/src/index.js) and the seed script that loads the
// facilities and facility_schedules tables (api/scripts/build-seed.mjs).
// Change a space or its hours here, then re-run the seed so the database
// matches what the page shows.
(function (root) {
  // ---------- Booking rules ----------
  var SLOTS = [7, 9, 11, 13, 15, 17, 19]; // slot start hours, 24-hour clock
  var SLOT_HOURS = 2;
  var WALKUP_SLOTS = [11, 13];            // outside the reservation windows
  var DAYS_AHEAD = 7;                     // how far ahead a student can book
  var HISTORY_DAYS = 7;                   // how far back "Your reservations" goes
  var CHECK_IN_EARLY_MINUTES = 15;

  // ---------- Facilities ----------
  // Every space Aztec Recreation lists at arc.sdsu.edu. Hours are [open, close]
  // on a 24-hour clock, from the fall 2026 schedule at arc.sdsu.edu/hours.
  // `spots` is how many students can hold the same slot (default 1). It is
  // loaded into facilities.capacity.
  function week(monThu, fri, sat, sun) {
    return [sun, monThu, monThu, monThu, monThu, fri, sat];
  }

  function numbered(id, name, detail, count) {
    var spaces = [];
    for (var i = 1; i <= count; i++) {
      spaces.push({ id: id + "-" + i, name: name + " " + i, detail: detail });
    }
    return spaces;
  }

  var FIELD_HOURS = week([6, 23], [6, 23], [8, 23], [8, 23]);
  var CLIMBING_HOURS = week([14, 21], [13, 18], [13, 18], [13, 18]);

  var VENUES = [
    {
      id: "arc",
      name: "Aztec Recreation Center",
      location: "55th Street",
      hours: week([5.5, 24], [5.5, 24], [8, 24], [8, 24]),
      spaces: numbered("arc-court", "Court", "Basketball", 4).concat([
        { id: "arc-north-court", name: "North Court", detail: "Volleyball, futsal" },
        { id: "arc-south-court", name: "South Court", detail: "Pickleball, badminton" },
        { id: "arc-climbing-wall", name: "Climbing wall", detail: "Top rope, lead", spots: 13, hours: CLIMBING_HOURS },
        { id: "arc-bouldering-wall", name: "Bouldering wall", detail: "30 routes", spots: 12, hours: CLIMBING_HOURS },
        { id: "arc-track", name: "Indoor track", detail: "1/8 mile", spots: 30 },
        { id: "arc-yoga-studio", name: "Yoga Studio", detail: "Fitness studio" },
        { id: "arc-cycle-studio", name: "Cycle Studio", detail: "Fitness studio" },
        { id: "arc-mat-studio", name: "Mat Studio", detail: "Fitness studio" },
        { id: "arc-group-fitness-studio", name: "Group Fitness Studio", detail: "Fitness studio" },
        { id: "arc-mckenzie-studio", name: "McKenzie Studio", detail: "Fitness studio" },
        { id: "arc-cardio", name: "Cardio floor", detail: "Cardio equipment", spots: 40 },
        { id: "arc-weight-training", name: "Weight training", detail: "Free weights, machines", spots: 40 },
        { id: "arc-olympic-north", name: "Olympic Lifting North", detail: "Platforms, cables", spots: 12 },
        { id: "arc-olympic-south", name: "Olympic Lifting South", detail: "Platforms", spots: 12 },
        { id: "arc-turf-zone", name: "Turf Zone", detail: "Functional training", spots: 15 },
        { id: "arc-fit-zone", name: "Fit Zone", detail: "High intensity training", spots: 15 },
        { id: "arc-quiet-lounge", name: "Quiet Lounge", detail: "Study, meditation", spots: 20 }
      ])
    },
    {
      id: "arc-express",
      name: "ARC Express",
      location: "Conrad Prebys Aztec Student Union, 3rd floor",
      hours: week([8, 22], [8, 22], [10, 20], [10, 20]),
      spaces: [
        { id: "express-cardio", name: "Cardio equipment", detail: "Treadmills, bikes", spots: 20 },
        { id: "express-resistance", name: "Resistance training", detail: "Machines, free weights", spots: 20 },
        { id: "express-functional", name: "Functional training", detail: "Synrgy 360, TRX", spots: 10 }
      ]
    },
    {
      id: "aquaplex",
      name: "Aztec Aquaplex",
      location: "Remington Road",
      hours: week([9, 21], [9, 19], [9, 19], [9, 19]),
      spaces: [
        { id: "aq-competition-pool", name: "Competition pool", detail: "Lap swim", spots: 24 }
      ].concat(numbered("aq-rec-lane", "Rec pool lane", "Lap swim", 4), [
        { id: "aq-rec-pool", name: "Recreation pool", detail: "Open swim", spots: 30 },
        { id: "aq-spa", name: "Spa", detail: "20 person", spots: 20 }
      ])
    },
    {
      id: "tennis",
      name: "Aztec Tennis Center",
      location: "Next to the Aquaplex",
      hours: week([16, 19], null, [13, 17], [13, 17]),
      spaces: numbered("tennis-court", "Tennis court", "Tennis", 12)
    },
    {
      id: "lanes",
      name: "Aztec Lanes",
      location: "Conrad Prebys Aztec Student Union",
      hours: week([10, 22], [10, 24], [11, 24], [11, 22]),
      spaces: numbered("lanes-bowling", "Bowling lane", "Bowling", 12).concat(
        numbered("lanes-billiards", "Billiards table", "Billiards", 5),
        numbered("lanes-table-tennis", "Table tennis", "Table tennis", 2)
      )
    },
    {
      id: "peterson",
      name: "Peterson Gym",
      location: "West side of Peterson Gymnasium",
      hours: week([12, 18], null, null, null),
      spaces: numbered("pg-racquetball", "Racquetball court", "Racquetball", 6).concat([
        { id: "pg-mat-room", name: "PG 196 Mat Room", detail: "Open rec", spots: 15 }
      ])
    },
    {
      id: "outdoor",
      name: "Fields and outdoor spaces",
      location: "Across campus",
      hours: FIELD_HOURS,
      spaces: [
        { id: "rec-field", name: "Recreation Field", detail: "Turf, north of PS 12" },
        { id: "ens-700-field", name: "ENS 700 Field", detail: "Turf, by Calpulli Center" },
        { id: "aztrack", name: "Aztrack", detail: "1/4 mile, atop PS 7", spots: 30 },
        { id: "arc-courtyard", name: "ARC Courtyard", detail: "Event space" }
      ]
    },
    {
      id: "mbac",
      name: "Mission Bay Aquatic Center",
      location: "Santa Clara Point, Mission Bay",
      hours: week([9, 17], [9, 17], [9, 17], [9, 17]),
      spaces: [
        { id: "mbac-watersports", name: "Watersports", detail: "Sail, surf, paddle", spots: 20 }
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
