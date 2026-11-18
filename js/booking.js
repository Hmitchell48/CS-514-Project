// Book a space (book.html)
//
// Sign-up, the safety quiz and the booking schedule. Accounts, reservations
// and club events live in the Cloudflare D1 database, reached through the
// Worker in api/. Everything that reads or writes data goes through `api`
// below. Only the signed-in session is kept in the browser.
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
  var QUIZ = shared.QUIZ;

  // The type filter. `words` are extra search terms for that type, so a search
  // for "soccer" finds the fields and "swim" finds the pools.
  var KINDS = [
    { id: "all", label: "All" },
    { id: "courts", label: "Courts", words: "court gym indoor hoops" },
    { id: "pools", label: "Pools", words: "pool swim swimming lap aquatics water" },
    { id: "fields", label: "Fields", words: "field turf outdoor soccer football frisbee spikeball lacrosse rugby" },
    { id: "climbing", label: "Climbing", words: "climb climbing wall boulder bouldering" },
    { id: "studios", label: "Studios", words: "studio dance yoga mat group fitness" },
    { id: "lanes", label: "Bowling & table tennis", words: "bowl bowling lane ping pong" }
  ];
  var KIND_WORDS = {};
  KINDS.forEach(function (kind) {
    KIND_WORDS[kind.id] = kind.words || "";
  });

  var spaceIndex = {};
  VENUES.forEach(function (venue) {
    venue.spaces.forEach(function (space) {
      space.venue = venue;
      space.spots = space.spots || 1;
      space.hours = space.hours || venue.hours;
      space.search = [space.name, space.detail, venue.name, KIND_WORDS[space.kind]].join(" ").toLowerCase();
      spaceIndex[space.id] = space;
    });
  });
  var SPACE_COUNT = Object.keys(spaceIndex).length;

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
    var whole = Math.floor(hour) % 24;
    var minutes = Math.round((hour - Math.floor(hour)) * 60);
    return (whole % 12 || 12) + (minutes ? ":" + pad(minutes) : "") + (whole < 12 ? " am" : " pm");
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

  function hoursOn(space, dateKey) {
    return space.hours[fromKey(dateKey).getDay()];
  }

  function isOpen(space, dateKey, slot) {
    var hours = hoursOn(space, dateKey);
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

  function checkInOpens(reservation) {
    var opens = slotStart(reservation.date, reservation.slot);
    opens.setMinutes(opens.getMinutes() - CHECK_IN_EARLY_MINUTES);
    return opens;
  }

  function canCheckIn(reservation) {
    var now = new Date();
    return now >= checkInOpens(reservation) && now < slotEnd(reservation.date, reservation.slot);
  }

  // A booking that ends without a check-in reads as a no-show.
  function statusOf(reservation) {
    if (reservation.status === "booked" && new Date() >= slotEnd(reservation.date, reservation.slot)) {
      return "no-show";
    }
    return reservation.status;
  }

  function slotKey(spaceId, slot) {
    return spaceId + "|" + slot;
  }

  // ---------- Browser storage ----------
  // Only the session ({ user, token }) is kept in the browser.
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
  function failure(code, extra) {
    var error = new Error(code);
    error.code = code;
    if (extra) {
      Object.keys(extra).forEach(function (key) {
        error[key] = extra[key];
      });
    }
    return error;
  }

  // { user, token } while signed in. The token is the only proof of who the
  // student is; the API never trusts a user ID sent by the page.
  var session = null;

  function request(method, path, body) {
    var headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (session && session.token) headers.Authorization = "Bearer " + session.token;
    return fetch(API_BASE + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).catch(function () {
      throw failure("offline");
    }).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        if (response.ok) return data;
        throw failure(data.error || "unknown", { wrong: data.wrong });
      });
    });
  }

  // Which sign-up field an error belongs to, so it shows under that field.
  var ERROR_FIELDS = { "email-taken": "email", "redid-taken": "redId" };

  var api = {
    // account: { name, redId, email, password }. Resolves with { user, token }.
    signUp: function (account) {
      return request("POST", "/api/signup", {
        name: account.name,
        studentId: account.redId,
        email: account.email,
        password: account.password
      }).catch(function (error) {
        error.field = ERROR_FIELDS[error.code];
        throw error;
      });
    },

    logIn: function (email, password) {
      return request("POST", "/api/login", { email: email, password: password });
    },

    // Tokens expire on their own; logging out just forgets this one.
    logOut: function () {
      return Promise.resolve();
    },

    // The questions, without the answers.
    getQuiz: function () {
      return Promise.resolve(QUIZ.map(function (item) {
        return { question: item.question, options: item.options };
      }));
    },

    // answers: one option index per question. Resolves with { user }, or
    // rejects with `wrong` (question indexes).
    submitQuiz: function (user, answers) {
      return request("POST", "/api/quiz", { answers: answers });
    },

    // { taken: { slotKey: students holding it }, events: { slotKey: club } }
    getDay: function (dateKey) {
      return request("GET", "/api/day?date=" + encodeURIComponent(dateKey));
    },

    listReservations: function () {
      return request("GET", "/api/reservations");
    },

    reserve: function (user, spaceId, dateKey, slot) {
      return request("POST", "/api/reservations", { spaceId: spaceId, date: dateKey, slot: slot });
    },

    cancel: function (user, reservationId) {
      return request("POST", "/api/reservations/" + encodeURIComponent(reservationId) + "/cancel");
    },

    checkIn: function (user, reservationId) {
      return request("POST", "/api/reservations/" + encodeURIComponent(reservationId) + "/check-in");
    }
  };

  var MESSAGES = {
    "bad-credentials": "That email and password don't match an account.",
    "email-taken": "There's already an account with that email. Log in instead.",
    "redid-taken": "There's already an account with that RedID.",
    "quiz-failed": "Not quite. Check the highlighted questions and try again.",
    "quiz-required": "Pass the safety quiz before you book.",
    "daily-limit": "You already have a reservation that day. Students can hold one per day.",
    "slot-taken": "Someone else just took that slot. Pick another one.",
    "not-reservable": "That slot can't be reserved.",
    "suspended": "You missed a check-in, so booking is locked for " + shared.LOCKOUT_DAYS + " days. You can still check in and cancel.",
    "banned": "Your account can no longer book after three no-shows.",
    "too-late": "That reservation has already started, so it can't be cancelled.",
    "check-in-closed": "Check-in opens " + CHECK_IN_EARLY_MINUTES + " minutes before your slot and closes when it ends.",
    "bad-request": "Check the form and try again.",
    "too-many-attempts": "Too many tries. Wait a minute, then try again.",
    "signed-out": "Your session has ended. Please log in again.",
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
  var gateText = byId("booking-gate-text");
  var gateSwitch = byId("booking-switch");
  var gateButtons = gate.querySelectorAll("[data-gate-view]");
  var steps = byId("booking-steps");
  var signupForm = byId("signup-form");
  var loginForm = byId("login-form");
  var quizForm = byId("quiz-form");
  var quizQuestions = byId("quiz-questions");
  var app = byId("booking-app");
  var appTitle = byId("booking-title");
  var userName = byId("booking-user");
  var searchInput = byId("booking-search");
  var venueList = byId("booking-venues");
  var kindChips = byId("booking-kinds");
  var openOnly = byId("booking-open-only");
  var dayPicker = byId("booking-days");
  var heading = byId("booking-heading");
  var subheading = byId("booking-subheading");
  var results = byId("booking-results");
  var note = byId("booking-note");
  var timesRow = byId("booking-times");
  var spacesBox = byId("booking-spaces");
  var emptyBox = byId("booking-empty");
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
  var pickBox = byId("booking-pick");

  var state = {
    user: null,
    venueId: "all",
    kind: "all",
    query: "",
    openOnly: false,
    dateKey: toKey(new Date()),
    taken: {},
    events: {},
    mine: [],
    picked: null // { spaceId, slot, dateKey }: the open slot waiting to be locked in
  };

  // ---------- Sign-up, log-in and quiz ----------
  var GATE_COPY = {
    signup: {
      title: "Create your account",
      text: "CourtConnect is open to SDSU students. Sign up with your RedID and SDSU email, take a three-question safety quiz, and you're ready to book."
    },
    login: {
      title: "Welcome back",
      text: "Log in with your SDSU email to see the schedule and your reservations."
    },
    quiz: {
      title: "One quick safety quiz",
      text: "Every student passes this once before their first booking. It covers the three rules that keep spaces fair to share."
    }
  };

  function setStep(current) {
    var order = ["account", "quiz", "book"];
    var reached = order.indexOf(current);
    Array.prototype.forEach.call(steps.children, function (item) {
      var index = order.indexOf(item.getAttribute("data-step"));
      if (index === reached) {
        item.setAttribute("aria-current", "step");
      } else {
        item.removeAttribute("aria-current");
      }
      item.classList.toggle("is-done", index < reached);
    });
  }

  function showGate(view) {
    gate.hidden = false;
    app.hidden = true;
    signupForm.hidden = view !== "signup";
    loginForm.hidden = view !== "login";
    quizForm.hidden = view !== "quiz";
    gateSwitch.hidden = view === "quiz";
    gateTitle.textContent = GATE_COPY[view].title;
    gateText.textContent = GATE_COPY[view].text;
    setStep(view === "quiz" ? "quiz" : "account");
    for (var i = 0; i < gateButtons.length; i++) {
      var pressed = gateButtons[i].getAttribute("data-gate-view") === view;
      gateButtons[i].setAttribute("aria-pressed", pressed ? "true" : "false");
    }
    if (view === "quiz") loadQuiz();
  }

  for (var g = 0; g < gateButtons.length; g++) {
    gateButtons[g].addEventListener("click", function () {
      var view = this.getAttribute("data-gate-view");
      showGate(view);
      if (history.replaceState) history.replaceState(null, "", "#" + view);
    });
  }

  // Show / Hide on password fields
  Array.prototype.forEach.call(root.querySelectorAll("[data-reveal]"), function (toggle) {
    toggle.addEventListener("click", function () {
      var input = byId(toggle.getAttribute("data-reveal"));
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "Hide" : "Show";
      toggle.setAttribute("aria-pressed", show ? "true" : "false");
      input.focus();
    });
  });

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

  // validators: { fieldName: function (value, values) -> error message or "" }
  // submit: function (values) -> promise of { user, token }
  function wireForm(form, validators, submit) {
    var names = Object.keys(validators);
    var submitButton = form.querySelector("button[type=submit]");
    var idleLabel = submitButton.textContent;

    function valueOf(input) {
      if (input.type === "checkbox") return input.checked;
      return input.type === "password" ? input.value : input.value.trim();
    }

    names.forEach(function (name) {
      var input = form.elements[name];
      input.addEventListener(input.type === "checkbox" ? "change" : "input", function () {
        setFieldError(this, "");
      });
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      setFormStatus(form, "");

      var values = {};
      names.forEach(function (name) {
        values[name] = valueOf(form.elements[name]);
      });
      var firstInvalid = null;
      names.forEach(function (name) {
        var input = form.elements[name];
        var message = validators[name](values[name], values);
        setFieldError(input, message);
        if (message && !firstInvalid) firstInvalid = input;
      });
      if (firstInvalid) {
        firstInvalid.focus();
        return;
      }

      submitButton.disabled = true;
      submitButton.textContent = "One moment...";
      submit(values).then(function (session) {
        form.reset();
        startSession(session);
      }).catch(function (error) {
        var input = error.field && form.elements[error.field];
        if (input) {
          setFieldError(input, messageFor(error));
          input.focus();
        } else {
          setFormStatus(form, messageFor(error));
        }
      }).then(function () {
        submitButton.disabled = false;
        submitButton.textContent = idleLabel;
      });
    });
  }

  wireForm(signupForm, {
    name: function (value) {
      return value ? "" : "Enter your name.";
    },
    redId: function (value) {
      return /^\d{9}$/.test(value) ? "" : "Your RedID is the 9-digit number on your student ID.";
    },
    email: function (value) {
      return /^[^\s@]+@sdsu\.edu$/i.test(value) ? "" : "Use your @sdsu.edu email address.";
    },
    password: function (value) {
      return value.length >= 8 ? "" : "Use at least 8 characters.";
    },
    confirm: function (value, values) {
      if (!value) return "Type your password again.";
      return value === values.password ? "" : "The passwords don't match.";
    },
    rules: function (value) {
      return value ? "" : "Agree to the booking rules to continue.";
    }
  }, function (values) {
    return api.signUp({
      name: values.name,
      redId: values.redId,
      email: values.email.toLowerCase(),
      password: values.password
    });
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

  // The quiz is built from what the API returns, so the server can own the
  // questions once it is connected.
  var quizLoaded = false;

  function loadQuiz() {
    if (quizLoaded) return;
    api.getQuiz().then(function (questions) {
      quizLoaded = true;
      quizQuestions.textContent = "";
      questions.forEach(function (item, index) {
        var set = el("fieldset");
        set.setAttribute("data-question", index);
        set.appendChild(el("legend", "", (index + 1) + ". " + item.question));
        item.options.forEach(function (option, optionIndex) {
          var label = el("label", "quiz-option");
          var input = el("input");
          input.type = "radio";
          input.name = "q" + index;
          input.value = optionIndex;
          input.required = true;
          input.addEventListener("change", function () {
            Array.prototype.forEach.call(set.querySelectorAll(".quiz-option"), function (other) {
              other.classList.toggle("is-picked", other === label);
            });
            set.classList.remove("is-wrong");
            var feedback = set.querySelector(".quiz-feedback");
            if (feedback) feedback.remove();
          });
          label.appendChild(input);
          label.appendChild(el("span", "", option));
          set.appendChild(label);
        });
        quizQuestions.appendChild(set);
      });
    }).catch(function (error) {
      setFormStatus(quizForm, messageFor(error));
    });
  }

  quizForm.addEventListener("submit", function (event) {
    event.preventDefault();
    setFormStatus(quizForm, "");
    var sets = quizQuestions.querySelectorAll("fieldset");
    var answers = [];
    var firstMissing = null;
    Array.prototype.forEach.call(sets, function (set, index) {
      var picked = set.querySelector("input:checked");
      answers[index] = picked ? +picked.value : -1;
      if (!picked && !firstMissing) firstMissing = set.querySelector("input");
    });
    if (firstMissing) {
      setFormStatus(quizForm, "Answer all three questions.");
      firstMissing.focus();
      return;
    }

    var submitButton = quizForm.querySelector("button[type=submit]");
    submitButton.disabled = true;
    api.submitQuiz(state.user, answers).then(function (result) {
      state.user = result.user;
      saveSession();
      toast("Quiz passed. You're ready to book.");
      showApp(true);
    }).catch(function (error) {
      setFormStatus(quizForm, messageFor(error));
      (error.wrong || []).forEach(function (index) {
        var set = sets[index];
        set.classList.add("is-wrong");
        if (!set.querySelector(".quiz-feedback") && QUIZ[index]) {
          set.appendChild(el("p", "quiz-feedback", QUIZ[index].why));
        }
      });
      var first = error.wrong && sets[error.wrong[0]];
      if (first) first.querySelector("input:checked").focus();
    }).then(function () {
      submitButton.disabled = false;
    });
  });

  // ---------- Session ----------
  // The quiz is only shown when the API says it hasn't been passed. An API
  // version without the quiz sends no quizPassed at all, and students go
  // straight to booking.
  function needsQuiz(user) {
    return user.quizPassed === false;
  }

  function saveSession() {
    session.user = state.user;
    write(SESSION_KEY, session);
  }

  function startSession(result) {
    session = { user: result.user, token: result.token };
    state.user = result.user;
    write(SESSION_KEY, session);
    if (needsQuiz(state.user)) {
      showGate("quiz");
      gateTitle.focus();
      return;
    }
    showApp(true);
  }

  // message: shown on the log-in form, e.g. when the session has expired.
  function signOut(message) {
    api.logOut().catch(function () {});
    session = null;
    state.user = null;
    state.mine = [];
    write(SESSION_KEY, null);
    toast("");
    showGate("login");
    setFormStatus(loginForm, typeof message === "string" ? message : "");
    gateTitle.focus();
  }

  Array.prototype.forEach.call(root.querySelectorAll('[data-action="logout"]'), function (control) {
    control.addEventListener("click", function () {
      signOut();
    });
  });

  function showApp(focus) {
    gate.hidden = true;
    app.hidden = false;
    setStep("book");
    userName.textContent = state.user.name;
    return refresh().then(function () {
      if (focus) appTitle.focus();
    });
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

  // ---------- Loading data ----------
  function refresh() {
    var user = state.user;
    if (!inBookingRange(state.dateKey)) state.dateKey = toKey(new Date());
    if (!results.textContent) results.textContent = "Loading the schedule...";
    return Promise.all([
      api.getDay(state.dateKey),
      api.listReservations()
    ]).then(function (loaded) {
      if (state.user !== user) return;
      state.taken = loaded[0].taken;
      state.events = loaded[0].events;
      state.mine = loaded[1];
      render();
    }).catch(function (error) {
      if (state.user !== user) return;
      if (!error.code) console.error(error);
      if (error.code === "signed-out") {
        signOut(messageFor(error));
      } else {
        toast(messageFor(error), true);
      }
    });
  }

  function render() {
    renderNext();
    renderDays();
    renderVenues();
    renderSchedule();
    renderPick();
    renderMine();
  }

  // ---------- Filters ----------
  function queryWords() {
    return state.query.toLowerCase().split(/\s+/).filter(Boolean);
  }

  function matchesFilters(space, words) {
    if (state.venueId !== "all" && space.venue.id !== state.venueId) return false;
    if (state.kind !== "all" && space.kind !== state.kind) return false;
    return words.every(function (word) {
      return space.search.indexOf(word) !== -1;
    });
  }

  function hasOpenSlot(space, dayReservation) {
    return SLOTS.some(function (slot) {
      return slotView(space, slot, dayReservation).kind === "open";
    });
  }

  // Puts <mark> around the first search word found in `text`.
  function highlighted(tag, text, words) {
    var node = el(tag);
    var lower = text.toLowerCase();
    for (var i = 0; i < words.length; i++) {
      var at = lower.indexOf(words[i]);
      if (at !== -1) {
        node.appendChild(document.createTextNode(text.slice(0, at)));
        node.appendChild(el("mark", "", text.slice(at, at + words[i].length)));
        node.appendChild(document.createTextNode(text.slice(at + words[i].length)));
        return node;
      }
    }
    node.textContent = text;
    return node;
  }

  function clearFilters() {
    state.query = "";
    state.kind = "all";
    state.venueId = "all";
    state.openOnly = false;
    searchInput.value = "";
    openOnly.checked = false;
    renderVenues();
    renderKinds();
    renderSchedule();
  }

  // ---------- Schedule ----------
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

  // Open times left at a venue on the selected day, for the facilities list.
  function openCount(venue, dayReservation) {
    var count = 0;
    venue.spaces.forEach(function (space) {
      SLOTS.forEach(function (slot) {
        if (slotView(space, slot, dayReservation).kind.indexOf("open") === 0) count++;
      });
    });
    return count;
  }

  function renderVenues() {
    var dayReservation = reservationOn(state.dateKey);
    venueList.textContent = "";
    [{ id: "all", name: "All facilities" }].concat(VENUES).forEach(function (venue) {
      var item = el("li");
      var choice = button("venue-choice");
      choice.setAttribute("data-venue", venue.id);
      choice.setAttribute("aria-pressed", state.venueId === venue.id ? "true" : "false");
      choice.appendChild(el("strong", "", venue.name));
      if (venue.id === "all") {
        choice.appendChild(el("span", "", SPACE_COUNT + " spaces across campus"));
      } else {
        var hours = venue.hours[fromKey(state.dateKey).getDay()];
        var open = hours ? openCount(venue, dayReservation) : 0;
        choice.appendChild(el("span", "", hours
          ? formatHour(hours[0]) + " to " + formatHour(hours[1]) + " · " + open + (open === 1 ? " open time" : " open times")
          : "Closed " + DAY_NAMES[fromKey(state.dateKey).getDay()]));
        if (!hours) choice.classList.add("is-closed");
      }
      item.appendChild(choice);
      venueList.appendChild(item);
    });
  }

  function renderKinds() {
    var words = queryWords();
    kindChips.textContent = "";
    KINDS.forEach(function (kind) {
      var count = 0;
      Object.keys(spaceIndex).forEach(function (id) {
        var space = spaceIndex[id];
        var venueOk = state.venueId === "all" || space.venue.id === state.venueId;
        var kindOk = kind.id === "all" || space.kind === kind.id;
        if (venueOk && kindOk && words.every(function (w) { return space.search.indexOf(w) !== -1; })) count++;
      });
      if (kind.id !== "all" && !count && state.kind !== kind.id) return;
      var chip = button("", kind.label);
      chip.setAttribute("data-kind", kind.id);
      chip.setAttribute("aria-pressed", state.kind === kind.id ? "true" : "false");
      chip.appendChild(el("small", "", String(count)));
      kindChips.appendChild(chip);
    });
  }

  // What one slot shows: { kind, text, action, label }. Only slots a student
  // can act on get an action.
  function slotView(space, slot, dayReservation) {
    var dateKey = state.dateKey;
    var key = slotKey(space.id, slot);
    if (!isOpen(space, dateKey, slot)) return { kind: "closed", text: "Closed" };

    var org = state.events[key];
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

    var left = space.spots - (state.taken[key] || 0);
    if (left <= 0) return { kind: "booked", text: space.spots > 1 ? "Full" : "Taken" };
    if (started) return { kind: "closed", text: "Ended" };

    var text = space.spots > 1 ? left + " left" : "Open";
    if (dayReservation) return { kind: "open is-locked", text: text };
    var picked = isPicked(space.id, slot);
    return {
      kind: picked ? "open is-picked" : "open",
      text: picked ? "Picked" : text,
      label: (picked ? "picked, " : "pick ") + where,
      pressed: picked,
      action: function () {
        pickSlot(space, slot);
      }
    };
  }

  // "Volleyball Club, 5 pm to 9 pm" for each club event in the space that day.
  // Back-to-back slots held by the same club read as one event.
  function eventSummary(space) {
    var runs = [];
    SLOTS.forEach(function (slot) {
      var org = isOpen(space, state.dateKey, slot) && state.events[slotKey(space.id, slot)];
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
      if (view.pressed !== undefined) body.setAttribute("aria-pressed", view.pressed ? "true" : "false");
      body.addEventListener("click", view.action);
    }
    body.title = formatSlot(slot) + ": " + (view.detail || view.text);
    body.appendChild(el("span", "slot-time", formatHour(slot)));
    body.appendChild(el("span", "slot-state", view.text));
    item.appendChild(body);
    return item;
  }

  function buildSpace(space, dayReservation, words) {
    var row = el("li", "space");
    var info = el("div", "space-info");
    info.appendChild(highlighted("strong", space.name, words));
    info.appendChild(highlighted("span", space.detail, words));
    var events = eventSummary(space);
    if (events) info.appendChild(el("em", "", events));
    row.appendChild(info);

    var slots = el("ul", "slots");
    SLOTS.forEach(function (slot) {
      slots.appendChild(buildSlot(space, slot, dayReservation));
    });
    row.appendChild(slots);
    return row;
  }

  function venueHoursText(venue, dateKey) {
    var hours = venue.hours[fromKey(dateKey).getDay()];
    return hours ? "Open " + formatHour(hours[0]) + " to " + formatHour(hours[1]) : "Closed today";
  }

  function renderSchedule() {
    var dateKey = state.dateKey;
    var dayName = DAY_NAMES[fromKey(dateKey).getDay()];
    var dayReservation = reservationOn(dateKey);
    var words = queryWords();
    var oneVenue = state.venueId !== "all" ? VENUES.filter(function (v) { return v.id === state.venueId; })[0] : null;

    heading.textContent = oneVenue ? oneVenue.name : "All facilities";
    subheading.textContent = formatDate(dateKey) + (oneVenue ? " · " + oneVenue.location + " · " + venueHoursText(oneVenue, dateKey) : "");

    timesRow.textContent = "";
    timesRow.appendChild(el("span", "", "Space"));
    var times = el("div", "times");
    SLOTS.forEach(function (slot) {
      times.appendChild(el("span", "", formatHour(slot)));
    });
    timesRow.appendChild(times);

    var shownSpaces = 0;
    var shownVenues = 0;
    var closedMatches = 0;
    spacesBox.textContent = "";

    VENUES.forEach(function (venue) {
      var matches = venue.spaces.filter(function (space) {
        return matchesFilters(space, words);
      });
      if (!matches.length) return;

      // Spaces shut for the whole day are counted, not drawn.
      var openToday = matches.filter(function (space) {
        return SLOTS.some(function (slot) {
          return isOpen(space, dateKey, slot);
        });
      });
      closedMatches += matches.length - openToday.length;
      if (state.openOnly) {
        openToday = openToday.filter(function (space) {
          return hasOpenSlot(space, dayReservation);
        });
      }
      if (!openToday.length) return;

      var group = el("section", "venue-group");
      if (!oneVenue) {
        var head = el("div", "venue-head");
        head.appendChild(el("h3", "", venue.name));
        head.appendChild(el("span", "", venue.location + " · " + venueHoursText(venue, dateKey)));
        group.appendChild(head);
      }
      var list = el("ul", "spaces");
      openToday.forEach(function (space) {
        list.appendChild(buildSpace(space, dayReservation, words));
      });
      group.appendChild(list);
      spacesBox.appendChild(group);
      shownSpaces += openToday.length;
      shownVenues++;
    });

    var anything = shownSpaces > 0;
    timesRow.hidden = !anything;
    spacesBox.hidden = !anything;
    emptyBox.hidden = anything;

    var summary = shownSpaces + (shownSpaces === 1 ? " space" : " spaces");
    if (!oneVenue && shownVenues > 1) summary += " at " + shownVenues + " venues";
    if (closedMatches) summary += " · " + closedMatches + " more closed on " + dayName;
    results.textContent = anything ? summary : "";

    emptyBox.textContent = "";
    if (!anything) {
      var filtered = words.length || state.kind !== "all" || state.venueId !== "all" || state.openOnly;
      var message;
      if (closedMatches && !state.openOnly) {
        message = "Everything that matches is closed on " + dayName + ". Try another day.";
      } else if (state.openOnly) {
        message = "Nothing that matches has an open slot left on " + dayName + ".";
      } else if (words.length) {
        message = "No spaces match “" + state.query + "”. Try a sport like basketball, swim or tennis.";
      } else {
        message = "No spaces to show.";
      }
      emptyBox.appendChild(el("p", "", message));
      if (filtered) {
        var reset = button("btn btn-sm btn-secondary", "Clear filters");
        reset.addEventListener("click", function () {
          clearFilters();
          searchInput.focus();
        });
        emptyBox.appendChild(reset);
      }
    }

    var notes = [];
    if (dayReservation) {
      notes.push("You've used your one reservation for " + dayName + ": " + spaceIndex[dayReservation.facilityId].name +
        ", " + formatSlot(dayReservation.slot) + ". Cancel it to pick a different slot.");
    }
    note.textContent = notes.join(" ");
    note.hidden = !notes.length;
  }

  // ---------- Your pick ----------
  // Clicking an open time picks it; the panel shows what you picked and a
  // button that locks it in (the reservation). Nothing is saved until then.
  function isPicked(spaceId, slot) {
    var picked = state.picked;
    return !!picked && picked.spaceId === spaceId && picked.slot === slot && picked.dateKey === state.dateKey;
  }

  function pickSlot(space, slot) {
    state.picked = isPicked(space.id, slot) ? null : { spaceId: space.id, slot: slot, dateKey: state.dateKey };
    renderSchedule();
    renderPick();
    var again = app.querySelector(slotSelector(space.id, slot));
    if (again) again.focus({ preventScroll: true });
  }

  // A pick only stays while that slot is still open on the day being shown.
  function validPick() {
    var picked = state.picked;
    if (!picked || picked.dateKey !== state.dateKey || !spaceIndex[picked.spaceId]) return null;
    var view = slotView(spaceIndex[picked.spaceId], picked.slot, reservationOn(state.dateKey));
    return view.kind.indexOf("is-picked") !== -1 ? picked : null;
  }

  function renderPick() {
    state.picked = validPick();
    pickBox.textContent = "";
    pickBox.classList.toggle("is-active", !!state.picked);
    app.classList.toggle("has-pick", !!state.picked);

    if (!state.picked) {
      pickBox.appendChild(el("h2", "panel-title", "Your booking"));
      var dayReservation = reservationOn(state.dateKey);
      pickBox.appendChild(el("p", "pick-empty", dayReservation
        ? "You're booked on " + formatDate(state.dateKey) + ". Pick another day to book again."
        : "Pick a facility, then click any green time to hold it here."));
      return;
    }

    var space = spaceIndex[state.picked.spaceId];
    var slot = state.picked.slot;
    var left = space.spots - (state.taken[slotKey(space.id, slot)] || 0);
    pickBox.appendChild(el("h2", "panel-title", "Your pick"));
    var title = el("p", "pick-space", space.name);
    pickBox.appendChild(title);
    var facts = el("dl", "pick-facts");
    [
      ["When", formatDate(state.dateKey) + ", " + formatSlot(slot)],
      ["Where", space.venue.name + " · " + space.venue.location],
      ["For", space.detail + (space.spots > 1 ? " · " + left + " of " + space.spots + " spots left" : "")]
    ].forEach(function (fact) {
      var row = el("div");
      row.appendChild(el("dt", "", fact[0]));
      row.appendChild(el("dd", "", fact[1]));
      facts.appendChild(row);
    });
    pickBox.appendChild(facts);
    pickBox.appendChild(el("p", "pick-note", "This uses your one reservation for the day. Check in from " +
      CHECK_IN_EARLY_MINUTES + " minutes before it starts, or it counts as a no-show."));

    var lock = button("btn btn-block", "Lock it in");
    lock.id = "booking-lock";
    lock.addEventListener("click", function () {
      lock.disabled = true;
      lock.textContent = "Locking it in...";
      var picked = state.picked;
      run(
        api.reserve(state.user, picked.spaceId, picked.dateKey, picked.slot),
        "Locked in: " + space.name + ", " + formatDate(picked.dateKey) + ", " + formatSlot(picked.slot) + ".",
        "#booking-next-title"
      ).then(function () {
        state.picked = null;
      });
    });
    pickBox.appendChild(lock);
    var clear = button("link-button pick-clear", "Choose a different time");
    clear.addEventListener("click", function () {
      state.picked = null;
      renderSchedule();
      renderPick();
    });
    pickBox.appendChild(clear);
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
        var checkIn = button("btn btn-sm", "Check in");
        checkIn.setAttribute("aria-label", "Check in: " + describe(reservation));
        checkIn.addEventListener("click", function () {
          run(api.checkIn(state.user, reservation.id), "Checked in: " + describe(reservation) + ".");
        });
        actions.appendChild(checkIn);
      }
      if (status === "booked" && !hasStarted(reservation.date, reservation.slot)) {
        var cancel = button("btn btn-sm btn-secondary", "Cancel");
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
        run(api.checkIn(state.user, reservation.id), "Checked in: " + describe(reservation) + ".", "#booking-next-title");
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

  function confirmCancel(reservation, focusSelector) {
    confirmWith({
      title: "Cancel this reservation?",
      facts: factsFor(spaceIndex[reservation.facilityId], reservation.date, reservation.slot),
      note: "The slot opens up for other students, and you can book a different one that day.",
      confirm: "Cancel reservation",
      dismiss: "Keep it",
      action: function () {
        run(api.cancel(state.user, reservation.id), "Cancelled: " + describe(reservation) + ".", focusSelector);
      }
    });
  }

  // ---------- Controls ----------
  venueList.addEventListener("click", function (event) {
    var choice = event.target.closest("button[data-venue]");
    if (!choice) return;
    state.venueId = choice.getAttribute("data-venue");
    renderVenues();
    renderKinds();
    renderSchedule();
    var pressed = venueList.querySelector('[data-venue="' + state.venueId + '"]');
    if (pressed) pressed.focus();
  });

  searchInput.addEventListener("input", function () {
    state.query = searchInput.value.trim();
    renderKinds();
    renderSchedule();
  });

  // "/" jumps to the search box, like most search UIs.
  document.addEventListener("keydown", function (event) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (event.key === "/" && !typing && !app.hidden && !dialog.open) {
      event.preventDefault();
      searchInput.focus();
    }
  });

  kindChips.addEventListener("click", function (event) {
    var chip = event.target.closest("button[data-kind]");
    if (!chip) return;
    var kind = chip.getAttribute("data-kind");
    state.kind = state.kind === kind ? "all" : kind;
    renderKinds();
    renderSchedule();
    var pressed = kindChips.querySelector('[data-kind="' + state.kind + '"]');
    if (pressed) pressed.focus();
  });

  openOnly.addEventListener("change", function () {
    state.openOnly = openOnly.checked;
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

  // ---------- Start ----------
  renderKinds();

  var saved = read(SESSION_KEY, null);
  if (saved && saved.token && saved.user) {
    session = saved;
    state.user = saved.user;
    if (needsQuiz(state.user)) {
      showGate("quiz");
    } else {
      showApp(false);
    }
  } else {
    showGate(location.hash === "#login" ? "login" : "signup");
  }
})();
