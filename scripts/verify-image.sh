#!/usr/bin/env bash
# Starts a container image and proves it is deployable:
#   - it becomes healthy (HEALTHCHECK) and answers GET /health through the published port
#   - /health reports the expected commit (the image really contains that build)
#   - it does not run as root
#   - `docker stop` (SIGTERM) ends with exit code 0, i.e. graceful shutdown works
#
# Usage: scripts/verify-image.sh <image> <expected-commit> [host-port]
set -euo pipefail

image="${1:?usage: verify-image.sh <image> <expected-commit> [host-port]}"
expected_commit="${2:?usage: verify-image.sh <image> <expected-commit> [host-port]}"
host_port="${3:-3000}"
name="verify-image-$$"

# shellcheck disable=SC2329 # invoked indirectly through the EXIT trap
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting ${image} on port ${host_port}"
docker run -d --name "$name" -p "${host_port}:3000" "$image" >/dev/null

echo "Waiting for the container healthcheck"
status="starting"
for _ in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$name")"
  [ "$status" = "healthy" ] && break
  [ "$(docker inspect --format '{{.State.Running}}' "$name")" = "true" ] || break
  sleep 2
done
if [ "$status" != "healthy" ]; then
  echo "::error::container is not healthy (status: ${status})" >&2
  docker logs "$name" >&2 || true
  exit 1
fi

body="$(curl --fail --silent --show-error --retry 5 --retry-delay 1 --retry-connrefused "http://127.0.0.1:${host_port}/health")"
echo "GET /health -> ${body}"
if ! printf '%s' "$body" | grep -F "\"commit\":\"${expected_commit}\"" >/dev/null; then
  echo "::error::/health does not report commit ${expected_commit}" >&2
  exit 1
fi

user_id="$(docker exec "$name" id -u)"
if [ "$user_id" = "0" ]; then
  echo "::error::container runs as root" >&2
  exit 1
fi
echo "Runs as uid ${user_id} (not root)"

docker stop --time 15 "$name" >/dev/null
exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
if [ "$exit_code" != "0" ]; then
  echo "::error::graceful shutdown failed, exit code ${exit_code}" >&2
  docker logs "$name" >&2 || true
  exit 1
fi
echo "Graceful shutdown OK (exit code 0)"
docker logs "$name" 2>&1 | tail -n 3
echo "Image verified."
