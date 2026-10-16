# ADR-0025. 단일 이미지·다중 진입점 Compose 구성 및 DDL/DML DB 계정 분리

## 배경

`docker compose up` 단일 명령으로 전체 시스템이 기동되어야 한다. `api`와 `worker`는 별도 컨테이너로 분리되어야 하며, 두 애플리케이션 컨테이너가 기동되기 전에 DB 스키마 마이그레이션이 완료되어야 한다.

## 결정

```yaml
services:
  postgres: # healthcheck: pg_isready
  mock: # 이미지 내장 /health 기반 healthcheck
  migrate: # 앱 이미지 사용. postgres healthy 이후 마이그레이션 실행 후 종료
  api: # migrate 정상 종료 + mock healthy 이후 기동. restart: unless-stopped
  worker: # migrate 정상 종료 + mock healthy 이후 기동. replicas: 2, init: true, stop_grace_period: 30s, restart: unless-stopped
```

- **단일 이미지, 3개 진입점**: `api`, `worker`, `migrate`는 동일한 Docker 이미지를 사용하며 실행 명령만 분리한다(`node dist/main-api.js`, `node dist/main-worker.js`, `node dist/migrate.js`). 단일 빌드로 세 프로세스가 항상 동일한 코드 버전과 스키마·SQL 정의를 공유한다.
- **마이그레이션 전용 일회성 서비스(`migrate`) 분리**: 애플리케이션 기동 과정과 분리하여 별도 컨테이너에서 실행한다.
- **DB 계정 권한 분리(DDL / DML)**: 마이그레이션 전용 계정은 스키마 생성·변경 권한(DDL)을 보유하고, 애플리케이션 계정(`api`, `worker`)은 데이터 조회·조작 권한(DML)만 보유한다. 두 계정은 PostgreSQL 초기화 스크립트에서 생성한다.

## 근거

- **최소 권한 원칙 적용**: 애플리케이션에 SQL 인젝션 취약점이나 쿼리 버그가 존재하더라도 DML 전용 계정으로는 테이블 삭제나 스키마 변조가 불가능하다. 애플리케이션 프로세스가 기동 시 직접 마이그레이션을 수행하면 앱 계정에 DDL 권한을 부여해야 하므로 권한 분리가 불가능하다.
- **마이그레이션 실패 격리**: 앱 기동 시 마이그레이션을 실행하면 실패 시 모든 `api`와 `worker` 컨테이너가 반복 재시작되며 동일한 오류 로그를 중복 출력한다. 별도 `migrate` 서비스로 분리하면 `migrate` 컨테이너만 실패 상태로 종료되고, `depends_on: condition: service_completed_successfully`에 의해 `api`와 `worker`는 기동되지 않아 스키마 불일치 상태에서의 발송 시작이 원천 차단된다.
- **앱 계정 공유**: `api`와 `worker`는 모두 데이터 읽기·쓰기(DML) 권한을 필요로 하므로 동일한 앱 계정을 사용한다. 추후 테이블별 접근 권한 세분화(예: `api`의 `deliveries` 쓰기 제한 등)가 필요해지면 계정을 분리한다.

## 검토한 대안

- **애플리케이션 기동 시 Advisory Lock을 획득해 마이그레이션 실행**: 동시 실행 충돌은 마이그레이션 도구의 잠금으로 제어할 수 있으나, 앱 계정에 DDL 권한이 필요해 권한 분리가 불가능하고 실패 시 전 컨테이너가 재시작 루프에 빠진다.
- **수동 마이그레이션 실행**: 단일 명령(`docker compose up`)으로 전체 환경을 기동해야 하는 요구사항을 충족하지 못한다.
