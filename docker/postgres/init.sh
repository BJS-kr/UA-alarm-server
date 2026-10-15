#!/bin/bash
# DB 계정 분리 (ADR-0025)
#  - alarm_migrator: DB 소유자. 스키마를 만들고 바꾼다(DDL). migrate 서비스만 쓴다.
#  - alarm_app: 데이터 읽기·쓰기만 한다. api와 worker가 쓴다.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  CREATE ROLE alarm_migrator LOGIN PASSWORD '${ALARM_MIGRATOR_PASSWORD}';
  CREATE ROLE alarm_app LOGIN PASSWORD '${ALARM_APP_PASSWORD}';
  CREATE DATABASE alarm OWNER alarm_migrator;
  REVOKE ALL ON DATABASE alarm FROM PUBLIC;
  GRANT CONNECT ON DATABASE alarm TO alarm_app;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname alarm <<-EOSQL
  -- 마이그레이션 계정이 앞으로 만드는 테이블과 시퀀스에 앱 계정 권한을 자동으로 준다.
  ALTER DEFAULT PRIVILEGES FOR ROLE alarm_migrator IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO alarm_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE alarm_migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO alarm_app;
EOSQL
