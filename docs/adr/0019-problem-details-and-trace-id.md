# ADR-0019. 오류 응답은 RFC 9457 Problem Details로 하고, 추적 ID는 W3C Trace Context 형식으로 직접 만든다

## 배경

모든 오류가 같은 모양이어야 클라이언트가 한 가지 방식으로 처리할 수 있다. 또 오류가 났을 때 그 요청의 서버 로그를 바로 찾을 수 있어야 한다.

## 결정

- 모든 오류는 RFC 9457 Problem Details 형식(`Content-Type: application/problem+json`)으로 응답한다. Problem Details는 HTTP API의 오류 본문을 정한 표준이다.
- 모든 오류 응답과 로그에 같은 `traceId`를 붙인다. 형식은 W3C Trace Context의 trace-id다.
- OpenTelemetry는 지금 넣지 않는다.

## 오류 형식

```json
{
  "type": "/problems/invalid-state",
  "title": "Not allowed in the current state",
  "status": 409,
  "detail": "An alarm in CANCELED cannot be started",
  "instance": "/v1/alarms/0193.../send",
  "currentStatus": "CANCELED",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

- **클라이언트는 `type`으로 분기한다.** `type`의 전체 목록은 OpenAPI 문서의 오류 응답 스키마에 있다.
- **확장 필드는 필요한 곳에만 붙인다.** 입력 검증 실패에는 필드별 오류 목록(`errors`), 409에는 지금 상태(`currentStatus`)를 붙인다. 405에는 `Allow` 헤더를, 401에는 `WWW-Authenticate` 헤더를 함께 보낸다.
- **문의가 오면 응답의 `traceId`로 그 요청의 로그를 바로 찾는다.**
- **500에는 내부 정보(스택 트레이스, SQL)를 담지 않는다.** 상세는 로그에만 남긴다.
- **요청 본문을 읽다 난 오류**(본문이 너무 큼 413 등)는 body-parser가 상태 코드를 담아 던진다. 클라이언트에게 보여도 되는 4xx(`expose`)면 그 상태로 답한다. 그 밖의 알 수 없는 오류만 500이다.
- `title`, `detail` 같은 메시지는 영어로 쓴다(ADR-0028).

## 추적 ID

- 요청에 `traceparent` 헤더가 있으면 그 trace-id를 이어 쓰고, 없으면 16바이트 무작위 값으로 만든다.
- `AsyncLocalStorage`(Node 기본 기능)에 담아, 요청을 처리하는 동안의 모든 로그 줄과 오류 응답에 붙인다.
- 워커의 작업은 요청 바깥에서 일어나므로, alarmId, deliveryId, attempt를 로그에 붙여 추적한다.

## OpenTelemetry를 지금 넣지 않는 이유

운영자가 묻는 질문별로 답하는 수단을 나눠 보면, OTel tracing만 답할 수 있는 질문은 하나다.

| 질문 | 답하는 수단 |
| --- | --- |
| 이 알림은 언제 시작했고, 얼마나 남았고, 언제 끝났나 | 알림 시각(ADR-0029), 상태별 건수(단건 조회) |
| 지금 초당 몇 건을 보내고, 429와 오류는 얼마나 나나 | 메트릭 |
| 이 수신자는 왜 실패했나 | 워커의 구조화 로그(deliveryId로 검색), Delivery의 마지막 오류 |
| 이 API 요청은 왜 느렸나 | 추적 ID 로그. OTel이 가장 잘하는 영역이다 |

- trace를 보려면 수집기와 저장소(Jaeger 등) 컨테이너가 더 필요하다.
- 발송의 대부분은 요청이 끝난 뒤 워커에서 33분 동안 일어난다. 이것을 한 trace로 묶으면 구간이 10만 개라 쓸모가 없다. 비동기 작업은 alarmId와 deliveryId로 추적하는 편이 낫다.
- API 요청은 몇 ms라서, 마지막 질문의 비중이 가장 작다.

추적 ID 형식이 이미 W3C 표준이므로, 추적 저장소가 있는 환경이 되면 OTel SDK를 붙여 기존 로그와 그대로 이을 수 있다.

## 검토한 후보

- **NestJS 기본 오류 형식 `{ statusCode, message, error }`**: 표준이 아니고, 검증 실패 때 `message`가 문자열에서 배열로 바뀌어 모양이 일정하지 않다.
- **자체 봉투 `{ success, error: { code, message } }`**: 표준이 아니고, 성공 응답까지 감싸면 HTTP 상태 코드와 정보가 겹친다.
- **mock과 같은 `{ code, message }`**: 필드별 오류나 추적 ID를 붙이는 규칙이 없다.
- **OpenTelemetry SDK를 바로 도입**: 위의 이유.
