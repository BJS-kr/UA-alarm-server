#!/usr/bin/env bash
# 장애 시나리오 끝단 테스트 (ADR-0035). 실제 mock 이미지(사용자 2000명) 위에서 대량 알림을 보내는 도중 장애를 일으키고,
# 끝난 뒤 mock 쪽 집계로 누락 0·중복 0을 확인한다. 설정은 모두 기본값 그대로다.
#   - mock 25초 멈춤(docker pause): 외부 서비스가 응답하지 않는 동안 결과 미확정과 결과 확인이 맞물리는가
#   - 워커 하나 25초 멈춤(docker pause): 멈춘 동안의 건을 다른 워커가 끝내고, 깨어난 워커의 늦은 결과는 펜싱에 막히는가
#   - PostgreSQL 재시작: 워커들이 다시 연결해 이어 가고, 기록하지 못한 건은 기한이 지나 넘겨받는가
# 호스트에는 Docker만 있으면 된다. alarm 스택과 볼륨을 지우고 새로 띄운다.
set -euo pipefail
cd "$(dirname "$0")/.."

compose() { docker compose -f docker-compose.yml -f docker-compose.e2e.yml "$@"; }
# 외부 서비스가 멈췄다 풀리면 밀린 요청이 한꺼번에 도착해 429가 잠깐 몰린다. 이 시나리오에서는 429를 보지 않는다.
scenario() { compose --profile e2e run --rm --no-deps -T -e ALLOW_429_BURST=1 e2e node test/e2e/scenario.mjs "$@"; }

echo "== 깨끗한 상태로 기동 (워커 3대)"
compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d --build --scale worker=3 --wait
compose --profile e2e build e2e >/dev/null

pause_mock() {
  local mock; mock=$(compose ps -q mock)
  docker pause "$mock" >/dev/null; sleep 25; docker unpause "$mock" >/dev/null
}

pause_worker() {
  local worker; worker=$(compose ps -q worker | head -1)
  docker pause "$worker" >/dev/null; sleep 25; docker unpause "$worker" >/dev/null
}

restart_database() {
  docker restart "$(compose ps -q postgres)" >/dev/null
}

run_case() {
  local name=$1 fault=$2
  echo "== $name"
  local id; id=$(scenario bulk | tail -1)
  sleep 8
  "$fault"
  scenario verify "$id"
}

run_case "발송 도중 mock 25초 멈춤" pause_mock
run_case "발송 도중 워커 하나 25초 멈춤" pause_worker
run_case "발송 도중 PostgreSQL 재시작" restart_database
echo "== 장애 시나리오 모두 통과"
