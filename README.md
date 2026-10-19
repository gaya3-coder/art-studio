# Art Studio

A small web app for an art studio that (1) sells one-of-a-kind paintings, (2) paints walls on booking, and
(3) makes custom pottery on request. Customers buy/book/request; the studio (admin) confirms or declines.

**Stack:** Node.js (22.13+) with its built-in `node:http` and `node:sqlite`, plain HTML/CSS/JS front end.
**There are no npm dependencies, so there is nothing to install.**

## Run it (clean machine)

```bash
node -v                      # must be v22.13 or newer
git clone <this repo> && cd art-studio
cp .env.example .env         # optional: every variable has a default
npm start                    # or: node src/server.js
```

Open http://localhost:3000. On first start the SQLite file (`data/studio.db`) is created and seeded from
`seed/seed.json` (12 paintings, pottery items, glazes, wall rate, studio account).

| Who | Login |
|---|---|
| Studio (admin) | `studio@artstudio.in` / `Studio@123` (from the seed data) |
| Customer | use "Sign up" on the login screen |

To reset all data, stop the server and delete the `data/` folder.

## Tests

```bash
npm test
```

Runs 17 end-to-end checks against a real HTTP server and a throwaway database: 401/403/404 rules, role rules,
all date/size/quantity limits, the 3-day cancel rule, and **concurrent** buys and bookings of the same
painting/date (exactly one succeeds).

## Configuration (`.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `DB_PATH` | `./data/studio.db` | SQLite file |
| `STUDIO_TZ` | `Asia/Kolkata` | Timezone that defines "today" for the date rules |
| `SESSION_HOURS` | 24 | Login session lifetime |

No secrets are needed. Sessions are random tokens stored in the database.

## API (JSON, `Authorization: Bearer <token>`)

| Endpoint | Who |
|---|---|
| `POST /api/auth/register` `{name,email,password}`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | public / any |
| `GET /api/catalog` (rate, pottery items, glazes, rules) | any logged-in |
| `GET /api/paintings`, `GET /api/paintings/:id` | any logged-in |
| `POST /api/paintings`, `PATCH /api/paintings/:id` (only while available) | admin |
| `POST /api/orders` `{paintingId}`, `POST /api/orders/:id/cancel` | customer |
| `POST /api/bookings` `{date,wallSizeSqFt,address}`, `POST /api/bookings/:id/cancel` | customer |
| `POST /api/bookings/:id/confirm`, `…/decline` | admin |
| `GET /api/bookings/taken-dates` | any logged-in |
| `POST /api/pottery` `{itemId,glazeId,quantity,neededBy}`, `PATCH /api/pottery/:id`, `POST /api/pottery/:id/cancel` | customer |
| `POST /api/pottery/:id/accept`, `…/decline` | admin |
| `GET /api/orders`, `/api/bookings`, `/api/pottery` (+ `/:id`, optional `?status=`) | customer: own only, admin: all |

Errors look like `{"error":{"code":"CONFLICT","message":"Sorry, this painting has just been sold."}}`.
Status codes: 400 invalid input, 401 not logged in, 403 wrong role, 404 not found (including someone else's
record), 409 conflict or action not allowed in the current status.

## Layout

```
src/server.js   routes, role checks, business rules, static file serving
src/db.js       schema (with the unique indexes) and seeding
src/util.js     validation, scrypt password hashing, date helpers
public/         the web UI (index.html, app.js, style.css, images/)
seed/seed.json  the provided seed data
test/smoke.js   end-to-end tests
```
