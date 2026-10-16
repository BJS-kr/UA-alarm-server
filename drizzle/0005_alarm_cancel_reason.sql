ALTER TABLE "alarms" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "alarms" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "alarms" ADD COLUMN "last_error_message" text;--> statement-breakpoint
ALTER TABLE "alarms" ADD CONSTRAINT "alarms_cancel_reason_check" CHECK ("alarms"."cancel_reason" IN ('REQUESTED', 'EXPANSION_FAILED'));--> statement-breakpoint
-- 이 칸이 생기기 전의 취소는 모두 취소 요청이었다.
UPDATE "alarms" SET "cancel_reason" = 'REQUESTED' WHERE "status" IN ('CANCELING', 'CANCELED');
