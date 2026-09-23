# CourtConnect

A campus app that lets SDSU students reserve any athletic space (courts, fields, pool lanes, gyms). CS 514 group project.

This repo holds the project website. Plain HTML and CSS: no framework, no build step.

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

Shared styles are in `css/styles.css`. `js/main.js` only handles the mobile menu.

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
