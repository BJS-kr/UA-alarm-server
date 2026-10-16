# 결정 기록 (ADR)

설계 결정 39개를 하나씩 적은 문서다. 파일마다 제목이 곧 결정이다. 본문은 왜 이 결정이 필요했는지(배경)부터 시작해, 결정, 이유, 대가, 검토한 후보를 적었다.

## 처음 읽는다면

이 과제의 핵심 질문은 "워커가 여러 대이고 장애가 나도, 같은 사람에게 두 번 보내거나 빠뜨리지 않는가"다. 아래 순서로 읽으면 그 답이 이어진다.

1. [0003](0003-postgres-only-no-redis.md): 상태와 대기열과 처리량 제한을 PostgreSQL 하나에 둔다. 판단 기준이 하나다.
2. [0004](0004-ownership-by-lease-and-fencing.md): 워커가 가져간 건에는 기한을 적고, 기한이 지나면 넘겨받고, 늦게 깨어난 워커의 쓰기는 막는다.
3. [0002](0002-reconcile-unconfirmed-sends-via-clientref.md): 보냈는지 모르는 건은 외부 기록을 조회한 뒤에만 다시 보낸다.
4. [0009](0009-shared-token-bucket-in-postgres.md), [0011](0011-urgent-first-by-claim-order.md): 모든 워커가 토큰 버킷 하나를 함께 쓰고, 토큰을 받은 순간 긴급 건부터 꺼낸다.
5. [0014](0014-retry-backoff-and-send-circuit-breaker.md): 일시 오류는 재시도하고, 장애는 전체를 멈춘 뒤 시험 발송 한 건으로 복구를 확인한다.
6. [0017](0017-cancel-in-two-steps.md), [0018](0018-derived-counts-and-last-writer-completion.md): 취소와 완료가 결과 기록과 어긋나지 않는다.

## 자주 나오는 말

| 말 | 뜻 |
| --- | --- |
| 알림(Alarm) | 관리자가 만든 메시지 하나. 대량 알림은 전체 사용자에게, 긴급 알림은 지정한 최대 100명에게 보낸다 |
| Delivery(발송 건) | 알림 하나를 수신자 한 명에게 보내는 일 하나. 대량 알림 하나에 10만 건이 생긴다. 이 행이 곧 작업 대기열이다 |
| 꺼내기(claim) | 워커가 보낼 Delivery를 DB에서 골라 "내가 보낸다"고 표시하는 일 |
| 펼치기 | 대량 알림의 수신자(전체 사용자)를 사용자 API에서 받아 Delivery로 만드는 일 |
| 토큰 버킷 | 초당 50건을 지키는 장치. 워커는 보내기 전에 토큰을 받아야 한다(ADR-0009) |
| 기한(리스) | 꺼낸 건에 적는 "이 시각까지 내 것"이라는 표시. 지나면 다른 워커가 가져갈 수 있다(ADR-0004) |
| 넘겨받기 | 기한이 지난 건을 다른 워커가 가져가는 일 |
| 펜싱 | 넘겨받힌 뒤 늦게 깨어난 원래 워커의 쓰기를, DB가 쓰기 조건으로 거부하는 일 |
| 결과 미확정(UNCONFIRMED) | 보냈는지 모르는 상태. 외부 발송 내역을 조회해 확정한다(ADR-0002) |
| 조건부 UPDATE | "지금 상태가 X일 때만 Y로 바꾼다"는 한 문장. 동시에 여러 번 와도 한 번만 반영된다(ADR-0016) |
| 서킷 브레이커 | 외부 장애로 보이면 모든 워커의 발송을 잠시 멈추는 장치(ADR-0014) |
| 시험 발송 | 멈춘 뒤 다시 보내기 전에, 모든 워커를 합쳐 한 건만 보내 외부가 살아났는지 보는 것 |

용어의 정확한 정의는 [CONTEXT.md](../../CONTEXT.md)에 있다.

## 전체 목록

### 원칙과 범위

| ADR | 결정 |
| --- | --- |
| [0001](0001-scope-includes-optional-features.md) | 긴급 알림과 워커 다중화를 처음부터 설계에 넣는다 |
| [0005](0005-minimize-dependencies-by-design.md) | 이미 가진 것으로 안 될 때만 구성 요소를 더한다 |
| [0038](0038-spec-first-implementation-loop.md) | 구현과 독립 심사를 되풀이하고, 원본 명세를 기준점으로 삼는다 |

### 중복과 누락 막기

| ADR | 결정 |
| --- | --- |
| [0002](0002-reconcile-unconfirmed-sends-via-clientref.md) | 보냈는지 모르는 건은 clientRef로 조회한 뒤에만 다시 보낸다 |
| [0004](0004-ownership-by-lease-and-fencing.md) | 가져간 건에 기한(30초)을 적고, 늦은 쓰기는 owner와 시도 번호로 막는다 |
| [0007](0007-worker-shutdown-two-exits.md) | 워커가 내려가면 쥐고 있던 건은 반납되거나, 기한이 지나 넘겨받힌다 |
| [0032](0032-delivery-status-model.md) | Delivery 상태는 여섯 개이고, 모든 전이는 조건부 UPDATE다 |
| [0037](0037-runtime-and-base-tools.md) | 요청 바이트를 커널에 다 넘겼는지로 "보냈는지 모름"을 가른다(런타임과 도구도 여기에) |

### 저장소와 대기열

| ADR | 결정 |
| --- | --- |
| [0003](0003-postgres-only-no-redis.md) | PostgreSQL 하나로 상태, 대기열, 처리량 제한을 처리한다 |
| [0036](0036-drizzle-on-pg-driver.md) | DB 접근은 Drizzle로 하고, SQL은 저장소 파일에만 둔다 |

### 처리량과 우선순위

| ADR | 결정 |
| --- | --- |
| [0009](0009-shared-token-bucket-in-postgres.md) | 모든 워커가 PG의 토큰 버킷 행 하나를 함께 쓴다(초당 50, 용량 10) |
| [0011](0011-urgent-first-by-claim-order.md) | 토큰을 먼저 받고 우선순위 순으로 꺼내, 긴급 건이 먼저 나간다 |
| [0012](0012-fifo-between-alarms-within-priority.md) | 같은 우선순위에서는 먼저 시작한 알림부터 끝낸다 |
| [0013](0013-concurrency-cap-and-socket-pool.md) | 워커당 동시 발송 50, 소켓 50, 작업 루프 전용 DB 풀 |
| [0010](0010-two-workers-one-process-per-container.md) | 워커는 기본 2대, 컨테이너 하나에 프로세스 하나 |

### 실패와 장애

| ADR | 결정 |
| --- | --- |
| [0014](0014-retry-backoff-and-send-circuit-breaker.md) | 건별 재시도(최대 8번)와 서킷 브레이커, 시험 발송 한 건으로 복구 확인 |
| [0039](0039-unexpected-errors-never-kill-the-process.md) | 예상하지 못한 오류로 죽지 않고, 요청에는 반드시 응답한다 |
| [0026](0026-health-checks-live-and-ready.md) | 생존과 준비를 나누고, worker의 생존은 작업 루프가 도는가로 본다 |

### 알림의 생애

| ADR | 결정 |
| --- | --- |
| [0008](0008-alarm-status-model.md) | 알림 상태는 다섯 개이고, 발송 중 취소는 CANCELING을 거친다 |
| [0016](0016-state-transitions-by-conditional-update.md) | 상태 전이는 조건부 UPDATE 한 문장이고, 이미 목표 상태면 성공이다 |
| [0006](0006-recipient-expansion-single-owner-with-cursor-checkpoint.md) | 수신자 펼치기는 알림마다 워커 하나가 맡고, 페이지마다 커서를 저장한다 |
| [0017](0017-cancel-in-two-steps.md) | 취소는 알림 상태를 먼저 바꾸고, 대기 건은 워커가 정리한다 |
| [0018](0018-derived-counts-and-last-writer-completion.md) | 건수는 조회할 때 세고, 완료는 마지막 결과 기록이 판정한다 |
| [0029](0029-alarm-timestamps.md) | 알림 시각 세 개를 상태를 바꾸는 문장에서 함께 적는다 |

### API

| ADR | 결정 |
| --- | --- |
| [0015](0015-api-resources-and-action-endpoints.md) | alarms 리소스와 동작 경로(send, cancel), 수신자별 결과 조회 |
| [0019](0019-problem-details-and-trace-id.md) | 오류는 RFC 9457 Problem Details, 추적 ID는 W3C 형식 |
| [0020](0020-http-status-codes.md) | 진행 중이면 202, 끝났으면 200, 검증 실패는 400, 메서드가 틀리면 405, JSON이 아니면 415 |
| [0021](0021-alarm-creation-validation-and-title.md) | 생성은 엄격하게 검증하고, 제목은 보내지 않는다 |
| [0022](0022-no-idempotency-key-for-creation.md) | 생성의 중복 요청은 막지 않는다(생성만으로는 아무것도 나가지 않는다) |
| [0023](0023-alarm-is-a-send-event-with-content-snapshot.md) | 알림은 발송 한 번이고 보낸 내용을 그대로 가진다 |
| [0024](0024-keyset-pagination.md) | 목록은 커서 방식으로 나눈다 |
| [0033](0033-minimal-api-key-auth-and-management-port.md) | 업무 API에는 고정 API 키, 헬스체크와 메트릭은 관리 포트 |

### 운영

| ADR | 결정 |
| --- | --- |
| [0025](0025-compose-layout-and-separate-migration-with-db-roles.md) | 이미지 하나와 진입점 셋, 마이그레이션은 DDL 권한 계정으로 따로 |
| [0027](0027-prometheus-metrics-with-optional-monitoring-profile.md) | Prometheus 메트릭, 수집은 선택 프로필 |
| [0028](0028-structured-logs-with-masking.md) | 표준 출력 JSON 로그, 비밀정보는 로거 한 곳에서 가린다 |
| [0030](0030-config-from-env-validated-at-startup.md) | 설정은 환경변수, 기동할 때 관계까지 검사 |
| [0031](0031-data-growth-and-retention-plan.md) | 데이터 보존 대책은 설계만 남긴다 |

### 테스트

| ADR | 결정 |
| --- | --- |
| [0034](0034-test-quality-strategy.md) | 테스트는 "ADR의 보장을 지키는가"로 판정하고, 네 층으로 검증한다 |
| [0035](0035-test-layers-and-environments.md) | 단위, 통합, 끝단 세 층이고, DB는 늘 실제 PostgreSQL이다 |

## 문서 형식

- 제목은 결정을 한 문장으로 적는다.
- 본문은 `배경`(왜 이 결정이 필요했나)으로 시작하고, `결정`, 이유, 대가나 한계, `검토한 후보`를 담는다. 조건이 바뀌면 다시 따질 결정에는 `다시 볼 조건`을 둔다.
- 전문 용어는 처음 나올 때 풀어 쓴다.
- 다른 결정은 `ADR-0004`처럼 번호로 가리킨다.
