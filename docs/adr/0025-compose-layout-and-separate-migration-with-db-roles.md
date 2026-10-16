# compose는 이미지 하나·진입점 셋으로 구성하고, 마이그레이션은 DDL 권한 계정으로 별도 서비스가 실행한다

```yaml
services:
  postgres:  # healthcheck: pg_isready
  mock:      # 이미지 내장 /health로 healthcheck
  migrate:   # 앱 이미지, 마이그레이션 실행 후 종료. postgres healthy 이후
  api:       # migrate 성공 + mock healthy 이후. restart: unless-stopped
  worker:    # migrate 성공 + mock healthy 이후. replicas: 2, init: true, stop_grace_period: 30s, restart: unless-stopped
```

## 이미지 하나, 진입점 셋

api, worker, migrate는 같은 이미지에서 실행 명령만 다르다(`node dist/main-api.js`, `node dist/main-worker.js`, `node dist/migrate.js`). 한 번 빌드하면 세 프로세스가 항상 같은 버전의 코드로 돌고, 스키마와 SQL 정의를 한 벌로 공유한다.

## 마이그레이션은 별도 서비스로 실행한다

결정적인 이유는 **DB 권한 분리**다.

- DB 계정을 둘로 나눈다. 마이그레이션 계정은 테이블을 만들고 바꾸는 권한(DDL)을 갖고, 앱 계정(api, worker)은 데이터 읽기·쓰기 권한만 갖는다. postgres 초기화 SQL에서 만든다.
- 앱에 SQL 인젝션 같은 구멍이나 코드 실수가 있어도 앱 계정으로는 테이블을 지우거나 바꿀 수 없다(최소 권한 원칙).
- 부트스트랩에서 마이그레이션을 돌리면 앱 계정에 DDL 권한이 있어야 해서 이 분리가 불가능하다.

실패 신호도 깔끔해진다. 부트스트랩 방식은 마이그레이션이 실패하면 api·worker가 모두 죽고 재시작을 반복하며 같은 에러를 여러 곳에 쏟는다. 별도 서비스는 migrate 하나만 실패로 끝나고, api·worker는 `depends_on: condition: service_completed_successfully`에 걸려 시작하지 않는다. 스키마가 맞지 않는 상태로 발송이 시작되지 않는다.

api와 worker는 모두 같은 앱 계정을 쓴다. 둘 다 데이터 읽기·쓰기만 하므로 권한이 같다. 나눠야 할 이유가 생기면(예: api는 deliveries를 읽기만) 계정을 나눈다.

## 검토한 후보

- **부트스트랩에서 잠금을 잡고 마이그레이션 실행**: 동시 실행은 마이그레이션 도구의 잠금으로 막을 수 있어 그 자체는 문제가 아니다. 그러나 앱 계정에 DDL 권한이 필요해 권한 분리가 불가능하고, 실패 시 모든 앱 프로세스가 재시작을 반복한다.
- **사람이 수동 실행**: 명령 하나로 전체가 떠야 한다는 요구를 지키지 못한다.
