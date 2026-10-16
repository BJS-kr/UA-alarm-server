# DB 스키마 명세

PostgreSQL 18 기반 테이블 및 인덱스 명세다. 상태 및 유형 컬럼은 값 추가·변경 시 마이그레이션 단순화를 위해 PostgreSQL `ENUM` 대신 `text`와 `CHECK` 제약을 사용한다.

## alarms

| 컬럼                                    | 타입                                          | 설명                                                                                                     |
| --------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `id`                                    | `uuid` PK, 기본값 `uuidv7()`                  | 알림 식별자 (ADR-0037)                                                                                   |
| `type`                                  | `text` NOT NULL, `BULK` · `URGENT`            | 알림 유형 (ADR-0021)                                                                                     |
| `title`                                 | `text` NOT NULL, 1~100자                      | 관리용 식별 제목 (ADR-0021, 0023)                                                                        |
| `body`                                  | `text` NOT NULL, 1~1000자                     | 발송 본문 스냅숏 (ADR-0023)                                                                              |
| `status`                                | `text` NOT NULL, 기본 `CREATED`               | `CREATED` · `SENDING` · `CANCELING` · `CANCELED` · `COMPLETED` (ADR-0008)                                |
| `start_seq`                             | `bigint` NULL                                 | 발송 시작 순번. 발송 시작 시 시퀀스에서 할당 (ADR-0012)                                                  |
| `expansion_cursor`                      | `text` NULL                                   | 다음 조회할 외부 사용자 API 페이지 커서 (ADR-0006)                                                       |
| `expansion_done`                        | `boolean` NOT NULL, 기본 `false`              | 수신자 확장 완료 여부 (`URGENT`는 발송 시작 시 `true`)                                                   |
| `expansion_owner`                       | `bigint` NULL                                 | 수신자 확장 작업을 점유한 워커 ID (ADR-0004, 0006)                                                       |
| `expansion_lease_until`                 | `timestamptz` NULL                            | 수신자 확장 리스 만료 시각. 페이지 조회마다 연장하며 만료 시 다른 워커가 인계 (ADR-0004)                 |
| `cleanup_done`                          | `boolean` NOT NULL, 기본 `false`              | 취소 시 잔여 대기 건 정리 완료 여부 (ADR-0017)                                                           |
| `cleanup_owner`                         | `bigint` NULL                                 | 취소 정리를 점유한 워커 ID                                                                               |
| `cleanup_lease_until`                   | `timestamptz` NULL                            | 취소 정리 리스 만료 시각 (ADR-0004)                                                                      |
| `cancel_reason`                         | `text` NULL, `REQUESTED` · `EXPANSION_FAILED` | 취소 사유: 사용자 취소 요청(`REQUESTED`) 또는 수신자 조회 영구 오류(`EXPANSION_FAILED`) (ADR-0006, 0017) |
| `last_error_code`, `last_error_message` | `text` NULL                                   | 시스템 중단 시 마지막 오류 코드 및 메시지 (ADR-0006)                                                     |
| `created_at`                            | `timestamptz` NOT NULL, 기본 `now()`          | 생성 시각 (ADR-0029)                                                                                     |
| `started_at`                            | `timestamptz` NULL                            | 발송 시작 시각 (ADR-0029)                                                                                |
| `finished_at`                           | `timestamptz` NULL                            | 완료 또는 취소 확정 시각 (ADR-0029)                                                                      |

- 인덱스: `(status, id)` (목록 필터링), `start_seq` UNIQUE (`WHERE start_seq IS NOT NULL`)

## alarm_recipients

긴급 알림(`URGENT`) 생성 시 지정된 수신자 목록을 저장하는 테이블이다. 발송 실행 기록인 `deliveries`와 분리되어 있다.

| 컬럼           | 타입                              | 설명           |
| -------------- | --------------------------------- | -------------- |
| `alarm_id`     | `uuid` NOT NULL, FK → `alarms.id` | 알림 ID        |
| `recipient_id` | `text` NOT NULL                   | 외부 사용자 ID |

- PK: `(alarm_id, recipient_id)` (중복 수신자 방지, ADR-0021).
- 긴급 알림 생성 시 1~100행을 삽입하고, 발송 시작 트랜잭션에서 이 행들을 기반으로 `deliveries`를 일괄 생성한다(ADR-0011). 대량 알림은 사용하지 않는다.
- 생성 시점에 `deliveries`를 바로 생성하지 않는 이유: 미발송 초안 상태의 긴급 알림 건들이 점유 부분 인덱스의 선두(`priority = 0`)에 적재되면, 실제 발송 중인 알림의 점유 쿼리가 초안 행들을 매번 스캔해야 하므로 인덱스 효율이 저하되기 때문이다.

## deliveries

| 컬럼                 | 타입                                 | 설명                                                                                                  |
| -------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `id`                 | `bigint` PK, 자동 증가               | 내부 식별자 및 정렬 기준 (ADR-0037)                                                                   |
| `alarm_id`           | `uuid` NOT NULL, FK → `alarms.id`    | 알림 ID                                                                                               |
| `recipient_id`       | `text` NOT NULL                      | 외부 사용자 ID                                                                                        |
| `priority`           | `smallint` NOT NULL                  | 긴급 `0`, 대량 `1` (알림 유형의 비정규화 복사본, ADR-0011)                                            |
| `start_seq`          | `bigint` NOT NULL                    | 알림 시작 순번의 비정규화 복사본 (ADR-0012)                                                           |
| `status`             | `text` NOT NULL, 기본 `PENDING`      | `PENDING` · `IN_FLIGHT` · `UNCONFIRMED` · `SENT` · `FAILED` · `CANCELED` (ADR-0032)                   |
| `attempts`           | `integer` NOT NULL, 기본 0           | 발송 시도 횟수 및 펜싱 검증 조건 (ADR-0004, 0014)                                                     |
| `lookup_failures`    | `integer` NOT NULL, 기본 0           | 현재 `UNCONFIRMED` 상태에서 연속 실패한 내역 조회 횟수 (`UNCONFIRMED` 진입 시 0으로 초기화, ADR-0014) |
| `next_attempt_at`    | `timestamptz` NOT NULL, 기본 `now()` | `PENDING` 상태에서 다음 점유가 허용되는 시각 (ADR-0014)                                               |
| `reconcile_after`    | `timestamptz` NULL                   | `UNCONFIRMED` 상태에서 외부 내역 조회가 허용되는 시각 (ADR-0002)                                      |
| `owner`              | `bigint` NULL                        | 현재 점유 중인 워커 ID (ADR-0004)                                                                     |
| `claimed_at`         | `timestamptz` NULL                   | 마지막 점유 시각 (`alarm_oldest_in_flight_seconds` 메트릭 산출용, ADR-0027)                           |
| `lease_until`        | `timestamptz` NULL                   | `IN_FLIGHT` 리스 만료 시각 (`clock_timestamp() + 30초`). 만료 시 다른 워커가 회수 (ADR-0004)          |
| `message_id`         | `text` NULL                          | 외부 발송 API가 반환한 `messageId`                                                                    |
| `sent_at`            | `timestamptz` NULL                   | 발송 완료 확정 시각                                                                                   |
| `last_error_code`    | `text` NULL                          | 마지막 오류 코드 (ADR-0014)                                                                           |
| `last_error_message` | `text` NULL                          | 마지막 오류 메시지                                                                                    |
| `duplicate_detected` | `boolean` NOT NULL, 기본 `false`     | 중복 발송 탐지 여부 플래그 (ADR-0004)                                                                 |
| `created_at`         | `timestamptz` NOT NULL, 기본 `now()` | 생성 시각                                                                                             |
| `updated_at`         | `timestamptz` NOT NULL, 기본 `now()` | 갱신 시각                                                                                             |

- 제약: `UNIQUE (alarm_id, recipient_id)` (ADR-0006)
- 인덱스 구성:

| 인덱스                             | 부분 인덱스 조건                                          | 용도                                                                                        |
| ---------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `(priority, start_seq, id)`        | `WHERE status = 'PENDING'`                                | 발송 대상 점유(`claim`) 쿼리 (ADR-0011, 0012)                                               |
| `(reconcile_after)`                | `WHERE status = 'UNCONFIRMED'`                            | 내역 조회(`Reconciliation`) 대상 탐색 (ADR-0002)                                            |
| `(lease_until)`                    | `WHERE status = 'IN_FLIGHT'`                              | 리스 만료 회수(`Takeover`) 대상 탐색 (ADR-0004)                                             |
| `(alarm_id)`                       | `WHERE status IN ('PENDING', 'IN_FLIGHT', 'UNCONFIRMED')` | 알림 완료 판정 `NOT EXISTS` 서브쿼리 (ADR-0018)                                             |
| `(alarm_id, status, recipient_id)` | 없음                                                      | 단건 조회 시 상태별 집계(`GROUP BY status`) 및 상태 필터 커서 페이지네이션 (ADR-0018, 0024) |

- `/deliveries` 목록 조회는 `recipient_id` 오름차순 커서 페이지네이션을 사용한다. `status` 필터 미지정 시 `UNIQUE (alarm_id, recipient_id)` 인덱스를, 지정 시 `(alarm_id, status, recipient_id)` 인덱스를 스캔한다.

## rate_limiter (단일 행 테이블)

| 컬럼                 | 타입                                     | 설명                                                                                                                  |
| -------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `smallint` PK, `CHECK (id = 1)`          | 단일 행 보장 제약                                                                                                     |
| `tokens`             | `double precision` NOT NULL              | 현재 잔여 토큰 수 (ADR-0009)                                                                                          |
| `refilled_at`        | `timestamptz` NOT NULL                   | 마지막 토큰 충전 계산 시각 (ADR-0009)                                                                                 |
| `paused_until`       | `timestamptz` NOT NULL, 기본 `-infinity` | 429 `Retry-After` 또는 서킷 브레이커에 의한 발송 일시 정지 해제 시각 (ADR-0009, 0014)                                 |
| `breaker_streak`     | `smallint` NOT NULL, 기본 0              | 서킷 브레이커 연속 발동 횟수 (`정지 시간 = min(5초 × 2^streak, 60초)`)                                                |
| `breaker_open`       | `boolean` NOT NULL, 기본 `false`         | 서킷 브레이커 열림 여부. 열림 상태에서는 정지 해제 후 프로브 1건만 허용하며 일시 오류를 시도 횟수에서 제외 (ADR-0014) |
| `probe_until`        | `timestamptz` NOT NULL, 기본 `-infinity` | 프로브 발송 진행 중 리스 만료 시각. 만료 시 다른 워커가 재시도 (ADR-0014)                                             |
| `breaker_last_until` | `timestamptz` NOT NULL, 기본 `-infinity` | 직전 서킷 브레이커 정지 해제 시각 (429 정지와 구분하여 연속 발동 여부 판정)                                           |

- 서킷 브레이커의 연속 발동(`breaker_streak` 증가)은 직전 브레이커 정지 해제 시각(`breaker_last_until`)으로부터 60초 이내에 재발동한 경우로 판정한다. 60초 경과 후 발동 시 `breaker_streak`를 0부터 다시 계산한다.
- 이미 정지 중(`paused_until > clock_timestamp()`)일 때는 중복 발동하지 않아, 다수의 워커가 동시에 장애를 감지하더라도 정지 시간이 중복 배가되지 않는다.
- 초기 단일 행은 마이그레이션(`drizzle/0001_seed_rate_limiter.sql`)에서 삽입한다.

## DB 계정 권한 분리 (`docker/postgres/init.sh`)

| 계정              | 권한                                                                | 사용 서비스     |
| ----------------- | ------------------------------------------------------------------- | --------------- |
| 마이그레이션 계정 | 스키마 소유권 및 DDL 권한                                           | `migrate`       |
| 애플리케이션 계정 | 테이블 `SELECT`·`INSERT`·`UPDATE`·`DELETE`, 시퀀스 `USAGE`·`SELECT` | `api`, `worker` |

애플리케이션 계정 권한은 `ALTER DEFAULT PRIVILEGES`를 통해 이후 생성되는 테이블과 시퀀스에도 자동 부여된다.
