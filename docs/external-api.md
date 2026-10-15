# 외부 발송 API (mock) 계약 요약

설계 판단의 근거가 되는 mock 서버(`ghcr.io/us-all/backend-assignment-api:1.2`, 포트 4000)의 문서상 계약이다. 문서로는 알 수 없어 직접 측정한 동작은 [mock-observations.md](./mock-observations.md)에 따로 정리했다.

## 엔드포인트

| 용도 | 요청 | 응답 |
| --- | --- | --- |
| 사용자 조회 | `GET /v1/users?cursor=&limit=` (limit 1~1000, 기본 100) | `200 { users: [{id, name, phone}], nextCursor: string \| null }` |
| 메시지 발송 | `POST /v1/messages { alarmId, recipientId, body, clientRef? }` | `202 { messageId }` |
| 발송 내역 조회 | `GET /v1/messages?clientRef=` | `200 { messages: [{messageId, recipientId, sentAt}] }` (없으면 빈 배열, 같은 clientRef로 여러 번 보냈으면 모두) |
| 헬스체크 | `GET /health` | `200 { ok: true }` |

- 발송 요청 본문에 `title` 필드가 없다. `body`만 있다.
- 발송은 수신자 1명 단위다. 배치 발송 API는 없다.

## 에러

본문: `{ code, message }`

| 상태 | code | 발송 여부 | 성격 |
| --- | --- | --- | --- |
| 400 | INVALID_REQUEST | 안 됨 | 영구 (우리 버그) |
| 400 | UNKNOWN_RECIPIENT | 안 됨 | 영구 |
| 400 | RECIPIENT_BLOCKED | 안 됨 | 영구 (약 1% 사용자, 항상 실패) |
| 429 | RATE_LIMITED | 안 됨 | 일시, `Retry-After`(초) 포함 |
| 500 | INTERNAL_ERROR | 안 됨 | 일시 |
| 503 | SERVICE_UNAVAILABLE | 안 됨 | 일시 |

## 동작 특성

- 처리량 제한: `POST /v1/messages` 전체 합산 초당 50건. 사용자 조회·내역 조회는 제한 대상이 아니다.
- 일시 오류 약 5% (500/503).
- 약 2%는 **발송은 처리되지만** 응답이 30초 뒤에 온다.
- 약 5%는 3초 이상 걸린다.
- 중복 제거를 하지 않는다. `clientRef`는 저장만 하고, 내역 조회로 확인할 수 있다.

## 환경변수 (개발 중 조정 가능)

`PORT`(4000), `USER_COUNT`(100000), `RATE_LIMIT`(50), `ERROR_RATE`(0.05), `TIMEOUT_RATE`(0.02), `TIMEOUT_MS`(30000), `SLOW_RATE`(0.05), `SLOW_MS`(3000), `BLOCKED_PERCENT`(1), `SEED`(42)
