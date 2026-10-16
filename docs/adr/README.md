# 아키텍처 결정 기록 (ADR)

설계 및 구현 과정에서 내린 39개의 기술적 결정을 기록한 문서입니다. 각 문서는 결정 배경, 채택한 설계, 근거, 트레이드오프 및 기각한 대안을 기술합니다.

도메인 모델 및 상태 용어 정의는 [CONTEXT.md](../../CONTEXT.md)를 참고하십시오.

## 주요 설계 흐름별 핵심 ADR

1. **단일 저장소 구성**: [ADR-0003](0003-postgres-only-no-redis.md) — 발송 상태, 작업 큐(`FOR UPDATE SKIP LOCKED`), 처리량 제한을 단일 PostgreSQL로 통합
2. **작업 점유 및 장애 복구**: [ADR-0004](0004-ownership-by-lease-and-fencing.md) — 리스(`lease_until`) 기반 만료 회수(`Takeover`)와 펜싱(`owner`, `attempts`)을 통한 중복 기록 방지
3. **미확정 요청 대조**: [ADR-0002](0002-reconcile-unconfirmed-sends-via-clientref.md) — 타임아웃 등 응답 미수신 건(`UNCONFIRMED`)에 대해 `clientRef` 내역 조회 후 재발송 여부 결정
4. **처리량 제한 및 우선순위**: [ADR-0009](0009-shared-token-bucket-in-postgres.md), [ADR-0011](0011-urgent-first-by-claim-order.md) — PostgreSQL 단일 행 토큰 버킷 공유 및 토큰 획득 후 우선순위순 점유
5. **외부 장애 대응**: [ADR-0014](0014-retry-backoff-and-send-circuit-breaker.md) — 지수 백오프 재시도, 서킷 브레이커, 단건 프로브(Probe) 발송을 통한 복구 확인
6. **취소 및 완료 판정**: [ADR-0017](0017-cancel-in-two-steps.md), [ADR-0018](0018-derived-counts-and-last-writer-completion.md) — 2단계 취소(`CANCELING` → `CANCELED`) 및 알림 행 잠금 기반 최종 완료 판정

## 전체 목록

### 원칙 및 범위

| ADR                                              | 제목                                                   |
| ------------------------------------------------ | ------------------------------------------------------ |
| [0001](0001-scope-includes-optional-features.md) | 선택 요구사항(긴급 알림, 워커 다중화)의 초기 설계 반영 |
| [0005](0005-minimize-dependencies-by-design.md)  | 외부 의존성 및 인프라 구성 요소 최소화 원칙            |
| [0038](0038-spec-first-implementation-loop.md)   | 명세 기반 구현 및 독립 검증 루프                       |

### 중복 및 누락 방지

| ADR                                                       | 제목                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| [0002](0002-reconcile-unconfirmed-sends-via-clientref.md) | 미확정(`UNCONFIRMED`) 발송 건의 `clientRef` 기반 내역 조회 및 상태 확정 |
| [0004](0004-ownership-by-lease-and-fencing.md)            | 리스(Lease) 기반 작업 소유권 관리 및 펜싱(Fencing)                      |
| [0007](0007-worker-shutdown-two-exits.md)                 | 워커 종료 시 점유 작업의 처리 경로 일원화 (즉시 반납 및 리스 만료)      |
| [0032](0032-delivery-status-model.md)                     | `Delivery` 상태 모델 및 조건부 상태 전이                                |
| [0037](0037-runtime-and-base-tools.md)                    | 런타임·기본 도구 선정 및 요청 전송 여부 판정 기준                       |

### 저장소 및 작업 큐

| ADR                                    | 제목                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| [0003](0003-postgres-only-no-redis.md) | 단일 PostgreSQL 기반 상태 저장소, 작업 큐, 처리량 제한 통합 |
| [0036](0036-drizzle-on-pg-driver.md)   | Drizzle ORM(`pg` 드라이버) 도입 및 조건부 UPDATE 원칙       |

### 처리량 제어 및 우선순위

| ADR                                                   | 제목                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| [0009](0009-shared-token-bucket-in-postgres.md)       | PostgreSQL 단일 행 기반 워커 공유 토큰 버킷                    |
| [0010](0010-two-workers-one-process-per-container.md) | 기본 워커 인스턴스 구성 (2 레플리카, 컨테이너당 단일 프로세스) |
| [0011](0011-urgent-first-by-claim-order.md)           | 선 토큰 획득 및 우선순위 정렬 점유를 통한 긴급 알림 우선 처리  |
| [0012](0012-fifo-between-alarms-within-priority.md)   | 동일 우선순위 내 알림 간 시작 순번(FIFO) 처리                  |
| [0013](0013-concurrency-cap-and-socket-pool.md)       | 워커당 동시 발송 상한(50), HTTP 커넥션 풀 및 DB 풀 분리        |

### 장애 대응 및 복원력

| ADR                                                      | 제목                                                    |
| -------------------------------------------------------- | ------------------------------------------------------- |
| [0014](0014-retry-backoff-and-send-circuit-breaker.md)   | 건별 지수 백오프 재시도 및 프로브 기반 서킷 브레이커    |
| [0026](0026-health-checks-live-and-ready.md)             | Liveness·Readiness 헬스체크 분리 및 워커 루프 생존 판정 |
| [0039](0039-unexpected-errors-never-kill-the-process.md) | 최상위 예외 격리 및 DB 타임아웃 설정                    |

### 알림 생명주기

| ADR                                                                     | 제목                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [0006](0006-recipient-expansion-single-owner-with-cursor-checkpoint.md) | 단일 워커 점유 및 커서 체크포인트 기반 대량 수신자 확장(Expansion)   |
| [0008](0008-alarm-status-model.md)                                      | 알림(`Alarm`) 5단계 상태 모델                                        |
| [0016](0016-state-transitions-by-conditional-update.md)                 | 조건부 UPDATE를 통한 원자적 상태 전이 및 멱등 응답                   |
| [0017](0017-cancel-in-two-steps.md)                                     | 2단계 발송 취소 처리 (`CANCELING` 전환 및 비동기 잔여 건 정리)       |
| [0018](0018-derived-counts-and-last-writer-completion.md)               | 조회 시점 상태 집계 및 마지막 완료 트랜잭션 기반 알림 완료 판정      |
| [0029](0029-alarm-timestamps.md)                                        | 알림 타임스탬프(`created_at`, `started_at`, `finished_at`) 갱신 규칙 |

### HTTP API 설계

| ADR                                                         | 제목                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| [0015](0015-api-resources-and-action-endpoints.md)          | REST 리소스 및 상태 전이 액션 엔드포인트 설계                   |
| [0019](0019-problem-details-and-trace-id.md)                | RFC 9457 Problem Details 에러 응답 및 W3C Trace Context 추적 ID |
| [0020](0020-http-status-codes.md)                           | HTTP 상태 코드 매핑 규칙                                        |
| [0021](0021-alarm-creation-validation-and-title.md)         | 알림 생성 입력 검증 규칙 및 `title` 필드 처리                   |
| [0022](0022-no-idempotency-key-for-creation.md)             | 알림 생성 요청의 별도 멱등 키 미적용 근거                       |
| [0023](0023-alarm-is-a-send-event-with-content-snapshot.md) | 발송 이벤트 단위의 알림 모델 및 콘텐츠 스냅숏 저장              |
| [0024](0024-keyset-pagination.md)                           | 커서(Keyset) 기반 목록 페이지네이션                             |
| [0033](0033-minimal-api-key-auth-and-management-port.md)    | API 키 인증 및 관리 포트 분리                                   |

### 운영 및 인프라

| ADR                                                                 | 제목                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------ |
| [0025](0025-compose-layout-and-separate-migration-with-db-roles.md) | Docker Compose 서비스 구성 및 마이그레이션 DB 계정 권한 분리 |
| [0027](0027-prometheus-metrics-with-optional-monitoring-profile.md) | Prometheus 메트릭 노출 및 선택적 모니터링 프로필 구성        |
| [0028](0028-structured-logs-with-masking.md)                        | JSON 구조화 로깅 및 민감정보 마스킹                          |
| [0030](0030-config-from-env-validated-at-startup.md)                | 환경변수 기반 설정 관리 및 기동 시 불변식 검증               |
| [0031](0031-data-growth-and-retention-plan.md)                      | 발송 이력 데이터 증가에 따른 보존 및 파티셔닝 설계           |

### 테스트 전략

| ADR                                          | 제목                                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| [0034](0034-test-quality-strategy.md)        | 불변식 보장 중심의 4단계 테스트 품질 검증 전략              |
| [0035](0035-test-layers-and-environments.md) | 단위·통합·E2E 테스트 계층 및 실제 PostgreSQL 기반 검증 환경 |
