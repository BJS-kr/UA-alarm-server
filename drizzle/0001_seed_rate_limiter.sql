-- 모든 워커가 함께 쓰는 토큰 버킷의 유일한 행 (ADR-0009)
INSERT INTO "rate_limiter" ("id", "tokens") VALUES (1, 0) ON CONFLICT DO NOTHING;
