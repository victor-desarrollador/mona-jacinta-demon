# Demo Reset

Before a presentation or rehearsal, restore the Mona Jacinta Demo V2 database to the deterministic seed state from the repository root:

```bash
npm run demo:reset
```

Expected success:

```text
[db:reset] OK: deterministic demo state restored
```

Seed-only command:

```bash
npm run demo:seed
```

`demo:reset` is destructive for the configured DEMO database. It must never target the integration TEST database. The existing `api/scripts/demo-database.ts` script performs fail-closed identity checks before allowing seed/reset commands to write.

`.env.development` must contain the configured demo and test Supabase targets. No credentials should ever be printed, copied into logs, or committed.

Use reset before each rehearsal or demo when a clean state is required.

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
