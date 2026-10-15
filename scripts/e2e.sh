#!/usr/bin/env bash
# 끝단 테스트 (ADR-0035)
# 실제 mock 이미지(사용자 2000명) 위에 워커 3대를 띄우고, 대량·긴급 알림을 발송하는 도중 워커 하나는 정상 종료하고
# 다른 하나는 죽인 뒤, 수신자마다 외부 기록이 정확히 한 번인지(중복 0, 누락 0), 429가 지속되지 않았는지 확인한다.
# 호스트에는 Docker만 있으면 된다. 검증 스크립트는 compose 네트워크 안의 컨테이너에서 돈다.
set -euo pipefail
cd "$(dirname "$0")/.."

compose() { docker compose -f docker-compose.yml -f docker-compose.e2e.yml "$@"; }
scenario() { compose --profile e2e run --rm --no-deps -T e2e node test/e2e/scenario.mjs "$@"; }

echo "== 깨끗한 상태로 기동 (워커 3대)"
compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d --build --scale worker=3
compose --profile e2e build e2e >/dev/null

echo "== 발송 시작"
IDS=$(scenario start | tail -1)
echo "알림: $IDS"

echo "== 발송 도중 워커 하나를 정상 종료 (docker stop: SIGTERM, compose의 stop_grace_period를 따른다)"
sleep 5
GRACEFUL=$(compose ps -q worker | head -1)
STARTED=$(date +%s)
docker stop "$GRACEFUL" >/dev/null
ELAPSED=$(( $(date +%s) - STARTED ))
CODE=$(docker inspect -f '{{.State.ExitCode}}' "$GRACEFUL")
# SIGTERM이 Node까지 닿지 않으면 유예 시간 뒤 SIGKILL로 끝나 종료 코드가 137이 되고 종료 로그가 없다 (ADR-0007).
if [ "$CODE" != "0" ] || ! docker logs "$GRACEFUL" 2>&1 | grep -q '정상 종료 완료'; then
  echo "E2E 실패: 정상 종료가 동작하지 않았다 (종료 코드 $CODE, ${ELAPSED}초)"
  exit 1
fi
echo "정상 종료한 워커: $GRACEFUL (종료 코드 0, ${ELAPSED}초)"

echo "== 발송 도중 다른 워커 하나를 강제 종료"
sleep 3
VICTIM=$(compose ps -q worker | grep -v "$GRACEFUL" | head -1)
docker kill "$VICTIM" >/dev/null
echo "종료한 워커: $VICTIM"

echo "== 검증"
scenario verify $IDS
