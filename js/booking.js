// Court booking (home page)
//
// Accounts, reservations and club events live in the Cloudflare D1 database,
// reached through the Worker in api/. Everything that reads or writes data
// goes through `api` below. Only the signed-in session is kept in the browser.
(function () {
  var root = document.getElementById("booking");
  if (!root) return;

  // ---------- API ----------
  // The Cloudflare Worker in api/ that talks to the D1 database. Running the
  // site from localhost uses `npm run dev` in api/ instead.
  var LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var API_BASE = LOCAL ? "http://localhost:8787" : "https://courtconnect-api.hudsonmitchell58.workers.dev";

  // ---------- Facilities and booking rules ----------
  // Shared with the API and the seed script, in js/facilities.js.
  var shared = window.CourtConnectFacilities;
  var SLOTS = shared.SLOTS;
  var SLOT_HOURS = shared.SLOT_HOURS;
  var DAYS_AHEAD = shared.DAYS_AHEAD;
  var HISTORY_DAYS = shared.HISTORY_DAYS;
  var CHECK_IN_EARLY_MINUTES = shared.CHECK_IN_EARLY_MINUTES;
  var VENUES = shared.VENUES;

  var spaceIndex = {};
  VENUES.forEach(function (venue) {
    venue.spaces.forEach(function (space) {
      space.venue = venue;
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

  // "4:58 pm" for a Date
  function formatTime(date) {
    var hour = date.getHours();
    return (hour % 12 || 12) + ":" + pad(date.getMinutes()) + (hour < 12 ? " am" : " pm");
  }

  function formatSlot(slot) {
    return formatHour(slot) + " to " + formatHour(slot + SLOT_HOURS);
  }

  function formatDate(dateKey) {
    var date = fromKey(dateKey);
    return DAY_NAMES[date.getDay()] + ", " + MONTH_NAMES[date.getMonth()] + " " + date.getDate();
  }

  function isOpen(space, dateKey, slot) {
    var hours = space.hours[fromKey(dateKey).getDay()];
    return !!hours && slot >= hours[0] && slot + SLOT_HOURS <= hours[1];
  }

  function isWalkup(slot) {
    return shared.isWalkup(slot);
  }

  function hasStarted(dateKey, slot) {
    return new Date() >= slotStart(dateKey, slot);
  }

  function inBookingRange(dateKey) {
    var today = toKey(new Date());
    return dateKey >= today && dateKey < addDays(today, DAYS_AHEAD);
  }

  // The club holding the slot, from the events the API sent for that day.
  function eventAt(space, dateKey, slot) {
    if (dateKey !== state.eventsDate) return null;
    return state.events[slotKey(space.id, slot)] || null;
  }

  function checkInOpens(reservation) {
    var opens = slotStart(reservation.date, reservation.slot);
    opens.setMinutes(opens.getMinutes() - CHECK_IN_EARLY_MINUTES);
    return opens;
  }

  function canCheckIn(reservation) {
    var now = new Date();
    return now >= checkInOpens(reservation) && now < slotEnd(reservation.date, reservation.slot);
  }

  // A booking that ends without a check-in reads as a no-show here, even
  // before the database marks it no-show.
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

  // ---------- Data access ----------
  // Every method returns a promise. Failures reject with an Error whose `code`
  // is a key of MESSAGES; the API sends the same codes.
  function fail(code) {
    var error = new Error(code);
    error.code = code;
    return Promise.reject(error);
  }

  function request(method, path, body) {
    var headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (state.user && state.user.token) headers.Authorization = "Bearer " + state.user.token;
    return fetch(API_BASE + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).catch(function () {
      return fail("offline");
    }).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        if (response.ok) return data;
        return fail(data.error || "unknown");
      });
    });
  }

  // Signing up or logging in resolves with the user plus their session token.
  function withToken(data) {
    var user = data.user;
    user.token = data.token;
    return user;
  }

  // The API reads the student from the session token, so the studentId
  // arguments below are only kept so the callers don't change.
  var api = {
    // account: { name, studentId, email, password }
    signUp: function (account) {
      return request("POST", "/api/signup", account).then(withToken);
    },

    logIn: function (email, password) {
      return request("POST", "/api/login", { email: email, password: password }).then(withToken);
    },

    // { taken: { slotKey: students holding it }, events: { slotKey: club } }
    getDay: function (dateKey) {
      return request("GET", "/api/day?date=" + encodeURIComponent(dateKey));
    },

    listReservations: function (studentId) {
      return request("GET", "/api/reservations");
    },

    reserve: function (studentId, spaceId, dateKey, slot) {
      return request("POST", "/api/reservations", { spaceId: spaceId, date: dateKey, slot: slot });
    },

    cancel: function (studentId, reservationId) {
      return request("POST", "/api/reservations/" + encodeURIComponent(reservationId) + "/cancel");
    },

    checkIn: function (studentId, reservationId) {
      return request("POST", "/api/reservations/" + encodeURIComponent(reservationId) + "/check-in");
    }
  };

  var MESSAGES = {
    "bad-credentials": "That email and password don't match an account.",
    "email-taken": "There's already an account with that email. Log in instead.",
    "redid-taken": "There's already an account with that RedID. Log in instead.",
    "bad-request": "Check the form and try again.",
    "too-many-attempts": "Too many tries. Wait a minute, then try again.",
    "signed-out": "Your session has ended. Please log in again.",
    "suspended": "Your account can't make reservations right now because of missed check-ins.",
    "daily-limit": "You already have a reservation that day. Students can hold one per day.",
    "slot-taken": "Someone else just took that slot. Pick another one.",
    "not-reservable": "That slot can't be reserved.",
    "too-late": "That reservation has already started, so it can't be cancelled.",
    "check-in-closed": "Check-in opens " + CHECK_IN_EARLY_MINUTES + " minutes before your slot and closes when it ends.",
    "offline": "Can't reach CourtConnect right now. Check your connection and try again.",
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
  var nextCard = byId("booking-next");

  var state = {
    user: null,
    venueId: VENUES[0].id,
    dateKey: toKey(new Date()),
    taken: {},
    events: {},
    eventsDate: null,
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

  // message: shown on the log-in form, e.g. when the session has expired.
  function signOut(message) {
    state.user = null;
    write(SESSION_KEY, null);
    toast("");
    app.hidden = true;
    gate.hidden = false;
    showGateView("login");
    setFormStatus(loginForm, typeof message === "string" ? message : "");
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
      state.taken = results[0].taken;
      state.events = results[0].events;
      state.eventsDate = state.dateKey;
      state.mine = results[1];
      renderNext();
      renderDays();
      renderSchedule();
      renderMine();
    }).catch(function (error) {
      if (state.user !== user) return;
      if (error && error.code === "signed-out") {
        signOut(messageFor(error));
      } else {
        toast(messageFor(error), true);
      }
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
    if (dayReservation) notes.push("You've used your one reservation for " + dayName + ": " + spaceIndex[dayReservation.facilityId].name + ", " + formatSlot(dayReservation.slot) + ". Cancel it to pick a different slot.");    note.textContent = notes.join(" ");
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
      if (status === "checked-in" && reservation.checkInTime) {
        what.appendChild(el("span", "", "Checked in at " + formatTime(new Date(reservation.checkInTime))));
      }
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

  // ---------- Next reservation (check-in card) ----------
  // The card at the top of the app. It shows the student's next reservation
  // that hasn't ended, counts down to check-in, and turns into a Check in
  // button once check-in opens, so nobody has to scroll down at the court.
  var renderedNext = ""; // "reservationId|phase" of what the card is showing

  function nextReservation() {
    var now = new Date();
    var next = null;
    state.mine.forEach(function (reservation) {
      var status = statusOf(reservation);
      if ((status !== "booked" && status !== "checked-in") || !spaceIndex[reservation.facilityId]) return;
      if (slotEnd(reservation.date, reservation.slot) <= now) return;
      if (!next || reservation.date < next.date || (reservation.date === next.date && reservation.slot < next.slot)) {
        next = reservation;
      }
    });
    return next;
  }

  // later: check-in hasn't opened. open: student can check in now.
  function phaseOf(reservation) {
    if (reservation.status === "checked-in") return "checked-in";
    return canCheckIn(reservation) ? "open" : "later";
  }

  // "45 min" or "2 h 15 min"
  function formatWait(ms) {
    var minutes = Math.max(1, Math.ceil(ms / 60000));
    if (minutes < 60) return minutes + " min";
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return hours + " h" + (rest ? " " + rest + " min" : "");
  }

  function relativeDay(dateKey) {
    var today = toKey(new Date());
    if (dateKey === today) return "Today";
    if (dateKey === addDays(today, 1)) return "Tomorrow";
    return formatDate(dateKey);
  }

  function nextStatus(reservation, phase) {
    var now = new Date();
    if (phase === "checked-in") {
      var when = reservation.checkInTime ? "Checked in at " + formatTime(new Date(reservation.checkInTime)) : "You're checked in";
      return when + ". Your slot ends at " + formatHour(reservation.slot + SLOT_HOURS) + ".";
    }
    if (phase === "open") {
      return "Check-in is open for " + formatWait(slotEnd(reservation.date, reservation.slot) - now) +
        " more. If you don't check in, it counts as a no-show.";
    }
    var opens = checkInOpens(reservation);
    if (opens - now > 24 * 60 * 60 * 1000) {
      return "Check-in opens " + formatDate(toKey(opens)) + " at " + formatTime(opens) + ".";
    }
    return "Check-in opens in " + formatWait(opens - now) + ", at " + formatTime(opens) + ".";
  }

  function renderNext() {
    var reservation = nextReservation();
    nextCard.textContent = "";
    if (!reservation) {
      nextCard.hidden = true;
      renderedNext = "";
      return;
    }

    var phase = phaseOf(reservation);
    var space = spaceIndex[reservation.facilityId];
    var titles = { "later": "Your next reservation", "open": "Time to check in", "checked-in": "You're checked in" };
    renderedNext = reservation.id + "|" + phase;
    nextCard.className = "next-up is-" + phase;
    nextCard.hidden = false;

    var info = el("div", "next-info");
    var title = el("h4", "", titles[phase]);
    title.id = "booking-next-title";
    title.tabIndex = -1;
    info.appendChild(title);
    info.appendChild(el("p", "next-space", space.name + " · " + space.detail));
    info.appendChild(el("p", "next-when", relativeDay(reservation.date) + ", " + formatSlot(reservation.slot) +
      " · " + space.venue.name + ", " + space.venue.location));
    var status = el("p", "next-status", nextStatus(reservation, phase));
    status.id = "booking-next-status";
    info.appendChild(status);
    nextCard.appendChild(info);

    if (phase === "open") {
      var checkIn = button("btn", "Check in");
      checkIn.setAttribute("aria-label", "Check in: " + describe(reservation));
      checkIn.addEventListener("click", function () {
        checkIn.disabled = true;
        run(api.checkIn(state.user.studentId, reservation.id), "Checked in: " + describe(reservation) + ".", "#booking-next-title");
      });
      nextCard.appendChild(checkIn);
    }
  }

  // Keeps the countdown current. When the card should change (check-in opens,
  // the slot ends), redraw everything so the schedule and list match it too.
  function tick() {
    if (!state.user || app.hidden) return;
    var reservation = nextReservation();
    var showing = reservation ? reservation.id + "|" + phaseOf(reservation) : "";
    if (showing !== renderedNext) {
      refresh();
    } else if (reservation) {
      byId("booking-next-status").textContent = nextStatus(reservation, phaseOf(reservation));
    }
  }

  setInterval(tick, 30000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) tick();
  });

  // Runs a change, reports how it went, then redraws. The control that started
  // it has been replaced by then, so focus moves to focusSelector if it is on
  // screen, or to the "Your reservations" heading.
  function run(change, successMessage, focusSelector) {
    return change.then(function () {
      toast(successMessage);
    }).catch(function (error) {
      toast(messageFor(error), true);
    }).then(refresh).then(function () {
      if (!state.user) return;
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
    confirmWith({
      title: "Reserve this space?",
      facts: factsFor(space, dateKey, slot),
      note: "This is your one reservation for the day. Check in when you arrive or it counts as a no-show.",
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

  byId("booking-logout").addEventListener("click", function () {
    signOut();
  });

  // ---------- Start ----------
  var saved = read(SESSION_KEY, null);
  if (saved && saved.token) {
    state.user = saved;
    showApp();
  }
})();
