#!/usr/bin/env bash
set -euo pipefail

# Idempotent test-DB bootstrap. Creates `go_saas_test`, `host_admin`
# (BYPASSRLS) and `app_user` roles, grants schema access. Safe to re-run.
#
# Defaults match a vanilla local Postgres on macOS (Homebrew, Postgres.app).
# Override via env vars if you have a different setup.

DB_HOST="${TEST_DB_HOST:-localhost}"
DB_PORT="${TEST_DB_PORT:-5432}"
DB_SUPERUSER="${TEST_DB_SUPERUSER:-postgres}"
DB_NAME="${TEST_DB_NAME:-go_saas_test}"

HOST_ADMIN_PW="${TEST_HOST_ADMIN_PASSWORD:-test}"
APP_USER_PW="${TEST_APP_USER_PASSWORD:-test}"

PSQL="psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_SUPERUSER} -v ON_ERROR_STOP=1"

echo "==> Connecting as ${DB_SUPERUSER}@${DB_HOST}:${DB_PORT}"

# Roles first (safe to re-run via DO blocks).
${PSQL} -d postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'host_admin') THEN
    CREATE ROLE host_admin LOGIN BYPASSRLS PASSWORD '${HOST_ADMIN_PW}';
  ELSE
    ALTER ROLE host_admin WITH LOGIN BYPASSRLS PASSWORD '${HOST_ADMIN_PW}';
  END IF;
END
\$\$;

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD '${APP_USER_PW}';
  ELSE
    ALTER ROLE app_user WITH LOGIN PASSWORD '${APP_USER_PW}';
  END IF;
END
\$\$;
SQL

# Database. Postgres can't CREATE DATABASE inside a DO block, so check first.
if ${PSQL} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  echo "==> Database ${DB_NAME} already exists"
else
  echo "==> Creating database ${DB_NAME}"
  ${PSQL} -d postgres -c "CREATE DATABASE ${DB_NAME} OWNER host_admin"
fi

# Grants. host_admin owns the DB; app_user gets CONNECT + schema usage.
# Per-table grants are handled by the tenancy_020_setup_db_roles migration
# at first migration run.
${PSQL} -d "${DB_NAME}" <<SQL
GRANT CONNECT ON DATABASE ${DB_NAME} TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
ALTER SCHEMA public OWNER TO host_admin;
SQL

# pgvector, created here because host_admin isn't a superuser. Optional: without
# it the vector-index migrations are held back and the context/helpinator tests fail.
if ${PSQL} -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null 2>&1; then
  echo "==> pgvector enabled in ${DB_NAME}"
else
  echo "==> WARNING: could not enable pgvector (install it, e.g. 'brew install pgvector', then re-run)."
  echo "    The context and helpinator tests need it."
fi

echo ""
echo "==> Done. Add these to dev/.env:"
echo ""
echo "TEST_DATABASE_URL=postgresql://host_admin:${HOST_ADMIN_PW}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo "TEST_APP_DATABASE_URL=postgresql://app_user:${APP_USER_PW}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo ""
