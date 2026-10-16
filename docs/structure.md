# 프로젝트 구조

단일 NestJS 코드베이스와 단일 Docker 이미지 내에 3개의 실행 진입점(`main-api`, `main-worker`, `migrate`)을 둔다(ADR-0025).

```
src/
  main-api.ts             api 진입점: 공개 포트(/v1/*, /docs) + 관리 포트(/health/*, /metrics)
  main-worker.ts          worker 진입점: 관리 포트(/health/*, /metrics) 및 워커 런타임 기동
  migrate.ts              migrate 진입점: 스키마 마이그레이션 실행 후 종료

  api/                    api 프로세스 전용 모듈
    alarms/
      alarms.controller   엔드포인트 라우팅 및 HTTP 상태 코드 제어
      alarms.service      비즈니스 흐름 제어: 입력 검증, 커서 처리, 상태 전이 응답 판정
      alarms.repository   SQL 쿼리: 알림 생성·조회, 발송 시작·취소 조건부 UPDATE, Delivery 목록 조회
      alarms.dto          요청·응답 DTO 및 class-validator 규칙
    auth/                 API 키 인증 Guard (ADR-0033)
    errors/               RFC 9457 Problem Details 전역 예외 필터 (ADR-0019, 0039)
    metrics/              DB 집계 기반 Prometheus 메트릭 및 조회 저장소 (ADR-0027)

  worker/                 worker 프로세스 전용 모듈
    runtime/              워커 의존성 조립, 기동·종료 제어, 공통 폴링 루프(PollingLoop) (ADR-0039)
    lifecycle/            워커 식별자(workerId) 생성 및 리스 만료 회수(Takeover) 루프 (ADR-0004, 0007)
    dispatch/             발송 루프: 토큰 획득 → Delivery 점유(claim) → 소켓 쓰기 직전 리스 검증 및 발송 → 결과 기록 (ADR-0004, 0011, 0012, 0013)
      delivery.repository SQL 쿼리: 점유(리스 부여), 결과 기록(펜싱 검증), 리스 만료 회수, 내역 조회 대상 선별
    reconcile/            미확정(UNCONFIRMED) 건 발송 내역 조회 및 확정 루프 (ADR-0002)
    expansion/            대량 알림 수신자 확장(Expansion) 루프 및 저장소 (ADR-0006)
    cancellation/         취소 알림 잔여 대기 건 정리 루프 및 저장소 (ADR-0017)
    completion/           알림 행 잠금 및 최종 완료·취소 상태 전환(alarm-lock.repository) (ADR-0018)
    rate-limit/           공유 토큰 버킷 제어 및 저장소 (ADR-0009)
    breaker/              서킷 브레이커 상태 판정 및 제어 (ADR-0014)
    metrics/              워커 인메모리 Prometheus 메트릭 (ADR-0027)

  shared/                 api·worker 공통 모듈
    config/               @nestjs/config 환경변수 로드 및 기동 시 불변식 검증 (ADR-0030)
    db/                   Drizzle 스키마, 커넥션 풀, DB 시계(clock_timestamp) 헬퍼
    domain/               상태 상수, 상태 전이 규칙, 재시도 정책, 응답 분류 등 순수 도메인 로직
    external/             외부 API HTTP 클라이언트 (node:http 기반, ADR-0037)
    logging/              JSON 구조화 로거 래퍼, 민감정보 마스킹, AsyncLocalStorage 컨텍스트 (ADR-0028)
    health/               내부 관리 포트 서버 (ADR-0026)
    runtime/              프로세스 전역 예외 핸들러 (ADR-0039)

drizzle/                  drizzle-kit으로 생성된 SQL 마이그레이션 파일
docker/
  postgres/init.sh        DB 계정 분리 및 권한 초기화 스크립트 (ADR-0025)
  prometheus/             monitoring 프로필용 Prometheus 설정 (ADR-0027)
test/
  unit/                   순수 도메인·클라이언트 단위 테스트 (Stryker 변이 테스팅 대상, ADR-0034, 0035)
  integration/            실제 PostgreSQL + 테스트용 Fake 외부 API 기반 통합 테스트
  e2e/                    실제 mock 컨테이너 연동 E2E 검증
  sabotage/               결함 주입(Sabotage) 정의 및 검증 러너 (ADR-0034)
Dockerfile                멀티스테이지 빌드: build → runtime(api·worker·migrate 공통), test 타깃
docker-compose.yml
```

## 모듈 경계 규칙

- `api/`와 `worker/`는 서로를 import하지 않으며, 공통 코드는 `shared/`에만 배치한다.
- 모든 SQL 쿼리는 `*.repository.ts` 내부에만 작성한다. 서비스와 워커 루프는 저장소 메서드를 호출하여 실행 흐름만 제어한다(ADR-0036).
- `worker/expansion/`과 `worker/dispatch/`는 직접 참조하지 않고 DB 테이블(`deliveries`, `alarms`)을 통해서만 연동된다(ADR-0006).
- `Delivery`를 최종 상태(`SENT`, `FAILED`, `CANCELED`)로 변경하는 모든 경로(`dispatch/`, `reconcile/`, `cancellation/`, `expansion/` 종료)는 `completion/` 모듈의 트랜잭션 헬퍼를 거친다(ADR-0018).
- 워커의 모든 주기적 작업 루프는 `PollingLoop`를 사용하며, 개별 루프 구현체는 자체 `try/catch` 없이 단일 주기(tick) 작업만 기술한다(ADR-0039).
- `shared/domain/`은 외부 I/O가 없는 순수 함수로만 구성하며 단위 테스트 및 변이 테스팅의 핵심 대상으로 관리한다.
