# Art Studio

A small web app for an art studio that (1) sells one-of-a-kind paintings, (2) paints walls on booking, and (3) makes custom pottery on request. Customers buy/book/request; the studio (admin) confirms or declines.

**Stack:** Node.js (22.13+) with its built-in `node:http` and `node:sqlite`, plain HTML/CSS/JS front end.  
**There are no npm dependencies, so there is nothing to install.**

## Run it (clean machine)

```bash
node -v
git clone <this repo> && cd art-studio
cp .env.example .env
npm start
```

Open http://localhost:3000. On first start the SQLite file (`data/studio.db`) is created and seeded from `seed/seed.json`.

| Who | Login |
|---|---|
| Studio (admin) | `studio@artstudio.in` / `Studio@123` |
| Customer | Use "Sign up" on the login screen |

To reset all data, stop the server and delete the `data/` folder.

## Tests

```bash
npm test
```

Runs 17 end-to-end checks covering authentication, role rules, booking limits, and concurrent purchases and bookings.

## Configuration

See `.env.example` for the available settings: port, database path, studio timezone, and session duration.

## Layout

- `src/server.js` — routes, role checks, business rules, and static file serving
- `src/db.js` — database schema and seeding
- `src/util.js` — validation, password hashing, and date helpers
- `public/` — website interface, styles, scripts, and images
- `seed/seed.json` — initial seed data
- `test/smoke.js` — end-to-end tests
