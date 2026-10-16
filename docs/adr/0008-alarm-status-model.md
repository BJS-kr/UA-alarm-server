# ADR-0008. 알림 상태는 다섯 개이고, 발송 중 취소는 CANCELING을 거친다

## 결정

```
CREATED ──발송 시작──▶ SENDING ──모든 Delivery 종료──▶ COMPLETED
   │                      │
   │ 취소                  │ 취소 요청, 또는 수신자 조회의 영구 오류
   ▼                      ▼
CANCELED ◀──남은 건 정리── CANCELING
```

- **발송 중인 알림을 취소하면 CANCELING이 된다.** 새 발송은 바로 멈추고, 이미 나간 요청과 결과 미확정 건이 모두 정리되면 CANCELED가 된다.
- **시작 전(CREATED) 알림은 바로 CANCELED가 된다.** 나간 요청이 없기 때문이다.
- **시스템도 알림을 CANCELING으로 돌린다.** 수신자 조회가 다시 해도 안 되는 오류(400, 401, 403, 404)로 실패한 경우다(ADR-0006). 누가 멈췄는지는 취소 이유(`REQUESTED`, `EXPANSION_FAILED`)로 구별한다(ADR-0017).
- **일부 Delivery가 실패해도 COMPLETED다.** 결과는 성공과 실패 건수로 보여 준다.
- **COMPLETED와 CANCELED는 끝 상태다.** 더 바뀌지 않는다.

## 이유

취소하는 순간 이미 나간 요청은 되돌릴 수 없다. 바로 CANCELED로 두면, 그 뒤에 도착하는 결과 때문에 취소된 알림의 건수가 계속 바뀐다. CANCELING을 거치면 CANCELED가 된 뒤에는 건수가 고정된다.

## 검토한 후보

- **취소하면 바로 CANCELED**: 취소 뒤에도 건수가 바뀌어 상태와 숫자가 어긋난다.
- **부분 실패 상태(PARTIALLY_FAILED 등)**: 수신 거부 사용자가 약 1%라서 거의 모든 대량 알림이 이 상태가 된다. 상태가 정보를 주지 못한다.
