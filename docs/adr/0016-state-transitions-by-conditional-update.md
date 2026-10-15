# Alarm 상태 전이는 조건부 UPDATE 한 문장으로 하고, 응답은 "이미 목표 상태인가"로 정한다

ADR-0008의 상태 머신에서 각 전이(화살표)는 확인과 변경을 한 문장으로 묶은 조건부 UPDATE로 실행한다.

```sql
UPDATE alarms SET status = 'SENDING', ... WHERE id = $1 AND status = 'CREATED'
```

같은 전이가 동시에 여러 번 와도 행 잠금으로 한쪽만 성공하고, 나머지는 0건이 갱신된다. 먼저 읽고 나서 쓰는 방식(SELECT 후 UPDATE)은 그 사이에 다른 요청이 끼어들 틈이 있어 쓰지 않는다.

## 전이표와 응답

| 요청 | 현재 상태 | 결과 |
| --- | --- | --- |
| 발송 시작 | CREATED | SENDING으로 전이 |
| 발송 시작 | SENDING, COMPLETED | 성공, 변경 없이 현재 상태 반환 |
| 발송 시작 | CANCELING, CANCELED | 409 Conflict |
| 취소 | CREATED | CANCELED로 전이 |
| 취소 | SENDING | CANCELING으로 전이 |
| 취소 | CANCELING, CANCELED | 성공, 변경 없이 현재 상태 반환 |
| 취소 | COMPLETED | 409 Conflict |

- **이미 목표 상태면 성공이다.** 응답을 못 받아 재시도한 클라이언트가 에러를 받지 않게 한다.
- **목표 상태로 갈 수 없을 때만 409다.** 409 응답에는 현재 상태를 담는다.
- UPDATE가 0건이면 현재 상태를 다시 읽어 위 표로 응답을 정한다. 상태는 앞으로만 움직이므로(CREATED → SENDING → COMPLETED, CANCELING → CANCELED) 다시 읽는 사이 상태가 바뀌어도 표의 답은 같다.

## 검토한 후보

- **이미 시작된 알림에 대한 시작 요청에 409**: 재시도한 클라이언트가 실제로는 성공했는데도 에러를 받는다.
- **`Idempotency-Key` 헤더로 요청 단위 중복 제거**: 키와 응답을 저장할 곳이 따로 필요하다. 시작·취소처럼 결과가 상태로 남는 요청은 상태만으로 판단할 수 있다.
