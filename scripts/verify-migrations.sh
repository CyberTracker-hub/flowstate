#!/usr/bin/env bash
# Apply all migrations to a throwaway local PostgreSQL cluster and run the
# database tests against it. Needs the PostgreSQL server binaries (initdb,
# pg_ctl) and psql; touches nothing outside a temporary directory.
#
#   bash scripts/verify-migrations.sh
#
# To verify against an existing database instead (e.g. a Supabase branch):
#   DATABASE_URL=postgres://... bash scripts/verify-migrations.sh
# In that mode the Supabase stub is NOT applied and the tests are NOT run
# (they create fixture rows); only the migrations are applied.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/packages/database/migrations"
TESTS="$ROOT/packages/database/tests"

if [[ -n "${DATABASE_URL:-}" ]]; then
  for f in "$MIGRATIONS"/*.sql; do
    echo "applying $(basename "$f")"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
  done
  echo "migrations applied to DATABASE_URL"
  exit 0
fi

PG_BIN="${PG_BIN:-}"
if [[ -z "$PG_BIN" ]]; then
  if command -v pg_ctl >/dev/null 2>&1; then
    PG_BIN="$(dirname "$(command -v pg_ctl)")"
  else
    PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  fi
fi
if [[ -z "$PG_BIN" || ! -x "$PG_BIN/initdb" ]]; then
  echo "PostgreSQL server binaries not found. Set PG_BIN or DATABASE_URL." >&2
  exit 2
fi

WORK="$(mktemp -d /tmp/flowstate-pg.XXXXXX)"
PORT="${PGPORT_VERIFY:-54329}"

# PostgreSQL refuses to run as root; drop to the postgres user when needed.
if [[ "$(id -u)" == "0" ]]; then
  chown postgres "$WORK"
  as_pg() { runuser -u postgres -- "$@"; }
else
  as_pg() { "$@"; }
fi

cleanup() {
  as_pg "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

as_pg "$PG_BIN/initdb" -D "$WORK/data" -U postgres --auth=trust -E UTF8 >/dev/null
as_pg "$PG_BIN/pg_ctl" -D "$WORK/data" -w -l "$WORK/server.log" \
  -o "-p $PORT -k $WORK -c listen_addresses=''" start >/dev/null

PSQL=(psql -h "$WORK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database flowstate_verify"
PSQL+=(-d flowstate_verify)

echo "server: $("${PSQL[@]}" -At -c 'show server_version')"
"${PSQL[@]}" -f "$TESTS/supabase-stub.sql"
for f in "$MIGRATIONS"/*.sql; do
  echo "applying $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
echo "tables: public=$("${PSQL[@]}" -At -c "select count(*) from pg_tables where schemaname='public'") internal=$("${PSQL[@]}" -At -c "select count(*) from pg_tables where schemaname='internal'")"
echo "public tables without RLS: $("${PSQL[@]}" -At -c "select count(*) from pg_tables where schemaname='public' and not rowsecurity")"

for f in "$TESTS"/[0-9]*.sql; do
  echo "running $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
echo "OK: migrations applied and database tests passed"
