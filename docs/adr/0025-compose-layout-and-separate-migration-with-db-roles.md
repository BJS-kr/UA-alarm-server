# ADR-0025. compose는 이미지 하나와 진입점 셋으로 짜고, 마이그레이션은 DDL 권한 계정으로 별도 서비스가 실행한다

## 배경

`docker compose up` 한 번으로 전체가 떠야 한다. api와 worker는 별도 컨테이너여야 하고, DB 스키마는 둘이 뜨기 전에 준비돼 있어야 한다.

## 결정

```yaml
services:
  postgres:  # healthcheck: pg_isready
  mock:      # 이미지에 들어 있는 /health로 healthcheck
  migrate:   # 앱 이미지. 마이그레이션을 실행하고 끝난다. postgres가 healthy가 된 뒤
  api:       # migrate 성공 + mock healthy 뒤. restart: unless-stopped
  worker:    # migrate 성공 + mock healthy 뒤. replicas: 2, init: true, stop_grace_period: 30s, restart: unless-stopped
```

- **이미지 하나, 진입점 셋**: api, worker, migrate는 같은 이미지에서 실행 명령만 다르다(`node dist/main-api.js`, `node dist/main-worker.js`, `node dist/migrate.js`). 한 번 빌드하면 세 프로세스가 늘 같은 버전의 코드로 돌고, 스키마와 SQL 정의를 한 벌로 공유한다.
- **마이그레이션은 별도 서비스가 실행한다.**
- **DB 계정을 둘로 나눈다.** 마이그레이션 계정은 테이블을 만들고 바꾸는 권한(DDL)을 갖는다. 앱 계정(api, worker)은 데이터를 읽고 쓰는 권한만 갖는다. 두 계정은 postgres 초기화 스크립트에서 만든다.

## 이유

- **권한 분리가 가장 큰 이유다.** 앱에 SQL 인젝션 같은 구멍이나 코드 실수가 있어도, 앱 계정으로는 테이블을 지우거나 바꿀 수 없다(최소 권한). 앱이 기동할 때 마이그레이션을 돌리면 앱 계정에 DDL 권한이 있어야 해서, 이 분리가 불가능하다.
- **실패가 한 곳에서만 보인다.** 기동할 때 돌리는 방식은 마이그레이션이 실패하면 api와 worker가 모두 죽고, 재시작을 되풀이하며 같은 오류를 여러 곳에 쏟는다. 별도 서비스는 migrate 하나만 실패로 끝난다. api와 worker는 `depends_on: condition: service_completed_successfully`에 걸려 시작하지 않는다. 스키마가 맞지 않는 채로 발송이 시작되지 않는다.
- api와 worker는 같은 앱 계정을 쓴다. 둘 다 데이터를 읽고 쓰기만 하므로 권한이 같다. 나눌 이유가 생기면(예: api는 deliveries를 읽기만) 계정을 나눈다.

## 검토한 후보

- **앱이 기동할 때 잠금을 잡고 마이그레이션 실행**: 동시 실행은 마이그레이션 도구의 잠금으로 막을 수 있어서, 그 자체는 문제가 아니다. 그러나 앱 계정에 DDL 권한이 필요해 권한을 나눌 수 없고, 실패하면 모든 앱 프로세스가 재시작을 되풀이한다.
- **사람이 직접 실행**: 명령 하나로 전체가 떠야 한다는 요구를 지키지 못한다.
