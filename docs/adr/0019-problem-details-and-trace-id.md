# 에러 응답은 RFC 9457 Problem Details로, 추적 ID는 W3C Trace Context 형식으로 직접 만든다

## 에러 형식

모든 에러는 `Content-Type: application/problem+json`의 RFC 9457 형식으로 응답한다.

```json
{
  "type": "/problems/invalid-state",
  "title": "현재 상태에서 할 수 없는 요청",
  "status": 409,
  "detail": "취소된 알림은 발송을 시작할 수 없습니다.",
  "instance": "/v1/alarms/0193.../send",
  "currentStatus": "CANCELED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

- 클라이언트는 `type`으로 분기한다. 종류별 `type` 목록은 OpenAPI 문서에 둔다.
- 확장 필드는 필요한 곳에만 붙인다. 입력 검증 실패에는 필드별 오류 목록(`errors`), 409에는 현재 상태(`currentStatus`)를 붙인다.
- 모든 에러에 `traceId`를 붙이고 같은 값을 로그에 남겨, 문의가 오면 그 요청의 로그를 바로 찾을 수 있게 한다.
- 500에는 내부 정보(스택 트레이스, SQL)를 담지 않는다. 상세는 로그에만 남긴다.

## 추적 ID

- 요청에 `traceparent` 헤더(W3C Trace Context)가 있으면 그 trace-id를 이어 쓰고, 없으면 16바이트 무작위 값으로 만든다.
- `AsyncLocalStorage`에 담아 요청 처리 중 모든 로그 줄과 에러 응답에 붙인다. Node 기본 기능만 쓴다.
- 워커의 비동기 작업은 요청 바깥에서 일어나므로 alarmId, deliveryId, attempt를 로그에 붙여 추적한다.

## OpenTelemetry를 지금 넣지 않는 이유

운영자가 묻는 질문별로 답하는 수단을 나누면, OTel tracing만 답할 수 있는 질문은 하나다.

| 질문 | 답하는 수단 |
| --- | --- |
| 이 알림은 언제 시작했고, 얼마나 남았고, 언제 끝났나 | 알림 시각(ADR-0029), 상태별 건수 (단건 조회) |
| 시스템이 지금 초당 몇 건을 보내고, 429·오류는 얼마나 나나 | 메트릭 |
| 이 수신자는 왜 실패했나 | 워커 구조화 로그(deliveryId 검색), Delivery의 마지막 에러 |
| 이 API 요청은 왜 느렸나 | 추적 ID 로그 (OTel이 가장 잘하는 영역) |

- trace를 보려면 수집기와 백엔드(Jaeger 등) 컨테이너가 더 필요하다.
- 발송의 대부분은 요청이 끝난 뒤 워커에서 33분 동안 일어난다. 이를 한 trace로 묶으면 구간이 10만 개가 되어 쓸모가 없고, 비동기 작업의 추적 키는 alarmId·deliveryId다.
- API 요청은 수 ms라 마지막 질문의 비중이 가장 작다.

추적 ID 형식이 이미 W3C 표준이므로, 추적 백엔드가 있는 환경이 되면 OTel SDK를 붙여 기존 로그와 그대로 잇는다.

## 검토한 후보

- **NestJS 기본 에러 형식 `{ statusCode, message, error }`**: 표준이 아니고, 검증 실패 시 `message`가 문자열에서 배열로 바뀌어 모양이 일정하지 않다.
- **자체 봉투 `{ success, error: { code, message } }`**: 표준이 아니고, 성공 응답까지 감싸면 HTTP 상태 코드와 정보가 중복된다.
- **mock과 같은 `{ code, message }`**: 필드별 오류나 추적 ID를 붙이는 규칙이 없다.
- **OpenTelemetry SDK 즉시 도입**: 위의 이유.
