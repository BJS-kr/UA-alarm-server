CREATE SEQUENCE "public"."alarm_start_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "alarm_recipients" (
	"alarm_id" uuid NOT NULL,
	"recipient_id" text NOT NULL,
	CONSTRAINT "alarm_recipients_alarm_id_recipient_id_pk" PRIMARY KEY("alarm_id","recipient_id")
);
--> statement-breakpoint
CREATE TABLE "alarms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"start_seq" bigint,
	"expansion_cursor" text,
	"expansion_done" boolean DEFAULT false NOT NULL,
	"expansion_owner" bigint,
	"cleanup_done" boolean DEFAULT false NOT NULL,
	"cleanup_owner" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "alarms_type_check" CHECK ("alarms"."type" IN ('BULK', 'URGENT')),
	CONSTRAINT "alarms_status_check" CHECK ("alarms"."status" IN ('CREATED', 'SENDING', 'CANCELING', 'CANCELED', 'COMPLETED')),
	CONSTRAINT "alarms_title_length_check" CHECK (char_length("alarms"."title") BETWEEN 1 AND 100),
	CONSTRAINT "alarms_body_length_check" CHECK (char_length("alarms"."body") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"alarm_id" uuid NOT NULL,
	"recipient_id" text NOT NULL,
	"priority" smallint NOT NULL,
	"start_seq" bigint NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconcile_after" timestamp with time zone,
	"owner" bigint,
	"claimed_at" timestamp with time zone,
	"message_id" text,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"duplicate_detected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_status_check" CHECK ("deliveries"."status" IN ('PENDING', 'IN_FLIGHT', 'UNCONFIRMED', 'SENT', 'FAILED', 'CANCELED')),
	CONSTRAINT "deliveries_priority_check" CHECK ("deliveries"."priority" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE "rate_limiter" (
	"id" smallint PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"refilled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_until" timestamp with time zone DEFAULT '-infinity' NOT NULL,
	"breaker_streak" smallint DEFAULT 0 NOT NULL,
	"breaker_last_until" timestamp with time zone DEFAULT '-infinity' NOT NULL,
	CONSTRAINT "rate_limiter_single_row_check" CHECK ("rate_limiter"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "alarm_recipients" ADD CONSTRAINT "alarm_recipients_alarm_id_alarms_id_fk" FOREIGN KEY ("alarm_id") REFERENCES "public"."alarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_alarm_id_alarms_id_fk" FOREIGN KEY ("alarm_id") REFERENCES "public"."alarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alarms_status_id_idx" ON "alarms" USING btree ("status","id");--> statement-breakpoint
CREATE UNIQUE INDEX "alarms_start_seq_uniq" ON "alarms" USING btree ("start_seq") WHERE start_seq IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_alarm_recipient_uniq" ON "deliveries" USING btree ("alarm_id","recipient_id");--> statement-breakpoint
CREATE INDEX "deliveries_claim_idx" ON "deliveries" USING btree ("priority","start_seq","id") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX "deliveries_reconcile_idx" ON "deliveries" USING btree ("reconcile_after") WHERE status = 'UNCONFIRMED';--> statement-breakpoint
CREATE INDEX "deliveries_owner_idx" ON "deliveries" USING btree ("owner") WHERE status IN ('IN_FLIGHT', 'UNCONFIRMED');--> statement-breakpoint
CREATE INDEX "deliveries_unfinished_idx" ON "deliveries" USING btree ("alarm_id") WHERE status IN ('PENDING', 'IN_FLIGHT', 'UNCONFIRMED');--> statement-breakpoint
CREATE INDEX "deliveries_alarm_status_recipient_idx" ON "deliveries" USING btree ("alarm_id","status","recipient_id");