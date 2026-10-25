# DESIGN.md

## 1. How do login and the two roles work?

Customers can sign up with their name, email, and password, while the studio account is created through the seed process and cannot be registered as a customer. Passwords are hashed using scrypt with a random salt, and successful login returns a random 256-bit session token. Each API request validates the session and checks the user's role from the database, returning 401 for unauthenticated requests and 403 for unauthorized roles. Customer-owned records are restricted to their owner, while studio administrators can manage records across customers.

## 2. Which database did you choose, and why?

PostgreSQL, hosted on Supabase. I chose it to provide a cloud-hosted relational database that works with the deployed Render application. The Node.js backend connects using the `pg` package and the `DATABASE_URL` environment variable, keeping database credentials outside the source code.

## 3. How do you stop two people from taking the same painting or date?

The backend uses database transactions and conditional status updates to prevent conflicting purchases and bookings. Database constraints provide an additional safeguard against duplicate active orders for a painting or conflicting bookings for the same date. When another request has already claimed the painting or date, the server returns a 409 Conflict response instead of allowing both requests to succeed.

## 4. What did you finish, what did you leave out, and what would you do next?

**Finished:** Customer registration and login, role-based access control, painting browsing and purchasing, wall bookings, custom pottery requests, administrative actions, and the PostgreSQL migration with deployment on Render. The application also handles loading, empty, error, and conflict states.

**Left out / next:** I would add pagination, rate limiting and password lockout, automated UI tests, session cleanup, and an administrative view of each customer's complete history. I would also add notifications for booking confirmations and other important status changes.
