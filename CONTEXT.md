# 도메인 용어 정의 (Ubiquitous Language)

외부 발송 서비스와 연동하여 수신자별 알림을 발송하고 결과를 추적하는 시스템의 핵심 도메인 모델과 용어를 정의한다. 코드, 스키마, 문서 전반에서 동일한 용어를 사용한다.

## 도메인 모델

**Alarm (알림)**:
단일 발송 요청 단위. 발송 시점의 콘텐츠 스냅숏(제목·본문), 알림 유형(`BULK`·`URGENT`), 진행 상태를 가진다. 동일한 내용이라도 재발송 시 별도의 `Alarm`으로 생성한다.
_Avoid_: Notification, Message, Campaign, Template

**Bulk Alarm (대량 알림)**:
외부 사용자 API에 등록된 전체 사용자를 수신 대상으로 하는 알림.
_Avoid_: Broadcast, 일반 알림

**Urgent Alarm (긴급 알림)**:
생성 시 수신자 ID 목록(최대 100명)을 직접 지정하며, 발송 점유 순서에서 `Bulk Alarm`보다 우선 처리되는 알림.
_Avoid_: Priority alarm, Transactional

### Alarm 상태 (`AlarmStatus`)

- **`CREATED`**: 알림이 생성되었으나 발송이 시작되지 않은 초기 상태.
- **`SENDING`**: 발송이 시작되어 수신자 확장 및 `Delivery` 발송이 진행 중인 상태.
- **`CANCELING`**: 발송 취소 요청 또는 수신자 확장의 영구 오류로 인해 신규 발송 점유가 중단되고, 잔여 대기 건 취소 및 이미 전송 중이던 요청의 결과 확정을 기다리는 과도기 상태.
- **`CANCELED`**: 모든 잔여 작업 정리가 완료되어 상태별 건수가 최종 확정된 취소 상태.
- **`COMPLETED`**: 모든 `Delivery`가 최종 상태(`SENT` 또는 `FAILED`)에 도달한 완료 상태. 일부 수신자 발송이 실패하더라도 `COMPLETED`로 전환된다.
  _Avoid_: DONE, FINISHED, PARTIALLY_FAILED

**Cancel Reason (`cancel_reason`)**:
알림이 취소된 사유 코드. 사용자 요청에 의한 취소인 `REQUESTED`와 외부 사용자 API 조회의 영구 오류로 인해 시스템이 중단한 `EXPANSION_FAILED`로 구분한다.

### 수신자 및 발송 작업

**Recipient (수신자)**:
알림 수신 대상 사용자. 외부 사용자 API의 사용자 ID(`recipientId`)로 식별한다.
_Avoid_: User, Target

**Delivery (발송 건)**:
단일 `Alarm`을 단일 `Recipient`에게 발송하는 개별 작업 단위이자 큐 레코드. 수신자별 발송 상태와 시도 횟수를 보유한다.
_Avoid_: Job, Task, Send

**Expansion (수신자 확장)**:
`Bulk Alarm`의 전체 수신자 목록을 외부 사용자 API에서 페이지 단위로 조회하여 `deliveries` 테이블의 행으로 생성하는 과정.
_Avoid_: Fan-out, Import, 수신자 생성

**Claim (작업 점유)**:
워커가 발송 가능한 `PENDING` 상태의 `Delivery`를 `FOR UPDATE SKIP LOCKED`로 조회하여 `IN_FLIGHT`로 변경하고, 소유권(`owner`)과 리스 만료 시각(`lease_until`)을 기록하는 작업.

**Attempt (발송 시도)**:
단일 `Delivery`를 외부 발송 API로 전송하는 개별 시도. 일시 오류 발생 시 단일 `Delivery`에 대해 여러 번의 `Attempt`가 수행될 수 있다.
_Avoid_: Retry (재시도는 두 번째 이후의 `Attempt`를 지칭할 때만 사용)

**Reconciliation (결과 조회 및 확정)**:
타임아웃 등으로 전송 성공 여부를 확정할 수 없는 `UNCONFIRMED` 상태의 `Delivery`에 대해 외부 발송 내역 API(`GET /v1/messages?clientRef=`)를 조회하여 `SENT` 확정 또는 `PENDING` 재전환을 결정하는 과정.
_Avoid_: Verify, 재확인

### Delivery 상태 (`DeliveryStatus`)

- **`PENDING`**: 발송 대기 중이거나 다음 재시도 시각(`next_attempt_at`)을 기다리는 상태.
- **`IN_FLIGHT`**: 워커가 점유(`owner`, `lease_until`)하여 외부 발송 API 호출을 수행 중인 상태.
  _Avoid_: SENDING (`AlarmStatus`와 혼동 방지)
- **`UNCONFIRMED`**: 요청 전송 후 응답 타임아웃이나 연결 끊김, 또는 리스 만료로 인해 실제 발송 성공 여부를 알 수 없어 `Reconciliation`을 기다리는 상태.
- **`SENT`**: 외부 발송 API의 접수(`202`) 또는 발송 내역 조회를 통해 발송 완료가 확인된 최종 상태.
- **`FAILED`**: 영구 오류(`400`)를 수신했거나 최대 시도 횟수(8회)를 소진한 최종 상태.
- **`CANCELED`**: 알림 취소로 인해 발송하지 않고 종료된 최종 상태.

### 소유권 및 장애 복구

**Owner (소유자)**:
`Delivery` 발송, 수신자 확장(`Expansion`), 취소 정리 작업을 현재 점유 중인 워커 식별자. 워커 프로세스 기동 시 생성되는 무작위 정수 ID를 사용한다.

**Lease (리스)**:
점유한 작업에 부여되는 유효 만료 시각(`lease_until`). 해당 시각까지 결과가 기록되지 않으면 다른 워커가 소유권을 회수할 수 있다. 모든 시각 비교는 PostgreSQL 서버 시계(`clock_timestamp()`)를 기준으로 수행한다.
_Avoid_: 잠금, 하트비트, 기한

**Takeover (리스 만료 회수 / 인계)**:
리스(`lease_until`)가 만료된 `IN_FLIGHT` 상태의 `Delivery`를 `UNCONFIRMED`로 전환하고 `owner`를 해제하는 작업. 회수된 건은 반드시 `Reconciliation`을 거친 뒤에만 재발송 여부가 결정된다.

**Fencing (펜싱)**:
점유 기반 상태 변경 시 `owner`와 `attempts`(또는 커서) 일치 여부를 `WHERE` 조건으로 검증하는 장치. 리스 만료로 소유권이 회수된 뒤 뒤늦게 깨어난 워커의 상태 덮어쓰기를 0건 갱신으로 차단한다.

**Probe (프로브 / 시험 발송)**:
서킷 브레이커가 열린(`breaker_open = true`) 상태에서 정지 시간(`paused_until`)이 경과했을 때, 외부 API 복구 여부를 확인하기 위해 전체 워커를 통틀어 단 1건만 발송을 허용하는 동작. 성공 시 브레이커를 닫는다.

**Message (외부 메시지)**:
외부 발송 서비스가 발송 요청을 접수하여 생성한 발송 레코드. 외부 서비스 도메인의 개념이며 `messageId`로 식별한다.
_Avoid_: Alarm (내부 도메인 모델과 혼동 금지)
