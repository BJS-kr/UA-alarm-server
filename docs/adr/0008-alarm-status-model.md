# Alarm 상태는 다섯 개, 진행 중 취소는 CANCELING을 거친다

```
CREATED ──발송 시작──▶ SENDING ──모든 Delivery 종료──▶ COMPLETED
   │                      │
   │ 취소                  │ 취소
   ▼                      ▼
CANCELED ◀──남은 건 정리── CANCELING
```

- 발송 중인 알림을 취소하면 CANCELING이 된다. 새 발송은 즉시 멈추고, 이미 나간 요청과 결과 미확정 건이 모두 정리되면 CANCELED가 된다. 취소 시점에 이미 나간 요청은 회수할 수 없으므로, 바로 CANCELED로 두면 그 뒤에 도착한 결과 때문에 취소된 알림의 건수가 계속 바뀐다. CANCELED가 된 뒤에는 건수가 고정된다.
- 시작 전(CREATED) 알림은 나간 요청이 없으므로 바로 CANCELED가 된다.
- 일부 Delivery가 실패해도 COMPLETED이며, 성공·실패 건수로 결과를 표현한다.
- COMPLETED와 CANCELED는 종료 상태이며 더 바뀌지 않는다.

## 검토한 후보

- **취소 즉시 CANCELED**: 취소 이후에도 건수가 바뀌어 상태와 숫자가 어긋난다.
- **부분 실패 상태(PARTIALLY_FAILED 등)**: 수신 거부 사용자가 약 1%라 거의 모든 대량 알림이 이 상태가 되어 정보가 없다.
