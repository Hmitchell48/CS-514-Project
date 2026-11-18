# CourtConnect

A campus app that lets SDSU students reserve any athletic space (courts, fields, pool lanes, gyms). CS 514 group project.

This repo holds the project website. Plain HTML, CSS and JavaScript: no framework, no build step.

## Pages

| File | Deliverable |
| --- | --- |
| `index.html` | Home |
| `about.html` | About webpage |
| `overview.html` | Database product overview & instructions |
| `blog.html` | Blog, one entry per team member |
| `source.html` | Source code & executable |
| `technical.html` | Database product document (technical PDF) |
| `presentation.html` | Draft presentation |

Shared styles are in `css/styles.css`. `js/main.js` only handles the mobile menu. `js/booking.js` runs the booking schedule on the home page, and `js/facilities.js` holds the facility list, hours and booking rules it shares with the API.

## Booking schedule and database

The schedule on the home page talks to a Cloudflare Worker (`api/`) that stores everything in a Cloudflare D1 (SQLite) database: accounts, reservations, club events and penalties. The site itself stays on GitHub Pages.

```
api/
  schema.sql              tables, constraints and indexes (drops and recreates everything)
  scripts/build-seed.mjs  writes seed.sql: facilities, demo accounts, sample bookings and club events
  src/index.js            the Worker: sign-up, log-in, day view, reserve, cancel, check in
  wrangler.toml           Worker name, D1 binding, allowed origins
```

All data access in the page goes through the `api` object in `js/booking.js`. The facility list, hours, slot length and reservation windows are in `js/facilities.js`. After changing them, re-run the seed so the database matches.

Demo log-ins (created by the seed): `dev@sdsu.edu` and `dev2@sdsu.edu`. Two accounts let you check that one student's booking shows as taken to the other. In a **local** database their password is `courtconnect-dev`. The deployed database uses a private password set when seeding (see below); ask the team for it, or sign up with your own account. The other seeded students and club contacts get random passwords and can't be logged into.

### Run it locally

Needs Node 18 or later.

```
cd api
npm install
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .dev.vars
npm run db:schema:local
npm run db:seed:local
npm run dev                           # API on http://localhost:8787
```

In a second terminal, from the repo root: `python3 -m http.server 8000`, then open http://localhost:8000. Pages served from localhost call the local API automatically.

### Deploy (one time)

```
cd api
npx wrangler login
npx wrangler d1 create courtconnect   # paste the database_id into wrangler.toml
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npm run db:schema:remote
DEMO_PASSWORD='pick-a-private-one' npm run db:seed:remote
npx wrangler deploy                   # prints https://courtconnect-api.<subdomain>.workers.dev
```

Put that URL in `API_BASE` at the top of `js/booking.js` and push.

Sample bookings are dated relative to the day the seed runs, so **run the seed again before a demo**, with the same `DEMO_PASSWORD`. It wipes and reloads all rows, including real sign-ups. `db:schema:remote` drops every table, so only run it to start over.

If logging in on the deployed site fails with Cloudflare error 1102 (CPU limit), the Free plan's 10 ms CPU budget is too small for the password hashing. Lower `PBKDF2_ITERATIONS` in `api/src/index.js` and the matching `100000` in `api/scripts/build-seed.mjs` (for example to 50000), then deploy and re-seed. Existing hashes keep working, because each hash stores its own iteration count.

## Security

The repo is public, so nothing in it may grant access to anything.

**Never commit:** `api/.dev.vars` (local session secret), `api/seed.sql` (password hashes), `api/.wrangler/` (local database), or a Cloudflare API token. `api/.gitignore` covers the first three. Wrangler keeps your Cloudflare login in your home folder, outside the repo.

**Safe to commit:** the `database_id` in `wrangler.toml` and the workers.dev URL in `js/booking.js`. Both are identifiers, not credentials. The D1 database can only be reached through the Worker or with your Cloudflare login.

**Secrets live in Cloudflare:** `SESSION_SECRET` signs log-in tokens and is stored with `wrangler secret put`. The Worker refuses to sign or accept tokens if it's missing or shorter than 32 characters. Changing it logs everyone out.

**How the API protects data:**

- Passwords are hashed with PBKDF2-SHA256 (100,000 iterations, random salt per user).
- Every request that touches a student's reservations needs a signed token. The Worker takes the student from the token, never from the request, and every update checks `user_id`, so a student can't see, cancel or check in someone else's booking.
- All SQL uses bound parameters (no string-built queries).
- `/api/login` and `/api/signup` allow 10 attempts per minute per IP (`AUTH_LIMITER` in `wrangler.toml`).
- Input lengths are capped, and errors return a code only, never stack traces or SQL.
- The page writes all data with `textContent`, so a name or club title can't inject HTML.

**Known limits (fine for a class demo):**

- Sign-up doesn't verify the email address, so anyone can register any `@sdsu.edu` address or RedID that isn't taken yet.
- Log-in tokens last 7 days and stay valid after "Log out", which only clears the browser. To end every session at once, change `SESSION_SECRET`.
- The token is kept in `localStorage`, which is only a risk if the site ever gets an XSS bug.
- `courtconnect-dev` was in an earlier public commit, so it's only for local databases. The seed script refuses to use it for `--remote`.

**Cloudflare account:** keep the account on the Workers **Free** plan. Free has hard daily limits, so a flood of requests makes the API fail for the rest of the day instead of running up a bill. Turn on two-factor authentication for the Cloudflare login.



## Editing

- Search for `[TODO` to find content that still needs writing.
- Image spots that still need a picture are `<div class="placeholder">` boxes. Swap one for an `<img>` and put the file in `images/`. Name headshots `first-last.jpg` and use `class="headshot"`.
- Every page loads `css/styles.css?v=4`. After changing the stylesheet, bump the number in all seven pages so browsers don't keep the old copy.
- The header and footer are copied into every page. If you change the nav, change it in all seven files.
- The technical PDF link expects `docs/CourtConnect-Technical.pdf`.

## Viewing

Open `index.html` in a browser, or view the live site on GitHub Pages:
https://hmitchell48.github.io/CS-514-Project/

To turn on Pages: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
