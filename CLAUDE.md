# 에이전트 작업 지침

대량 알림 발송 시스템(NestJS) 프로젝트다.

## 참고 문서

1. `.local/assignment.md`: 원본 과제 명세 (비공개 로컬 파일)
2. `docs/requirements.md`: 요구사항 → ADR → 테스트 대응표
3. `docs/adr/*`, `CONTEXT.md`, `docs/schema.md`, `docs/structure.md`

우선순위: `원본 과제 명세 > ADR > CONTEXT.md > 구현 계획`

## 검증 흐름

```
구현 → 1차 완료 → 독립 심사 에이전트 실행 → 지적 사항 반영 → 재심사 → 완료 보고
```

1. 설계(ADR)에 따라 구현한다.
2. 구현 완료 후 별도 컨텍스트로 심사 에이전트를 실행하여 `docs/review-criteria.md` 기준으로 검증한다.
3. 차단(Blocking) 지적이 0건이 될 때까지 수정 및 재심사를 반복한다.
4. 반복 횟수, 잔여 지적 사항, 실행 검증 결과를 보고한다.

## 사용자 확인이 필요한 경우

다음 상황에서는 임의로 변경하지 않고 작업을 중단한 뒤 사용자에게 보고한다.

- ADR이 원본 명세와 상충하는 경우
- ADR 간 모순이 있거나 구현이 불가능한 경우
- 기존 ADR에 정의되지 않은 아키텍처 결정이 필요한 경우
- 승인 목록 외의 외부 의존성 추가가 필요한 경우

## 구현 및 문서 규칙

- 도메인 용어와 상태명은 `CONTEXT.md`를 따른다(예: `Delivery`의 전송 중 상태는 `IN_FLIGHT`이며 `SENDING`은 `Alarm` 상태다).
- 모든 DB 상태 변경은 조건부 UPDATE로 작성하며, 조회한 엔티티 전체를 덮어쓰지 않는다(ADR-0016, 0036).
- SQL 쿼리는 저장소(`*.repository.ts`) 내부에만 작성한다. 서비스와 워커 루프는 실행 흐름만 제어하며, 쿼리는 Drizzle 빌더를 기본으로 사용하고 빌더로 표현할 수 없는 식에만 `sql` 템플릿을 사용한다(ADR-0036).
- `if` 조건문은 비교식을 직접 넣지 않고 의미를 드러내는 `is` 접두사 불리언 변수에 담아 사용한다(예: `const isSending = alarm.status === AlarmStatus.SENDING; if (!isSending) return;`).
- 예상치 못한 예외는 최상위 경계(프로세스 핸들러, 전역 예외 필터, `PollingLoop`)에서 처리하며 개별 모듈에 불필요한 `try/catch`를 중복 작성하지 않는다(ADR-0039).
- 로그 메시지와 에러 응답 메시지는 영어로 작성하고, 코드 주석과 문서는 한국어로 작성한다(ADR-0028).
- 승인된 의존성: NestJS 기본 구성, `@nestjs/config`, `@nestjs/swagger`, `class-validator`, `class-transformer`, `drizzle-orm`, `drizzle-kit`(개발), `pg`, `prom-client`, Jest, Stryker(개발), ESLint(`@eslint/js`, `typescript-eslint`, `@stylistic/eslint-plugin`), Prettier(개발) (ADR-0005).
- 테스트는 ADR-0034의 기준을 따르며 `docs/requirements.md`의 추적성 표와 일치시킨다.
- 원본 명세(`.local/assignment.md`)의 문장을 커밋 대상 파일에 그대로 옮겨 적지 않는다(ADR-0038).
