# 프로젝트 구조

NestJS 프로젝트 하나에 진입점 세 개를 둔다(ADR-0025). 이미지는 하나다.

```
src/
  main-api.ts             api 진입점: 공개 포트(업무 API, /docs) + 관리 포트(/health, /metrics)
  main-worker.ts          worker 진입점: 관리 포트(/health, /metrics)
  migrate.ts              migrate 진입점: 마이그레이션 적용 후 종료

  api/                    api 프로세스 전용
    alarms/               컨트롤러, DTO, 서비스: 생성, 목록, 단건, 발송 시작, 취소, deliveries 목록
    auth/                 API 키 Guard (ADR-0033)
    errors/               Problem Details 예외 필터 (ADR-0019)
    metrics/              DB에서 세는 메트릭 (ADR-0027)

  worker/                 worker 프로세스 전용
    lifecycle/            워커 ID, 잠금 연결, 생존 신호, 발송 직전 확인, 무효 선언, 정상 종료 (ADR-0004, 0007)
    rate-limit/           토큰 버킷 (ADR-0009)
    dispatch/             작업 루프: 토큰 → 꺼내기 → 발송 → 결과 기록, 동시 발송 한도 (ADR-0011, 0012, 0013)
    reconcile/            결과 확인 (ADR-0002)
    expansion/            수신자 펼치기 (ADR-0006)
    cancellation/         취소 정리 (ADR-0017)
    completion/           완료 판정 함수 (ADR-0018)
    breaker/              서킷 브레이커 (ADR-0014)
    metrics/              워커 메모리 메트릭 (ADR-0027)

  shared/                 두 프로세스가 함께 쓰는 것
    config/               @nestjs/config + 검증 (ADR-0030)
    db/                   Drizzle 스키마, 연결
    domain/               상태 값, 전이 규칙, 재시도 정책, 응답 분류 (순수 로직)
    external/             외부 발송 API 클라이언트 (node:http, ADR-0037)
    logging/              JSON 로거 래퍼, 마스킹, AsyncLocalStorage (ADR-0028)
    health/               live/ready (ADR-0026)

drizzle/                  drizzle-kit이 생성한 마이그레이션 SQL
docker/
  postgres/init.sql       DB 계정과 권한 (ADR-0025)
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
- `worker/` 안의 `expansion/`과 `dispatch/`는 서로를 import하지 않고, DB 테이블로만 이어진다(ADR-0006).
- Delivery를 최종 상태로 바꾸는 모든 경로(`dispatch/`, `reconcile/`, `cancellation/`, `expansion/` 종료)는 `completion/`의 함수를 거친다(ADR-0018).
- `shared/domain/`은 IO가 없는 순수 코드만 둔다. 단위 테스트와 변이 테스팅의 주 대상이다.
