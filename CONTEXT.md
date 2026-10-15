# 알림 발송 시스템

다수의 수신자에게 알림을 만들어 외부 발송 서비스로 내보내고, 수신자별 결과를 추적하는 시스템.

## Language

**Alarm (알림)**:
발송 한 번의 단위. 보낸 내용(제목·본문)의 스냅숏과 종류·상태를 가진다. 같은 내용을 다시 보내면 새 Alarm이다.
_Avoid_: Notification, Message, Campaign, Template

**Bulk Alarm (대량 알림)**:
전체 사용자에게 발송하는 Alarm.
_Avoid_: Broadcast, 일반 알림

**Urgent Alarm (긴급 알림)**:
생성 시 지정한 사용자(최대 100명)에게 발송하며, Bulk Alarm보다 먼저 처리되는 Alarm.
_Avoid_: Priority alarm, Transactional

### Alarm 상태

**CREATED (생성됨)**: 만들어졌지만 발송을 시작하지 않은 상태.

**SENDING (발송 중)**: 발송을 시작해 Delivery가 처리되고 있는 상태.

**CANCELING (취소 중)**: 취소를 요청받아 새 발송은 멈췄고, 이미 나간 요청의 결과를 정리하는 상태.

**CANCELED (취소됨)**: 취소가 끝나 건수가 더 바뀌지 않는 상태.

**COMPLETED (완료)**: 모든 Delivery가 성공 또는 실패로 끝난 상태. 실패가 섞여 있어도 완료다.
_Avoid_: DONE, FINISHED, PARTIALLY_FAILED

### 수신과 발송

**Recipient (수신자)**:
Alarm을 받을 사용자 한 명. 외부 사용자 API의 사용자 id로 식별한다.
_Avoid_: User, Target

**Delivery (발송 건)**:
한 Alarm을 한 Recipient에게 보내는 단위. 수신자별 발송 상태를 가진다.
_Avoid_: Job, Task, Send

**Expansion (수신자 펼치기)**:
Bulk Alarm의 수신자 전체를 외부 사용자 목록에서 받아 Delivery로 만드는 과정.
_Avoid_: Fan-out, Import, 수신자 생성

**Attempt (발송 시도)**:
한 Delivery를 외부 발송 API로 보내는 요청 한 번. 한 Delivery는 여러 Attempt를 가질 수 있다.
_Avoid_: Retry (재시도는 두 번째 이후 Attempt를 가리킬 때만)

**Reconciliation (결과 확인)**:
결과가 미확정인 Delivery를 외부 발송 내역 조회로 확인해, 발송 완료로 확정하거나 다시 보낼 대상으로 되돌리는 과정.
_Avoid_: Verify, 재확인

### Delivery 상태

**PENDING (대기)**: 꺼낼 수 있거나 재시도 시각을 기다리는 상태.

**IN_FLIGHT (전송 중)**: 워커가 쥐고 외부로 요청을 보내 응답을 기다리는 상태.
_Avoid_: SENDING (Alarm 상태 이름과 겹침)

**UNCONFIRMED (결과 미확정)**: 보냈는지 알 수 없어 Reconciliation을 기다리는 상태.

**SENT (발송 완료)**: 외부 서비스가 접수했음이 확인된 상태.

**FAILED (실패)**: 영구 실패이거나 재시도를 모두 쓴 상태.

**CANCELED (취소)**: Alarm 취소로 보내지 않은 상태.

**Message (외부 메시지)**:
외부 발송 서비스가 발송 요청 한 건을 접수해 남긴 기록. 외부 서비스의 개념이며 `messageId`로 식별한다.
_Avoid_: Alarm (우리 쪽 개념과 혼동 금지)
