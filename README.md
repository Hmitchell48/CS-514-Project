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

Shared styles are in `css/styles.css`. `js/main.js` only handles the mobile menu. `js/booking.js` runs the booking schedule on the home page.

## Booking schedule

The schedule on the home page is locked behind a sign-up wall. Sign-up needs the database, so for now the form validates and then stops. To get past the wall, choose **Log in** and use a test account:

| Email | Password |
| --- | --- |
| `dev@sdsu.edu` | `courtconnect-dev` |
| `dev2@sdsu.edu` | `courtconnect-dev` |

Two accounts let you check that one student's booking shows as taken to another. These are in a public repo, so delete `TEST_ACCOUNTS` once log-in uses the database.

Until then everything runs in the browser:

- Reservations are saved in `localStorage` (`courtconnect.reservations`), so they only exist in the browser that made them. Clear site data to reset.
- Other students' bookings and the club events are generated sample data.
- All data access goes through the `api` object in `js/booking.js` (`signUp`, `logIn`, `getDay`, `listReservations`, `reserve`, `cancel`, `checkIn`). Each method returns a promise, so connecting the database means replacing those bodies with requests.

The facility list, hours, slot length and reservation windows are constants at the top of `js/booking.js`.

## Editing

- Search for `[TODO` to find content that still needs writing.
- Image spots are `<div class="placeholder">` boxes. Swap one for an image, e.g.
  `<img src="images/hero.jpg" alt="Students playing basketball at the ARC">`, and put the files in an `images/` folder.
- The header and footer are copied into every page. If you change the nav, change it in all seven files.
- The technical PDF link expects `docs/CourtConnect-Technical.pdf`.

## Viewing

Open `index.html` in a browser, or view the live site on GitHub Pages:
https://hmitchell48.github.io/CS-514-Project/

To turn on Pages: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
