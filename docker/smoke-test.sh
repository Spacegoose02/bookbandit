#!/usr/bin/env bash
# Smoke test for a built image: converters work and the server answers as PUID/PGID.
# Usage: docker/smoke-test.sh <image>
set -euo pipefail

IMAGE="${1:?usage: smoke-test.sh <image>}"
NAME="bookbandit-smoke-$$"
WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # The container wrote files as uid 99, so remove them from inside a container.
  docker run --rm --entrypoint sh -v "$WORK:/work" "$IMAGE" -c 'rm -rf /work/*' >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
on_error() {
  echo "smoke test FAILED at line $1: $2" >&2
  docker top "$NAME" -eo pid,uid,args >&2 2>/dev/null || true
  docker logs --tail 50 "$NAME" >&2 2>/dev/null || true
}
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

echo "== converters"
if [ "${SMOKE_SKIP_CONVERTERS:-}" != 1 ]; then
docker run --rm --entrypoint sh "$IMAGE" -c '
  set -e
  cd /tmp
  printf "Chapter 1\n\nOnce upon a time a bandit borrowed a book.\n" > story.txt
  ebook-convert story.txt story.epub --title "Smoke Test" >/dev/null
  kepubify -o story.kepub.epub story.epub >/dev/null
  test -s story.epub && test -s story.kepub.epub
  echo "ebook-convert and kepubify ok"
'
fi

echo "== server"
mkdir -p "$WORK/config" "$WORK/books"
docker run -d --name "$NAME" -e PUID=99 -e PGID=100 \
  -v "$WORK/config:/config" -v "$WORK/books:/books" -p 127.0.0.1::8080 "$IMAGE" >/dev/null
PORT="$(docker port "$NAME" 8080/tcp | head -n1 | sed 's/.*://')"

for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true'
curl -fsS "http://127.0.0.1:$PORT/" | grep -qi '<div id="root">'
curl -fsS "http://127.0.0.1:$PORT/some/client/route" | grep -qi '<div id="root">'
test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/does-not-exist")" = 404
# Match the node process itself, not tini (uid 0) whose args also name index.js.
test "$(docker top "$NAME" -eo pid,uid,args | awk '$3 == "node" && /apps\/server\/dist\/index.js/ {print $2; exit}')" = 99
test "$(stat -c %u "$WORK/config/bookbandit.sqlite")" = 99
echo "server ok (port $PORT, running as uid 99)"
