DROP INDEX "deliveries_owner_idx";--> statement-breakpoint
ALTER TABLE "alarms" ADD COLUMN "expansion_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alarms" ADD COLUMN "cleanup_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "deliveries_lease_idx" ON "deliveries" USING btree ("lease_until") WHERE status = 'IN_FLIGHT';--> statement-breakpoint
-- 이전 방식(세션 판정)으로 쥐고 있던 건과 작업은 기한이 없다. 바로 넘겨받을 수 있게 지금을 기한으로 적는다 (ADR-0004).
UPDATE "deliveries" SET "lease_until" = now() WHERE "status" = 'IN_FLIGHT';--> statement-breakpoint
UPDATE "alarms" SET "expansion_lease_until" = now() WHERE "expansion_owner" IS NOT NULL;--> statement-breakpoint
UPDATE "alarms" SET "cleanup_lease_until" = now() WHERE "cleanup_owner" IS NOT NULL;
