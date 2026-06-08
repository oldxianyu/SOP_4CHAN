#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$ROOT_DIR/.server/.env"
BACKUP_DIR="$ROOT_DIR/.server/backups"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/sop_4chan_${STAMP}.dump"

PGPASSWORD="${DB_PASSWORD:-}" pg_dump \
  -h "${DB_HOST:-127.0.0.1}" \
  -p "${DB_PORT:-5432}" \
  -U "${DB_USER:-sop_4chan_app}" \
  -d "${DB_NAME:-sop_4chan}" \
  -F c \
  -f "$OUT"

find "$BACKUP_DIR" -type f -name "sop_4chan_*.dump" -mtime +"$RETENTION_DAYS" -delete
echo "$OUT"
