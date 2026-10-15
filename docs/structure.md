# 프로젝트 구조

NestJS 프로젝트 하나에 진입점 세 개를 둔다(ADR-0025). 이미지는 하나다.

```
src/
  main-api.ts             api 진입점: 공개 포트(업무 API, /docs) + 관리 포트(/health, /metrics)
  main-worker.ts          worker 진입점: 관리 포트(/health, /metrics)
  migrate.ts              migrate 진입점: 마이그레이션 적용 후 종료

  api/                    api 프로세스 전용
    alarms/
      alarms.controller   경로와 상태 코드
      alarms.service      흐름: 입력 규칙, 커서, 응답 판정
      alarms.repository   SQL: 생성, 목록, 단건, 발송 시작·취소 전이, Delivery 목록
      alarms.dto          요청·응답 모양과 입력 검증
    auth/                 API 키 Guard (ADR-0033)
    errors/               Problem Details 예외 필터 (ADR-0019, 0039)
    metrics/              DB에서 세는 메트릭과 그 쿼리(metrics.repository) (ADR-0027)

  worker/                 worker 프로세스 전용
    runtime/              부품 조립과 켜고 끄는 순서, 공통 작업 루프(PollingLoop) (ADR-0039)
    lifecycle/            워커 ID, 잠금 연결, 발송 직전 확인, 무효 선언·넘겨받기 루프 (ADR-0004, 0007)
      workers.repository  SQL: 살아 있는 워커 명단(pg_locks), 무효 선언(pg_stat_activity)
    dispatch/             작업 루프: 토큰 → 꺼내기 → 발송 → 결과 기록 (ADR-0011, 0012, 0013)
      delivery.repository SQL: 꺼내기, 결과 기록(펜싱), 넘겨받기, 결과 확인 대상
    reconcile/            결과 확인 루프 (ADR-0002)
    expansion/            수신자 펼치기 루프와 그 저장소 (ADR-0006)
    cancellation/         취소 정리 루프와 그 저장소 (ADR-0017)
    completion/           알림 행 잠금과 완료 판정(alarm-lock.repository) (ADR-0018)
    rate-limit/           토큰 버킷과 그 저장소 (ADR-0009)
    breaker/              서킷 브레이커 (ADR-0014)
    metrics/              워커 메모리 메트릭 (ADR-0027)

  shared/                 두 프로세스가 함께 쓰는 것
    config/               @nestjs/config + 검증 (ADR-0030)
    db/                   Drizzle 스키마, 연결 풀, DB 시계 식
    domain/               상태 값, 전이 규칙, 재시도 정책, 응답 분류 (순수 로직)
    external/             외부 발송 API 클라이언트 (node:http, ADR-0037)
    logging/              JSON 로거 래퍼, 마스킹, AsyncLocalStorage (ADR-0028)
    health/               관리 포트 (ADR-0026)
    runtime/              프로세스 안전망 (ADR-0039)

drizzle/                  drizzle-kit이 생성한 마이그레이션 SQL
docker/
  postgres/init.sh        DB 계정과 권한 (ADR-0025)
  prometheus/             monitoring 프로필 설정 (ADR-0027)
test/
  unit/                   순수 로직, 변이 테스팅 대상 (ADR-0034, 0035)
  integration/            실제 PG + 가짜 외부 API
  e2e/                    실제 mock 이미지로 중복·누락 검증
  sabotage/               고의 결함 목록과 실행 스크립트 (ADR-0034)
Dockerfile                멀티스테이지: build → runtime(api·worker·migrate 공통), test 타깃
docker-compose.yml
```

## 경계 규칙

- `api/`와 `worker/`는 서로를 import하지 않는다. 함께 쓰는 것은 `shared/`에만 둔다.
- SQL은 `*.repository.ts`에만 둔다. 서비스와 루프는 저장소의 메서드를 불러 흐름만 표현한다(ADR-0036).
- `worker/` 안의 `expansion/`과 `dispatch/`는 서로를 import하지 않고, DB 테이블로만 이어진다(ADR-0006).
- Delivery를 최종 상태로 바꾸는 모든 경로(`dispatch/`, `reconcile/`, `cancellation/`, `expansion/` 종료)는 `completion/`의 함수를 거친다(ADR-0018).
- worker의 작업 루프는 모두 `PollingLoop`를 쓴다. 루프를 쓰는 모듈은 try/catch 없이 한 바퀴에 할 일만 쓴다(ADR-0039).
- `shared/domain/`은 IO가 없는 순수 코드만 둔다. 단위 테스트와 변이 테스팅의 주 대상이다.
