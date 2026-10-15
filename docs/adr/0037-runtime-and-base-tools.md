# 런타임과 기본 도구

| 항목 | 선택 | 이유 |
| --- | --- | --- |
| Node | 24 LTS | LTS이며 개발 환경과 같다. Node 26은 이달 말 LTS가 된다. |
| NestJS | 12 | 최신 메이저(2026-08). TypeScript는 Nest CLI가 쓰는 6.0을 따른다. TS 7은 Nest가 아직 맞추지 않았다. |
| PostgreSQL | 18 | `uuidv7()` 내장으로 확장이 필요 없다. |
| 알림 ID | UUIDv7 (DB 기본값) | 명세의 uuid 요구를 지키면서 ID 순서가 생성 순서라, 목록 커서(ADR-0024)를 ID 하나로 하고 인덱스에도 순서대로 쌓인다. |
| Delivery ID | bigint 자동 증가 | 내부용이며 꺼내는 순서와 커서의 기준이다. 외부에는 알림 ID와 수신자 ID로 식별한다. |
| HTTP 클라이언트 | `node:http` + `http.Agent` | keepAlive와 소켓 수(ADR-0013)를 표준 라이브러리로 설정한다. 내장 `fetch`는 연결 수 설정에 `undici` 패키지가 필요하다. |
| 입력 검증 | class-validator + class-transformer | NestJS 표준 조합이며, `forbidNonWhitelisted`로 모르는 필드를 거절한다(ADR-0021). |
| OpenAPI | @nestjs/swagger | 컨트롤러·DTO에서 생성해 `/docs`로 제공하고, `openapi.json`을 저장소에도 커밋한다. 생성 문서의 `openapi` 필드가 명세가 요구한 3.0.x인지 구현 시 확인하고, 다르면 설정으로 맞춘다. |
| 패키지 매니저 | npm | Node에 기본 포함되어 도구가 늘지 않는다. |

## "보냈는지 모르는" 오류의 기준

- 연결 단계 실패(연결 거부, 호스트 없음): 요청이 나가지 않았으므로 재시도한다(ADR-0014).
- 요청을 쓴 뒤의 실패(타임아웃, 응답 도중 끊김): UNCONFIRMED로 둔다(ADR-0032).
- keepAlive 연결이 서버 쪽에서 이미 닫혀 쓰는 중에 끊기는 경우도, 실제로는 안 나갔을 가능성이 높지만 확실하지 않으므로 UNCONFIRMED로 둔다. 손해는 조회 한 번이다.
