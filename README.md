# Art Studio

A web application for an art studio that sells one-of-a-kind paintings, accepts wall-painting bookings, and handles custom pottery requests. Customers can purchase paintings, book wall-painting services, and request custom pottery. The studio administrator manages paintings, bookings, and requests.

**Stack:** Node.js, built-in `node:http`, PostgreSQL (Supabase), and a plain HTML/CSS/JavaScript frontend.

## Live Website

https://art-studio-729j.onrender.com/

## Run Locally

### Prerequisites

- Node.js 22.13 or later
- A Supabase PostgreSQL database
- Git

### Setup

```bash
git clone https://github.com/gaya3-coder/art-studio.git
cd art-studio
npm install
```

Create a `.env` file in the project root and add your Supabase PostgreSQL connection string:

```env
DATABASE_URL=your_supabase_postgresql_connection_string
```

Keep your actual database credentials private. Never commit `.env` to GitHub.

Start the application:

```bash
npm start
```

Open http://localhost:3000 in your browser.

**Note:** The application requires a working Supabase PostgreSQL database and the required database schema and seed data. Follow the project's database setup instructions before running it on a fresh database.

## Login

- **Studio administrator:** Use the configured studio account.
- **Customer:** Register through the website using the Sign Up option.

Do not publish real passwords or database credentials in this README.

## Tests

```bash
npm test
```

Run the automated tests to verify authentication, role permissions, booking rules, and concurrent purchases and bookings.

## Configuration

The application uses the `DATABASE_URL` environment variable to connect to Supabase PostgreSQL. Configure environment variables in your local `.env` file and in Render's Environment settings.

## Project Structure

- `src/server-pg.js` — PostgreSQL-backed server, API routes, authorization, and business logic
- `src/db-pg.js` — PostgreSQL connection and database utilities
- `public/` — Website interface, styles, scripts, and images
- `package.json` — Project scripts and dependencies
- `.gitignore` — Excludes environment files and other local-only data

## Deployment

The application is deployed on Render and uses Supabase PostgreSQL for persistent database storage.
