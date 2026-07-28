#!/usr/bin/env bash
set -euo pipefail

container_name="manas-postgres-$$"
port="${MANAS_POSTGRES_PORT:-55432}"
password="parity-only-$$"

if [[ -n "${MANAS_POSTGRES_URL:-}" ]]; then
	 bun run postgres:check -- --require
	 exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
	echo "Docker is required for the disposable PostgreSQL contract" >&2
	exit 1
fi
if ! docker info >/dev/null 2>&1; then
	echo "Docker daemon is unavailable; start Docker and rerun bun run postgres:docker" >&2
	exit 1
fi

docker_config="$(mktemp -d "${TMPDIR:-/tmp}/manas-docker-config.XXXXXX")"
docker_context="$(docker context show 2>/dev/null || true)"
docker_endpoint=""
if [[ -n "$docker_context" ]]; then docker_endpoint="$(docker context inspect "$docker_context" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"; fi
docker_cmd=(docker --config "$docker_config")
if [[ -n "$docker_endpoint" ]]; then docker_cmd+=(--host "$docker_endpoint"); fi

cleanup() {
	"${docker_cmd[@]}" rm -f "$container_name" >/dev/null 2>&1 || true
	rm -rf -- "$docker_config"
}
trap cleanup EXIT

"${docker_cmd[@]}" run --rm --name "$container_name" -e POSTGRES_PASSWORD="$password" -p "${port}:5432" -d pgvector/pgvector:pg16 >/dev/null
for attempt in $(seq 1 30); do
	if "${docker_cmd[@]}" exec "$container_name" pg_isready -U postgres >/dev/null 2>&1; then break; fi
	if [ "$attempt" -eq 30 ]; then echo "PostgreSQL container did not become ready" >&2; exit 1; fi
	sleep 1
done

MANAS_POSTGRES_URL="postgresql://postgres:${password}@127.0.0.1:${port}/postgres" bun run postgres:check -- --require
