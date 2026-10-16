# DB 스키마

지금까지의 결정을 테이블 단위로 모은 것이다. 상태 값은 PG enum 대신 `text` + `CHECK`로 둔다. 값 추가·변경이 마이그레이션 한 줄로 끝나기 때문이다.

## alarms

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `id` | `uuid` PK, 기본값 `uuidv7()` | ADR-0037 |
| `type` | `text` NOT NULL, `BULK` · `URGENT` | ADR-0021 |
| `title` | `text` NOT NULL, 1~100자 | 관리용 이름(ADR-0021, 0023) |
| `body` | `text` NOT NULL, 1~1000자 | 보낸 내용의 스냅숏(ADR-0023) |
| `status` | `text` NOT NULL, 기본 `CREATED` | `CREATED` · `SENDING` · `CANCELING` · `CANCELED` · `COMPLETED` (ADR-0008) |
| `start_seq` | `bigint` NULL | 알림 시작 순번. 발송 시작 시 시퀀스에서 받는다(ADR-0012) |
| `expansion_cursor` | `text` NULL | 다음에 읽을 사용자 API 커서(ADR-0006) |
| `expansion_done` | `boolean` NOT NULL, 기본 `false` | URGENT는 발송 시작 시 `true` |
| `expansion_owner` | `bigint` NULL | 펼치기를 쥔 워커 ID(ADR-0004, 0006) |
| `cleanup_done` | `boolean` NOT NULL, 기본 `false` | 취소 정리 완료 여부(ADR-0017) |
| `cleanup_owner` | `bigint` NULL | 취소 정리를 쥔 워커 ID |
| `created_at` | `timestamptz` NOT NULL, 기본 `now()` | ADR-0029 |
| `started_at` | `timestamptz` NULL | ADR-0029 |
| `finished_at` | `timestamptz` NULL | ADR-0029 |

- 인덱스: `(status, id)` (목록 필터), `start_seq` 유일(NULL 제외)

## alarm_recipients

긴급 알림의 수신자 정의다. "누구에게 보낼지"이며, 실제 발송 기록인 `deliveries`와 구별한다.

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `alarm_id` | `uuid` NOT NULL, FK → `alarms.id` | |
| `recipient_id` | `text` NOT NULL | 외부 사용자 ID |

- PK: `(alarm_id, recipient_id)`. 중복 수신자를 DB에서도 막는다(ADR-0021).
- 긴급 알림 생성 시 1~100행을 넣고, 발송 시작 트랜잭션에서 이 행들로 Delivery를 만든다(ADR-0011). 대량 알림은 쓰지 않는다.
- 생성 시점에 Delivery를 바로 만들지 않는 이유: 시작 전 긴급 알림의 대기 건이 꺼내기 인덱스의 맨 앞(우선순위 0)에 쌓여, 초안이 많을수록 매 꺼내기가 그 건들을 훑고 지나가며 느려진다.

## deliveries

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `id` | `bigint` PK, 자동 증가 | ADR-0037 |
| `alarm_id` | `uuid` NOT NULL, FK → `alarms.id` | |
| `recipient_id` | `text` NOT NULL | 외부 사용자 ID |
| `priority` | `smallint` NOT NULL | 긴급 0, 대량 1. 알림 종류의 복사본(ADR-0011) |
| `start_seq` | `bigint` NOT NULL | 알림 시작 순번의 복사본(ADR-0012) |
| `status` | `text` NOT NULL, 기본 `PENDING` | `PENDING` · `IN_FLIGHT` · `UNCONFIRMED` · `SENT` · `FAILED` · `CANCELED` (ADR-0032) |
| `attempts` | `integer` NOT NULL, 기본 0 | 발송 시도 횟수. 펜싱 조건에도 쓴다(ADR-0004, 0014) |
| `lookup_failures` | `integer` NOT NULL, 기본 0 | 이번 결과 미확정 동안 연달아 실패한 조회 수. 조회 재시도 간격을 정하고, 결과 미확정이 될 때마다 0으로 되돌린다(ADR-0014) |
| `next_attempt_at` | `timestamptz` NOT NULL, 기본 `now()` | PENDING일 때 꺼낼 수 있는 시각(ADR-0014) |
| `reconcile_after` | `timestamptz` NULL | UNCONFIRMED일 때 조회할 수 있는 시각(ADR-0002) |
| `owner` | `bigint` NULL | 쥐고 있는 워커 ID(ADR-0004) |
| `claimed_at` | `timestamptz` NULL | 마지막으로 꺼낸 시각. "가장 오래된 진행 중 건" 메트릭(ADR-0027) |
| `message_id` | `text` NULL | 외부 Message ID |
| `sent_at` | `timestamptz` NULL | 발송 완료 시각 |
| `last_error_code` | `text` NULL | 마지막 에러 코드(ADR-0014) |
| `last_error_message` | `text` NULL | 마지막 에러 메시지 |
| `duplicate_detected` | `boolean` NOT NULL, 기본 `false` | 중복 탐지 표시(ADR-0004) |
| `created_at` | `timestamptz` NOT NULL, 기본 `now()` | |
| `updated_at` | `timestamptz` NOT NULL, 기본 `now()` | |

- 제약: `UNIQUE (alarm_id, recipient_id)` (ADR-0006)
- 인덱스:

| 인덱스 | 조건 | 쓰는 곳 |
| --- | --- | --- |
| `(priority, start_seq, id)` | `WHERE status = 'PENDING'` | 꺼내기(ADR-0011, 0012) |
| `(reconcile_after)` | `WHERE status = 'UNCONFIRMED'` | 결과 확인 대상 찾기(ADR-0002) |
| `(owner)` | `WHERE status IN ('IN_FLIGHT', 'UNCONFIRMED')` | 넘겨받기 대상 찾기(ADR-0004) |
| `(alarm_id)` | `WHERE status IN ('PENDING', 'IN_FLIGHT', 'UNCONFIRMED')` | 완료 판정 `NOT EXISTS`(ADR-0018) |
| `(alarm_id, status, recipient_id)` | 없음 | 상태별 건수, 상태로 거른 deliveries 목록 커서(ADR-0018, 0024) |

- deliveries 목록은 수신자 ID 순서로 나눈다. 상태로 거르지 않으면 유일 제약 `(alarm_id, recipient_id)`의 인덱스를, 거르면 위 인덱스를 그대로 순서대로 읽는다.

## rate_limiter (행 하나)

| 컬럼 | 타입 | 설명 |
| --- | --- | --- |
| `id` | `smallint` PK, `CHECK (id = 1)` | 행이 하나뿐임을 DB가 보장 |
| `tokens` | `double precision` NOT NULL | ADR-0009 |
| `refilled_at` | `timestamptz` NOT NULL | ADR-0009 |
| `paused_until` | `timestamptz` NOT NULL, 기본 `-infinity` | 429 정지와 서킷 브레이커 정지(ADR-0009, 0014) |
| `breaker_streak` | `smallint` NOT NULL, 기본 0 | 서킷 브레이커가 연달아 발동한 횟수. 정지 시간 = min(5초 × 2^streak, 60초) |
| `breaker_last_until` | `timestamptz` NOT NULL, 기본 `-infinity` | 직전 서킷 브레이커 정지가 풀리는 시각. 429 정지와 섞이지 않게 따로 둔다 |

- 서킷 브레이커의 "연달아"는 직전 브레이커 정지(`breaker_last_until`)가 풀린 뒤 60초 안에 다시 발동한 경우로 본다. 60초가 지나 발동하면 `breaker_streak`를 0부터 다시 센다.
- 이미 정지 중(`paused_until`이 미래)이면 발동하지 않는다. 여러 워커가 같은 장애를 동시에 감지해도 정지 시간이 겹쳐서 두 배씩 늘지 않게 하기 위해서다.
- 행은 마이그레이션(`drizzle/0001_seed_rate_limiter.sql`)이 넣는다.

## 워커 명단

테이블이 없다. `pg_locks`의 advisory lock과 `pg_stat_activity`가 명단이다(ADR-0004).

## DB 계정 (docker/postgres/init.sh)

| 계정 | 권한 | 쓰는 곳 |
| --- | --- | --- |
| 마이그레이션 계정 | 스키마 소유, DDL | migrate |
| 앱 계정 | 테이블 SELECT·INSERT·UPDATE·DELETE, 시퀀스 사용 | api, worker |

앱 계정 권한은 이후 만들어지는 테이블에도 적용되도록 기본 권한(`ALTER DEFAULT PRIVILEGES`)으로 준다.
