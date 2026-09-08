# Getting Started — Demo V2

This guide starts Mona Jacinta Demo V2 from a clean deterministic demo database.

## Prerequisites

- Node.js >= 22.12
- npm
- Access to the local `.env.development` file configured for the demo and test Supabase PostgreSQL targets

Database setup and safety details are documented in [`database.md`](database.md). Do not copy real database URLs, passwords, or Supabase credentials into documentation.

## Install Dependencies

Install dependencies where needed:

```bash
npm install
cd api
npm install
cd ../client
npm install
cd ../admin
npm install
```

Return to the repository root before running root commands:

```bash
cd ..
```

## Configure Environment

Create or update the local `.env.development` from the existing examples and database documentation.

Required principles:

- `DATABASE_URL` targets the DEMO database.
- `TEST_DATABASE_URL` targets the isolated TEST database.
- Demo and test databases must be distinct.
- Real credentials remain local and untracked.
- No database URL is exposed to `client/` or `admin/`.

Reference: [`database.md`](database.md)

## Verify Database Safety

From the repository root:

```bash
npm run db:check
```

This command uses the existing fail-closed identity checks. If it cannot prove demo/test isolation, stop and fix the local environment before running destructive commands.

## Reset Demo Data

Before rehearsal or presentation, restore the known deterministic demo state:

```bash
npm run demo:reset
```

Expected success:

```text
[db:reset] OK: deterministic demo state restored
```

For seed-only workflows:

```bash
npm run demo:seed
```

Reset is destructive for the DEMO database only. The existing demo/test Supabase safety checks remain authoritative.

## Startup Order

Terminal 1:

```bash
cd api
npm run dev
```

Terminal 2:

```bash
cd client
npm run dev
```

Terminal 3:

```bash
cd admin
npm run dev
```

## Ports

- API: <http://localhost:3001>
- Client: <http://localhost:3000>
- Admin: <http://localhost:5173>

## Demo Credentials

DEMO ONLY. These are seed credentials, not infrastructure secrets.

- Seller: `seller01` / `demo123`
- Cashier: `cashier01` / `demo123`
- Admin: `admin` / `demo123`

## Common Demo Reset Workflow

1. Stop local API/client/admin dev servers.
2. From the repository root, run `npm run db:check`.
3. Run `npm run demo:reset`.
4. Start API, then Client, then Admin.
5. Verify the Seller -> Cashier -> Admin scenario.

## Safe Shutdown and Restart

Use `Ctrl+C` in each terminal to stop the dev servers. Restart in the same order: API first, then Client, then Admin. If the demo state needs to be clean again, run `npm run demo:reset` before restarting the flow.
