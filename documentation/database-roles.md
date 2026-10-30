# Database roles

Every deploy, single-tenant or multi-tenant, connects to Postgres with two roles on the same database:

| Role | Env var | Used by | RLS |
|---|---|---|---|
| Owner (`host_admin` by convention) | `DATABASE_URL` | Migrations; in multi mode also the tenancy layer's `adminDb` | Skips it (owns the tables; `BYPASSRLS` in multi mode) |
| `app_user` | `APP_DATABASE_URL` | The app's `db` client: every request handler and layer | Enforced |

Row-level security protects personal-app rows (each user's own data) in both modes, and org data in multi mode. Table owners, superusers and `BYPASSRLS` roles skip every policy, so the app must not connect as one. Core checks the role at boot and on every request ([rls-guard.ts](../layers/core/server/utils/rls-guard.ts)): if `db`'s role is a superuser, has `BYPASSRLS`, or owns an RLS table, every request is refused with a 503 and the reason is logged as `[core] Row-level security is not enforced…`. Set both variables, in dev too.

## Setup (one-time, manual)

```sql
-- Owner: runs migrations. Add BYPASSRLS for multi-tenant deploys (the
-- tenancy layer's cross-org admin endpoints need it).
CREATE ROLE host_admin LOGIN PASSWORD '<>';
GRANT ALL PRIVILEGES ON DATABASE <db> TO host_admin;
ALTER SCHEMA public OWNER TO host_admin;

-- Restricted role for app requests. Explicitly NOT BYPASSRLS, owns nothing.
CREATE ROLE app_user LOGIN PASSWORD '<>';
GRANT CONNECT ON DATABASE <db> TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Defaults FOR ROLE host_admin, so tables later migrations create (as
-- host_admin) grant to app_user automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE host_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE host_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
```

Core's `017_app_user_grants` migration (and tenancy's `tenancy_020_setup_db_roles`) also runs the GRANT block idempotently when `app_user` exists, but creating the roles is operator work no migration can do.

```bash
DATABASE_URL=postgres://host_admin:...@localhost/<db>
APP_DATABASE_URL=postgres://app_user:...@localhost/<db>
```

Verify:

- `\du app_user` shows neither `Superuser` nor `Bypass RLS`
- After migrations run, `\dp users` shows `arwd` privileges granted to `app_user`

## Existing deploy with only `DATABASE_URL`

A deploy that used to set only `DATABASE_URL` keeps working until it updates to a core version with the guard; from then on it answers 503 until `app_user` exists and `APP_DATABASE_URL` is set. Before updating:

1. Create `app_user` with the SQL above. If your existing `DATABASE_URL` role owns the tables, keep it as the owner: substitute its name for `host_admin` in the `ALTER DEFAULT PRIVILEGES` lines, and run the `GRANT … ON ALL TABLES` lines once so existing tables are covered.
2. Set `APP_DATABASE_URL` to `app_user`.
3. Update and restart.
