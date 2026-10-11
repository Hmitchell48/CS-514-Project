// Court booking (home page)
//
// Runs entirely in the browser until the database is connected: reservations
// are kept in localStorage, and other students' bookings and club events are
// generated sample data. Everything that reads or writes data goes through
// `api` below, so connecting the database means rewriting that object only.
(function () {
  var root = document.getElementById("booking");
  if (!root) return;

  // ---------- Test accounts ----------
  // Sign-up needs the Users table, so until it exists these are the only way
  // past the sign-up wall. Delete them once api.logIn talks to the database.
  var TEST_ACCOUNTS = [
    { studentId: "800000001", name: "Dev Tester", email: "dev@sdsu.edu", password: "courtconnect-dev" },
    { studentId: "800000002", name: "Second Tester", email: "dev2@sdsu.edu", password: "courtconnect-dev" }
  ];

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
  // `spots` is how many students can hold the same slot (default 1); those
  // numbers are placeholders until the Facilities table sets real capacities.
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

  // Sample club events, by weekday (0 = Sunday). Stand-in for the Events table.
  var SAMPLE_EVENTS = [
    { spaceId: "ens-700-field", day: 2, slots: [13], org: "Spikeball Club" },
    { spaceId: "arc-north-court", day: 2, slots: [17, 19], org: "Volleyball Club" },
    { spaceId: "aq-competition-pool", day: 3, slots: [17], org: "Swim Club" },
    { spaceId: "rec-field", day: 4, slots: [17, 19], org: "Soccer Club" }
  ];

  var spaceIndex = {};
  VENUES.forEach(function (venue) {
    venue.spaces.forEach(function (space) {
      space.venue = venue;
      space.spots = space.spots || 1;
      space.hours = space.hours || venue.hours;
      spaceIndex[space.id] = space;
    });
  });

  // ---------- Dates and slots ----------
  var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function toKey(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function fromKey(dateKey) {
    var parts = dateKey.split("-");
    return new Date(+parts[0], parts[1] - 1, +parts[2]);
  }

  function addDays(dateKey, days) {
    var date = fromKey(dateKey);
    date.setDate(date.getDate() + days);
    return toKey(date);
  }

  function slotStart(dateKey, slot) {
    var date = fromKey(dateKey);
    date.setHours(slot, 0, 0, 0);
    return date;
  }

  function slotEnd(dateKey, slot) {
    return slotStart(dateKey, slot + SLOT_HOURS);
  }

  function formatHour(hour) {
    return (hour % 12 || 12) + (hour < 12 ? " am" : " pm");
  }

  function formatSlot(slot) {
    return formatHour(slot) + " to " + formatHour(slot + SLOT_HOURS);
  }

  function formatDate(dateKey) {
    var date = fromKey(dateKey);
    return DAY_NAMES[date.getDay()] + ", " + MONTH_NAMES[date.getMonth()] + " " + date.getDate();
  }

  function isWeekend(dateKey) {
    var day = fromKey(dateKey).getDay();
    return day === 0 || day === 6;
  }

  function isOpen(space, dateKey, slot) {
    var hours = space.hours[fromKey(dateKey).getDay()];
    return !!hours && slot >= hours[0] && slot + SLOT_HOURS <= hours[1];
  }

  function isWalkup(slot) {
    return WALKUP_SLOTS.indexOf(slot) !== -1;
  }

  function hasStarted(dateKey, slot) {
    return new Date() >= slotStart(dateKey, slot);
  }

  function inBookingRange(dateKey) {
    var today = toKey(new Date());
    return dateKey >= today && dateKey < addDays(today, DAYS_AHEAD);
  }

  function eventAt(space, dateKey, slot) {
    var day = fromKey(dateKey).getDay();
    for (var i = 0; i < SAMPLE_EVENTS.length; i++) {
      var event = SAMPLE_EVENTS[i];
      if (event.spaceId === space.id && event.day === day && event.slots.indexOf(slot) !== -1) {
        return event.org;
      }
    }
    return null;
  }

  function canCheckIn(reservation) {
    var now = new Date();
    var opens = slotStart(reservation.date, reservation.slot);
    opens.setMinutes(opens.getMinutes() - CHECK_IN_EARLY_MINUTES);
    return now >= opens && now < slotEnd(reservation.date, reservation.slot);
  }

  // Stored statuses are booked, checked-in and cancelled. A booking that ends
  // without a check-in reads as a no-show; the database will store that itself.
  function statusOf(reservation) {
    if (reservation.status === "booked" && new Date() >= slotEnd(reservation.date, reservation.slot)) {
      return "no-show";
    }
    return reservation.status;
  }

  function slotKey(spaceId, slot) {
    return spaceId + "|" + slot;
  }

  // ---------- Storage ----------
  var RESERVATIONS_KEY = "courtconnect.reservations";
  var SESSION_KEY = "courtconnect.session";
  var memory = {};

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return key in memory ? memory[key] : fallback;
    }
  }

  function write(key, value) {
    try {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify(value));
      }
    } catch (e) {
      memory[key] = value;
    }
  }

  // ---------- Sample data ----------
  // Fills the schedule with other students' bookings so it isn't empty. The
  // result is fixed for a given space, day and slot.
  function hash(text) {
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    }
    return h >>> 0;
  }

  function sampleTaken(space, dateKey, slot) {
    var roll = hash(space.id + dateKey + slot) % 100;
    if (space.spots === 1) return roll < 35 ? 1 : 0;
    if (roll >= 94) return space.spots;
    return Math.floor(space.spots * roll / 130);
  }

  // ---------- Data access ----------
  // Every method returns a promise so a fetch() call can replace its body.
  function fail(code) {
    var error = new Error(code);
    error.code = code;
    return Promise.reject(error);
  }

  function findReservation(all, studentId, reservationId) {
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === reservationId && all[i].userId === studentId) return all[i];
    }
    return null;
  }

  var api = {
    // account: { name, studentId, email, password }. Resolve with the new user.
    signUp: function (account) {
      return fail("no-database");
    },

    logIn: function (email, password) {
      for (var i = 0; i < TEST_ACCOUNTS.length; i++) {
        var account = TEST_ACCOUNTS[i];
        if (account.email === email && account.password === password) {
          return Promise.resolve({ studentId: account.studentId, name: account.name, email: account.email });
        }
      }
      return fail("bad-credentials");
    },

    // How many students hold each slot that day, keyed by slotKey().
    getDay: function (dateKey) {
      var taken = {};
      VENUES.forEach(function (venue) {
        venue.spaces.forEach(function (space) {
          SLOTS.forEach(function (slot) {
            var count = sampleTaken(space, dateKey, slot);
            if (count) taken[slotKey(space.id, slot)] = count;
          });
        });
      });
      read(RESERVATIONS_KEY, []).forEach(function (reservation) {
        if (reservation.date === dateKey && reservation.status !== "cancelled") {
          var key = slotKey(reservation.facilityId, reservation.slot);
          taken[key] = (taken[key] || 0) + 1;
        }
      });
      return Promise.resolve(taken);
    },

    listReservations: function (studentId) {
      return Promise.resolve(read(RESERVATIONS_KEY, []).filter(function (reservation) {
        return reservation.userId === studentId && reservation.status !== "cancelled";
      }));
    },

    reserve: function (studentId, spaceId, dateKey, slot) {
      var space = spaceIndex[spaceId];
      if (!space || SLOTS.indexOf(slot) === -1 || !inBookingRange(dateKey) || !isOpen(space, dateKey, slot) ||
          isWalkup(slot) || eventAt(space, dateKey, slot) || hasStarted(dateKey, slot)) {
        return fail("not-reservable");
      }
      var all = read(RESERVATIONS_KEY, []);
      var hasOneThatDay = all.some(function (reservation) {
        return reservation.userId === studentId && reservation.date === dateKey && reservation.status !== "cancelled";
      });
      if (hasOneThatDay) return fail("daily-limit");

      return api.getDay(dateKey).then(function (taken) {
        if ((taken[slotKey(spaceId, slot)] || 0) >= space.spots) return fail("slot-taken");
        var reservation = {
          id: "r" + Date.now() + Math.floor(Math.random() * 1000),
          userId: studentId,
          facilityId: spaceId,
          date: dateKey,
          slot: slot,
          status: "booked",
          createdAt: new Date().toISOString()
        };
        all.push(reservation);
        write(RESERVATIONS_KEY, all);
        return reservation;
      });
    },

    cancel: function (studentId, reservationId) {
      var all = read(RESERVATIONS_KEY, []);
      var reservation = findReservation(all, studentId, reservationId);
      if (!reservation || reservation.status !== "booked" || hasStarted(reservation.date, reservation.slot)) {
        return fail("too-late");
      }
      reservation.status = "cancelled";
      write(RESERVATIONS_KEY, all);
      return Promise.resolve(reservation);
    },

    checkIn: function (studentId, reservationId) {
      var all = read(RESERVATIONS_KEY, []);
      var reservation = findReservation(all, studentId, reservationId);
      if (!reservation || reservation.status !== "booked" || !canCheckIn(reservation)) {
        return fail("check-in-closed");
      }
      reservation.status = "checked-in";
      write(RESERVATIONS_KEY, all);
      return Promise.resolve(reservation);
    }
  };

  var MESSAGES = {
    "no-database": "Sign-up opens once the database is connected. Until then, log in with a test account.",
    "bad-credentials": "That email and password don't match an account.",
    "daily-limit": "You already have a reservation that day. Students can hold one per day.",
    "slot-taken": "Someone else just took that slot. Pick another one.",
    "not-reservable": "That slot can't be reserved.",
    "too-late": "That reservation has already started, so it can't be cancelled.",
    "check-in-closed": "Check-in opens " + CHECK_IN_EARLY_MINUTES + " minutes before your slot and closes when it ends.",
    "unknown": "Something went wrong. Please try again."
  };

  function messageFor(error) {
    return MESSAGES[error && error.code] || MESSAGES.unknown;
  }

  // ---------- Elements ----------
  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(className, text) {
    var node = el("button", className, text);
    node.type = "button";
    return node;
  }

  var gate = byId("booking-gate");
  var gateTitle = byId("booking-gate-title");
  var gateButtons = gate.querySelectorAll("[data-gate-view]");
  var signupForm = byId("signup-form");
  var loginForm = byId("login-form");
  var app = byId("booking-app");
  var appTitle = byId("booking-title");
  var userName = byId("booking-user");
  var dayPicker = byId("booking-days");
  var heading = byId("booking-heading");
  var subheading = byId("booking-subheading");
  var note = byId("booking-note");
  var timesRow = byId("booking-times");
  var spacesList = byId("booking-spaces");
  var emptyLine = byId("booking-empty");
  var mineTitle = byId("booking-mine-title");
  var mineList = byId("booking-mine");
  var mineEmpty = byId("booking-mine-empty");
  var dialog = byId("booking-dialog");
  var dialogTitle = byId("booking-dialog-title");
  var dialogFacts = byId("booking-dialog-facts");
  var dialogNote = byId("booking-dialog-note");
  var dialogConfirm = byId("booking-dialog-confirm");
  var dialogDismiss = byId("booking-dialog-dismiss");
  var toastRegion = byId("booking-toast");

  var state = {
    user: null,
    venueId: VENUES[0].id,
    dateKey: toKey(new Date()),
    taken: {},
    mine: []
  };

  // ---------- Sign-up wall ----------
  function showGateView(view) {
    signupForm.hidden = view !== "signup";
    loginForm.hidden = view !== "login";
    for (var i = 0; i < gateButtons.length; i++) {
      var pressed = gateButtons[i].getAttribute("data-gate-view") === view;
      gateButtons[i].setAttribute("aria-pressed", pressed ? "true" : "false");
    }
  }

  for (var g = 0; g < gateButtons.length; g++) {
    gateButtons[g].addEventListener("click", function () {
      showGateView(this.getAttribute("data-gate-view"));
    });
  }

  function setFieldError(input, message) {
    var error = byId(input.id + "-error");
    if (message) {
      input.setAttribute("aria-invalid", "true");
    } else {
      input.removeAttribute("aria-invalid");
    }
    error.textContent = message || "";
    error.hidden = !message;
  }

  function setFormStatus(form, message) {
    var status = form.querySelector(".form-status");
    status.textContent = message || "";
    status.hidden = !message;
  }

  // validators: { fieldName: function (value) -> error message or "" }
  // submit: function (values) -> promise of the signed-in user
  function wireForm(form, validators, submit) {
    var names = Object.keys(validators);
    var submitButton = form.querySelector("button[type=submit]");

    names.forEach(function (name) {
      form.elements[name].addEventListener("input", function () {
        setFieldError(this, "");
      });
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      setFormStatus(form, "");

      var values = {};
      var firstInvalid = null;
      names.forEach(function (name) {
        var input = form.elements[name];
        values[name] = input.type === "password" ? input.value : input.value.trim();
        var message = validators[name](values[name]);
        setFieldError(input, message);
        if (message && !firstInvalid) firstInvalid = input;
      });
      if (firstInvalid) {
        firstInvalid.focus();
        return;
      }

      submitButton.disabled = true;
      submit(values).then(function (user) {
        form.reset();
        signIn(user);
      }).catch(function (error) {
        setFormStatus(form, messageFor(error));
      }).then(function () {
        submitButton.disabled = false;
      });
    });
  }

  wireForm(signupForm, {
    name: function (value) {
      return value ? "" : "Enter your name.";
    },
    studentId: function (value) {
      return /^\d{9}$/.test(value) ? "" : "Enter your 9-digit RedID.";
    },
    email: function (value) {
      return /^[^\s@]+@sdsu\.edu$/i.test(value) ? "" : "Enter your @sdsu.edu email address.";
    },
    password: function (value) {
      return value.length >= 8 ? "" : "Use at least 8 characters.";
    }
  }, function (values) {
    values.email = values.email.toLowerCase();
    return api.signUp(values);
  });

  wireForm(loginForm, {
    email: function (value) {
      return value ? "" : "Enter your email address.";
    },
    password: function (value) {
      return value ? "" : "Enter your password.";
    }
  }, function (values) {
    return api.logIn(values.email.toLowerCase(), values.password);
  });

  function signIn(user) {
    state.user = user;
    write(SESSION_KEY, user);
    showApp().then(function () {
      appTitle.focus();
    });
  }

  function signOut() {
    state.user = null;
    write(SESSION_KEY, null);
    toast("");
    app.hidden = true;
    gate.hidden = false;
    showGateView("login");
    gateTitle.focus();
  }

  function showApp() {
    gate.hidden = true;
    app.hidden = false;
    userName.textContent = state.user.name;
    return refresh();
  }

  // ---------- Dropdown ----------
  // A listbox styled to match the site, in place of a native <select>.
  // items: [{ value, label, detail }]. Returns { set: function (value) }.
  function createSelect(container, items, onChange) {
    var trigger = container.querySelector(".select-trigger");
    var valueLabel = container.querySelector(".select-value");
    var menu = container.querySelector(".select-menu");
    var options = [];
    var selected = 0;
    var active = 0;

    function setActive(index, scroll) {
      active = Math.max(0, Math.min(items.length - 1, index));
      options.forEach(function (option, i) {
        option.classList.toggle("is-active", i === active);
      });
      menu.setAttribute("aria-activedescendant", options[active].id);
      if (scroll) options[active].scrollIntoView({ block: "nearest" });
    }

    function select(index) {
      selected = index;
      valueLabel.textContent = items[index].label;
      options.forEach(function (option, i) {
        option.setAttribute("aria-selected", i === index ? "true" : "false");
      });
    }

    function open() {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      setActive(selected, true);
      menu.focus();
    }

    function close(returnFocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      if (returnFocus) trigger.focus();
    }

    function choose(index) {
      var changed = index !== selected;
      select(index);
      close(true);
      if (changed) onChange(items[index].value);
    }

    items.forEach(function (item, index) {
      var option = el("li", "select-option");
      option.id = menu.id + "-" + index;
      option.setAttribute("role", "option");
      option.appendChild(el("strong", "", item.label));
      option.appendChild(el("small", "", item.detail));
      option.addEventListener("click", function () {
        choose(index);
      });
      option.addEventListener("mousemove", function () {
        if (active !== index) setActive(index, false);
      });
      menu.appendChild(option);
      options.push(option);
    });

    trigger.addEventListener("click", function () {
      if (menu.hidden) {
        open();
      } else {
        close(true);
      }
    });

    trigger.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        open();
      }
    });

    menu.addEventListener("keydown", function (event) {
      var key = event.key;
      if (key === "Tab") {
        close(false);
        return;
      }
      if (key === "ArrowDown") setActive(active + 1, true);
      else if (key === "ArrowUp") setActive(active - 1, true);
      else if (key === "Home") setActive(0, true);
      else if (key === "End") setActive(items.length - 1, true);
      else if (key === "Enter" || key === " ") choose(active);
      else if (key === "Escape") close(true);
      else return;
      event.preventDefault();
    });

    document.addEventListener("pointerdown", function (event) {
      if (!container.contains(event.target)) close(false);
    });

    select(0);
    return {
      set: function (value) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].value === value) select(i);
        }
      }
    };
  }

  // ---------- Toast ----------
  var toastTimer = null;

  function toast(message, isError) {
    clearTimeout(toastTimer);
    toastRegion.textContent = "";
    if (!message) return;

    var box = el("div", "toast" + (isError ? " is-error" : ""));
    box.appendChild(el("p", "", message));
    var close = button("toast-close", "×");
    close.setAttribute("aria-label", "Dismiss message");
    close.addEventListener("click", function () {
      toast("");
    });
    box.appendChild(close);
    toastRegion.appendChild(box);
    toastTimer = setTimeout(function () {
      toast("");
    }, isError ? 10000 : 6000);
  }

  // ---------- Schedule ----------
  function currentVenue() {
    for (var i = 0; i < VENUES.length; i++) {
      if (VENUES[i].id === state.venueId) return VENUES[i];
    }
    return VENUES[0];
  }

  function refresh() {
    var user = state.user;
    if (!inBookingRange(state.dateKey)) state.dateKey = toKey(new Date());
    return Promise.all([
      api.getDay(state.dateKey),
      api.listReservations(user.studentId)
    ]).then(function (results) {
      if (state.user !== user) return;
      state.taken = results[0];
      state.mine = results[1];
      renderDays();
      renderSchedule();
      renderMine();
    });
  }

  function reservationOn(dateKey) {
    for (var i = 0; i < state.mine.length; i++) {
      if (state.mine[i].date === dateKey) return state.mine[i];
    }
    return null;
  }

  function describe(reservation) {
    var space = spaceIndex[reservation.facilityId];
    return space.name + ", " + formatDate(reservation.date) + ", " + formatSlot(reservation.slot);
  }

  function slotSelector(spaceId, slot) {
    return '.slot[data-key="' + slotKey(spaceId, slot) + '"] button';
  }

  function renderDays() {
    var today = toKey(new Date());
    dayPicker.textContent = "";
    for (var i = 0; i < DAYS_AHEAD; i++) {
      var dateKey = addDays(today, i);
      var date = fromKey(dateKey);
      var booked = !!reservationOn(dateKey);
      var day = button(booked ? "has-reservation" : "");
      day.setAttribute("data-date", dateKey);
      day.setAttribute("aria-pressed", dateKey === state.dateKey ? "true" : "false");
      day.setAttribute("aria-label", formatDate(dateKey) + (i === 0 ? ", today" : "") + (booked ? ", you have a reservation" : ""));
      day.appendChild(el("strong", "", i === 0 ? "Today" : DAY_NAMES[date.getDay()].slice(0, 3)));
      day.appendChild(el("span", "", MONTH_NAMES[date.getMonth()].slice(0, 3) + " " + date.getDate()));
      dayPicker.appendChild(day);
    }

    var selected = dayPicker.querySelector('[aria-pressed="true"]');
    if (selected) {
      dayPicker.scrollLeft = selected.offsetLeft - (dayPicker.clientWidth - selected.offsetWidth) / 2;
    }
  }

  // What one slot shows: { kind, text, action, label }. Only slots a student
  // can act on get an action.
  function slotView(space, slot, dayReservation) {
    var dateKey = state.dateKey;
    if (!isOpen(space, dateKey, slot)) return { kind: "closed", text: "Closed" };

    var org = eventAt(space, dateKey, slot);
    if (org) return { kind: "event", text: "Event", detail: org };
    if (isWalkup(slot)) return { kind: "walkup", text: "Walk-up" };

    var started = hasStarted(dateKey, slot);
    var where = space.name + ", " + formatSlot(slot);
    if (dayReservation && dayReservation.facilityId === space.id && dayReservation.slot === slot) {
      if (started) return { kind: "mine", text: "Yours" };
      return {
        kind: "mine",
        text: "Yours",
        label: "cancel " + where,
        action: function () {
          confirmCancel(dayReservation, slotSelector(space.id, slot));
        }
      };
    }

    var left = space.spots - (state.taken[slotKey(space.id, slot)] || 0);
    if (left <= 0) return { kind: "booked", text: space.spots > 1 ? "Full" : "Booked" };
    if (started) return { kind: "closed", text: "Ended" };

    var text = space.spots > 1 ? left + (left === 1 ? " spot" : " spots") : "Open";
    if (dayReservation) return { kind: "open is-locked", text: text };
    return {
      kind: "open",
      text: text,
      label: "reserve " + where,
      action: function () {
        confirmReserve(space, slot);
      }
    };
  }

  // "Volleyball Club, 5 pm to 9 pm" for each club event in the space that day.
  // Back-to-back slots held by the same club read as one event.
  function eventSummary(space, dateKey) {
    var runs = [];
    SLOTS.forEach(function (slot) {
      var org = isOpen(space, dateKey, slot) && eventAt(space, dateKey, slot);
      var last = runs[runs.length - 1];
      if (!org) return;
      if (last && last.org === org && last.end === slot) {
        last.end = slot + SLOT_HOURS;
      } else {
        runs.push({ org: org, start: slot, end: slot + SLOT_HOURS });
      }
    });
    return runs.map(function (run) {
      return run.org + ", " + formatHour(run.start) + " to " + formatHour(run.end);
    }).join(" · ");
  }

  function buildSlot(space, slot, dayReservation) {
    var view = slotView(space, slot, dayReservation);
    var item = el("li", "slot " + view.kind);
    item.setAttribute("data-key", slotKey(space.id, slot));

    var body = view.action ? button("slot-body") : el("div", "slot-body");
    if (view.action) {
      body.setAttribute("aria-label", formatHour(slot) + ", " + view.text + ": " + view.label);
      body.addEventListener("click", view.action);
    }
    body.title = formatSlot(slot) + ": " + (view.detail || view.text);
    body.appendChild(el("span", "slot-time", formatHour(slot)));
    body.appendChild(el("span", "slot-state", view.text));
    item.appendChild(body);
    return item;
  }

  function renderSchedule() {
    var venue = currentVenue();
    var dateKey = state.dateKey;
    var dayName = DAY_NAMES[fromKey(dateKey).getDay()];
    var dayReservation = reservationOn(dateKey);

    heading.textContent = venue.name;
    subheading.textContent = formatDate(dateKey) + " · " + venue.location;

    timesRow.textContent = "";
    timesRow.appendChild(el("span", "", "Space"));
    var times = el("div", "times");
    SLOTS.forEach(function (slot) {
      times.appendChild(el("span", "", formatHour(slot)));
    });
    timesRow.appendChild(times);

    var anyOpen = false;
    spacesList.textContent = "";
    venue.spaces.forEach(function (space) {
      var row = el("li", "space");
      var info = el("div", "space-info");
      info.appendChild(el("strong", "", space.name));
      info.appendChild(el("span", "", space.detail));
      var events = eventSummary(space, dateKey);
      if (events) info.appendChild(el("em", "", events));
      row.appendChild(info);

      var openToday = SLOTS.some(function (slot) {
        return isOpen(space, dateKey, slot);
      });
      if (openToday) {
        anyOpen = true;
        var slots = el("ul", "slots");
        SLOTS.forEach(function (slot) {
          slots.appendChild(buildSlot(space, slot, dayReservation));
        });
        row.appendChild(slots);
      } else {
        row.appendChild(el("p", "space-closed", "Closed on " + dayName));
      }
      spacesList.appendChild(row);
    });

    // A venue that is shut all day gets one line instead of a row per space.
    timesRow.hidden = !anyOpen;
    spacesList.hidden = !anyOpen;
    emptyLine.hidden = anyOpen;
    emptyLine.textContent = anyOpen ? "" : venue.name + " is closed on " + dayName + ". Pick another day or facility.";

    var notes = [];
    if (dayReservation) notes.push("You've used your one reservation for " + dayName + ": " + spaceIndex[dayReservation.facilityId].name + ", " + formatSlot(dayReservation.slot) + ". Cancel it to pick a different slot.");
    if (isWeekend(dateKey)) notes.push("Weekend reservations carry a small fee.");
    note.textContent = notes.join(" ");
    note.hidden = !notes.length;
  }

  function renderMine() {
    var cutoff = addDays(toKey(new Date()), -HISTORY_DAYS);
    var labels = { "booked": "Booked", "checked-in": "Checked in", "no-show": "No-show" };
    var shown = state.mine.filter(function (reservation) {
      return reservation.date >= cutoff && spaceIndex[reservation.facilityId];
    }).sort(function (a, b) {
      return a.date === b.date ? a.slot - b.slot : (a.date < b.date ? -1 : 1);
    });

    mineList.textContent = "";
    mineEmpty.hidden = shown.length > 0;

    shown.forEach(function (reservation) {
      var space = spaceIndex[reservation.facilityId];
      var status = statusOf(reservation);
      var item = el("li");
      item.setAttribute("data-reservation", reservation.id);

      var what = el("div", "what");
      var title = el("strong", "", space.name);
      title.appendChild(el("span", "badge " + status, labels[status]));
      what.appendChild(title);
      what.appendChild(el("span", "", formatDate(reservation.date) + ", " + formatSlot(reservation.slot)));
      what.appendChild(el("span", "", space.venue.name + " · " + space.venue.location));
      item.appendChild(what);

      var actions = el("div", "actions");
      if (status === "booked" && canCheckIn(reservation)) {
        var checkIn = button("btn btn-sm btn-light", "Check in");
        checkIn.setAttribute("aria-label", "Check in: " + describe(reservation));
        checkIn.addEventListener("click", function () {
          run(api.checkIn(state.user.studentId, reservation.id), "Checked in: " + describe(reservation) + ".");
        });
        actions.appendChild(checkIn);
      }
      if (status === "booked" && !hasStarted(reservation.date, reservation.slot)) {
        var cancel = button("btn btn-sm btn-light", "Cancel");
        cancel.setAttribute("aria-label", "Cancel: " + describe(reservation));
        cancel.addEventListener("click", function () {
          confirmCancel(reservation);
        });
        actions.appendChild(cancel);
      }
      if (actions.childNodes.length) item.appendChild(actions);
      mineList.appendChild(item);
    });
  }

  // Runs a change, reports how it went, then redraws. The control that started
  // it has been replaced by then, so focus moves to focusSelector if it is on
  // screen, or to the "Your reservations" heading.
  function run(change, successMessage, focusSelector) {
    return change.then(function () {
      toast(successMessage);
    }).catch(function (error) {
      toast(messageFor(error), true);
    }).then(refresh).then(function () {
      var target = focusSelector && app.querySelector(focusSelector);
      (target || mineTitle).focus({ preventScroll: !target });
    });
  }

  // ---------- Confirm dialog ----------
  var pendingAction = null;

  function closeDialog() {
    pendingAction = null;
    if (dialog.close) {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }

  // options: { title, facts: [[term, detail]], note, confirm, dismiss, action }
  function confirmWith(options) {
    dialogTitle.textContent = options.title;
    dialogFacts.textContent = "";
    options.facts.forEach(function (fact) {
      var row = el("div");
      row.appendChild(el("dt", "", fact[0]));
      row.appendChild(el("dd", "", fact[1]));
      dialogFacts.appendChild(row);
    });
    dialogNote.textContent = options.note;
    dialogConfirm.textContent = options.confirm;
    dialogDismiss.textContent = options.dismiss;
    pendingAction = options.action;
    if (dialog.showModal) {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  function factsFor(space, dateKey, slot) {
    return [
      ["Space", space.name + " (" + space.detail + ")"],
      ["When", formatDate(dateKey) + ", " + formatSlot(slot)],
      ["Where", space.venue.name + ", " + space.venue.location]
    ];
  }

  dialogConfirm.addEventListener("click", function () {
    var action = pendingAction;
    closeDialog();
    if (action) action();
  });

  dialogDismiss.addEventListener("click", closeDialog);

  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) closeDialog();
  });

  function confirmReserve(space, slot) {
    var dateKey = state.dateKey;
    var fee = isWeekend(dateKey)
      ? "Weekend reservations carry a small fee. Payments aren't set up yet, so nothing is charged."
      : "Weekday reservations are free.";
    confirmWith({
      title: "Reserve this space?",
      facts: factsFor(space, dateKey, slot),
      note: fee + " This is your one reservation for the day. Check in when you arrive or it counts as a no-show.",
      confirm: "Reserve",
      dismiss: "Not now",
      action: function () {
        run(
          api.reserve(state.user.studentId, space.id, dateKey, slot),
          "Reserved: " + space.name + ", " + formatDate(dateKey) + ", " + formatSlot(slot) + ".",
          slotSelector(space.id, slot)
        );
      }
    });
  }

  function confirmCancel(reservation, focusSelector) {
    confirmWith({
      title: "Cancel this reservation?",
      facts: factsFor(spaceIndex[reservation.facilityId], reservation.date, reservation.slot),
      note: "The slot opens up for other students, and you can book a different one that day.",
      confirm: "Cancel reservation",
      dismiss: "Keep it",
      action: function () {
        run(api.cancel(state.user.studentId, reservation.id), "Cancelled: " + describe(reservation) + ".", focusSelector);
      }
    });
  }

  // ---------- Controls ----------
  createSelect(byId("booking-venue"), VENUES.map(function (venue) {
    var count = venue.spaces.length;
    return {
      value: venue.id,
      label: venue.name,
      detail: count + (count === 1 ? " space" : " spaces") + " · " + venue.location
    };
  }), function (venueId) {
    state.venueId = venueId;
    renderSchedule();
  });

  dayPicker.addEventListener("click", function (event) {
    var day = event.target.closest("button[data-date]");
    if (!day) return;
    var dateKey = day.getAttribute("data-date");
    state.dateKey = dateKey;
    refresh().then(function () {
      var selected = dayPicker.querySelector('[data-date="' + dateKey + '"]');
      if (selected) selected.focus();
    });
  });

  byId("booking-logout").addEventListener("click", signOut);

  // ---------- Start ----------
  var saved = read(SESSION_KEY, null);
  if (saved && saved.studentId) {
    state.user = saved;
    showApp();
  }
})();
