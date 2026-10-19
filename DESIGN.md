# DESIGN

## How do login and the two roles work?
Customers sign up with name, email and password; the studio account comes from the seed file and cannot be
created through sign-up (the register endpoint always creates a `customer`). Passwords are hashed with scrypt
and a random salt. Login returns a random 256-bit token stored in a `sessions` table; the browser sends it as
a Bearer token. The seed calls the studio role "studio"; in this app it is stored as the `admin` role.

Every API route is declared with the roles allowed to call it. The server first finds the session (none or
expired: **401**), then compares the user's role, read from the database on each request and never from the
client, with the route's roles (wrong role: **403**). Customer-owned records are always queried with the
owner's id, so another customer's order, booking or request simply does not exist for them (**404**). Admins
query without the owner filter and see everything. Admins get 403 on buying, booking, requesting and
cancelling, as the table in the brief says.

## Which database did you choose, and why?
SQLite, via Node's built-in `node:sqlite`. The brief says the choice is not scored, and I wanted `git clone`
then `npm start` to work on a clean machine with no database server, account, API key or npm install. The
trade-off is that it is a single-file, single-server database rather than cloud-hosted. The data access is
plain SQL in one file, so moving to Postgres would mainly mean changing the connection and the `BEGIN IMMEDIATE`
transaction helper.

## How do you stop two people from taking the same painting or date?
Two layers, so correctness does not depend on timing:
1. **Atomic claim in a transaction.** Buying runs `UPDATE paintings SET status='sold' WHERE id=? AND
   status='available'` inside `BEGIN IMMEDIATE`. Only one caller sees "1 row changed"; the others see 0 and
   get a 409 "this painting has just been sold". Bookings check the date and insert in the same transaction.
2. **Database constraints as a backstop.** A partial unique index allows only one `placed` order per painting
   and only one `requested`/`confirmed` booking per date. Cancelled and declined bookings and cancelled orders
   fall outside the index, so the painting or date becomes available again automatically. If the application
   check were ever bypassed, the insert fails and is turned into the same 409.

The tests fire 5 simultaneous buy requests and 5 simultaneous booking requests; exactly one of each succeeds.
Other status changes (confirm, decline, cancel, accept) use `WHERE status='requested'` guards in the same way.

## What did you finish, what did you leave out, and what would you do next?
**Finished:** everything in the brief. Sign-up/login with two roles; paintings (browse, admin add/edit only
while available, buy, cancel with the painting returning to sale); wall bookings (7-90 day window, 10-500 sq ft,
one booking per date, price = size x seed rate, studio confirm/decline, customer cancel until 3 days before);
custom pottery (seed items/glazes, quantity 1-12, needed-by at least 14 days, accept/decline, edit/cancel only
while requested); 401/403/404 rules on every route; loading, empty and error states on every screen that loads
data, and clear messages for conflicts such as "painting just sold" or "date just taken". 17 automated tests.

**Choices to know about:**
- "Today" and the 3-day cancel cutoff use the studio timezone (`STUDIO_TZ`, default Asia/Kolkata). A booking
  can be cancelled when its date is at least 3 whole days away.
- The price is stored on the booking/order when it is made, so later changes to the rate or painting price do
  not rewrite history. The two seed paintings marked `sold` have no order record (the seed has no customers).
- The images the brief provided are mapped in order to `p-001`..`p-012`.
- Browsing paintings requires login, because the brief says the server refuses requests that are not logged in.

**Left out / next:** no pagination on lists, no rate limiting or password lockout, no UI test suite (the UI
was checked by driving a real browser by hand-written script during development), sessions are not cleaned up
until a token is used again, and the app has not been deployed. Next I would add a cloud database, an
admin view of a customer's full history, and notifications when the studio confirms a booking.
