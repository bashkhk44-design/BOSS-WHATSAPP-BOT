# Explicit database bootstrap

The normal service command (`npm start`) does **not** create tables or apply migrations. Database provisioning is a separate, deliberate maintenance operation.

## Required order

The supported bootstrap command runs these steps in order:

1. `db.initDatabase()` creates the prerequisite bot and project tables.
2. The allowlisted migration runner applies pending reviewed SQL migrations.
3. `db.verifyDatabaseSchema()` confirms that the runtime-required tables exist.

If any step fails, later steps do not run and the command exits with an error.

## Before running

- Use a staging database first.
- Confirm the target database and environment are correct.
- Take and verify a restorable backup/snapshot.
- Review the pending migration files and the allowlist in `migrations/runner.js`.
- Use a database role with the required DDL privileges.
- Schedule an appropriate maintenance window and avoid running multiple bootstrap operations concurrently.

## Run

From the repository root, with the intended environment variables configured:

```sh
npm run db:bootstrap
```

The command requires `DATABASE_URL`. It uses the existing PostgreSQL SSL configuration and closes its pool when finished.

## Important

- Do not add bootstrap to `npm start` or any automatic deploy/start hook.
- Do not point this command at production until staging validation, backup verification, migration review, and a separate explicit production approval are complete.
- A successful local/mock test does not prove that a particular Neon database has been provisioned.
