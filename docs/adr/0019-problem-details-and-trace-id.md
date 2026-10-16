# ADR-0019. RFC 9457 Problem Details 오류 응답 및 W3C Trace Context 기반 추적 ID

## 배경

클라이언트가 단일 규격으로 오류를 처리할 수 있도록 모든 오류 응답의 스키마를 통일해야 하며, 오류 발생 시 해당 요청의 서버 로그를 즉시 조회할 수 있는 추적 식별자가 필요하다.

## 결정

- 모든 오류는 RFC 9457 Problem Details 형식(`Content-Type: application/problem+json`)으로 응답한다.
- 모든 오류 응답과 서버 로그에 동일한 `traceId`를 포함하며, 형식은 W3C Trace Context의 `trace-id` 규격을 따른다.
- OpenTelemetry SDK는 도입하지 않는다.

## 상세

### 오류 응답 형식

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

- **클라이언트 분기 기준**: 클라이언트는 `type` 필드를 기준으로 오류를 분기 처리한다. 전체 `type` 목록은 OpenAPI 문서의 오류 응답 스키마에 정의한다.
- **확장 필드 및 헤더**: 입력 검증 실패(`400`)에는 필드별 오류 목록(`errors`), 상태 충돌(`409`)에는 현재 상태(`currentStatus`) 확장 필드를 추가한다. `405` 응답에는 `Allow` 헤더를, `401` 응답에는 `WWW-Authenticate` 헤더를 포함한다.
- **로그 추적**: 오류 응답의 `traceId`로 해당 요청의 서버 로그를 검색한다.
- **내부 정보 비노출**: `500` 오류 응답에는 스택 트레이스나 SQL 등 내부 구현 정보를 노출하지 않으며 상세 내용은 서버 로그에만 기록한다.
- **요청 본문 파싱 오류 처리**: 본문 크기 초과(`413`) 등 body-parser가 발생시키는 오류 중 클라이언트에 노출 가능한 4xx 오류(`expose: true`)는 해당 상태 코드로 응답하고, 그 외 예기치 않은 오류만 `500`으로 처리한다.
- `title`, `detail` 등 오류 메시지는 영문으로 작성한다(ADR-0028).

### 추적 ID(`traceId`) 생성 및 전파

- 수신 요청에 `traceparent` 헤더가 존재하면 해당 `trace-id`를 추출해 재사용하고, 없으면 16바이트 난수로 생성한다.
- Node.js 내장 `AsyncLocalStorage`에 저장하여 요청 처리 중 출력되는 모든 로그 라인과 오류 응답에 자동 첨부한다.
- 워커 작업은 HTTP 요청 컨텍스트 외부에서 실행되므로 `alarmId`, `deliveryId`, `attempt` 필드를 로그에 기록해 추적한다.

## 근거: OpenTelemetry 미도입 이유

운영 시 필요한 주요 관측 항목별 확인 수단을 분류하면 다음과 같다.

| 운영 확인 항목                            | 확인 수단                                                        |
| ----------------------------------------- | ---------------------------------------------------------------- |
| 알림 발송 시작·종료 시각 및 진행 현황     | 알림 타임스탬프(ADR-0029), 단건 조회의 상태별 건수               |
| 초당 발송 처리량, `429` 및 오류 발생 추이 | Prometheus 메트릭                                                |
| 특정 수신자의 발송 실패 원인              | 워커 구조화 로그(`deliveryId` 조회), Delivery의 마지막 오류 기록 |
| 특정 API 요청의 지연 구간 분석            | `traceId` 기반 로그 (분산 트레이싱 영역)                         |

- 분산 트레이스를 조회하려면 수집기 및 백엔드 저장소(Jaeger 등) 컨테이너를 추가로 운영해야 한다.
- 실제 발송 작업은 API 응답 이후 워커에서 최대 약 33분에 걸쳐 비동기로 수행된다. 이를 단일 트레이스로 묶으면 스팬(span)이 10만 개 생성되어 실효성이 없으며, 비동기 워커 작업은 `alarmId`와 `deliveryId` 기반 구조화 로그로 추적하는 편이 적합하다.
- API 요청 처리는 수 ms 내에 완료되므로 구간별 지연 분석의 필요성이 낮다.

`traceId`를 W3C Trace Context 표준 형식으로 생성하므로, 추후 트레이싱 인프라가 도입될 때 기존 로그 스키마 변경 없이 OpenTelemetry SDK를 연동할 수 있다.

## 검토한 대안

- **NestJS 기본 오류 형식(`{ statusCode, message, error }`)**: 비표준 형식이며 검증 실패 시 `message` 필드가 문자열에서 배열로 바뀌어 타입이 일관되지 않는다.
- **자체 래퍼 형식(`{ success, error: { code, message } }`)**: 비표준이며 정상 응답까지 래핑할 경우 HTTP 상태 코드와 의미가 중복된다.
- **mock 서버와 동일한 `{ code, message }` 형식**: 다중 필드 검증 오류나 `traceId` 확장을 위한 표준 규격이 없다.
- **OpenTelemetry SDK 즉시 도입**: 위 근거에 따라 제외한다.
