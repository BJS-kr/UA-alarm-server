import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgSequence,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AlarmStatus, AlarmType, DeliveryStatus } from '../domain/status';

/** 컬럼과 인덱스의 근거는 docs/schema.md에 있다. */

const tz = { withTimezone: true } as const;

/** 발송 시작 순번 (ADR-0012) */
export const alarmStartSeq = pgSequence('alarm_start_seq');

export const alarms = pgTable(
  'alarms',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    type: text('type').$type<AlarmType>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: text('status').$type<AlarmStatus>().notNull().default('CREATED'),
    startSeq: bigint('start_seq', { mode: 'number' }),
    expansionCursor: text('expansion_cursor'),
    expansionDone: boolean('expansion_done').notNull().default(false),
    expansionOwner: bigint('expansion_owner', { mode: 'number' }),
    cleanupDone: boolean('cleanup_done').notNull().default(false),
    cleanupOwner: bigint('cleanup_owner', { mode: 'number' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    startedAt: timestamp('started_at', tz),
    finishedAt: timestamp('finished_at', tz),
  },
  (t) => [
    check('alarms_type_check', sql`${t.type} IN ('BULK', 'URGENT')`),
    check(
      'alarms_status_check',
      sql`${t.status} IN ('CREATED', 'SENDING', 'CANCELING', 'CANCELED', 'COMPLETED')`,
    ),
    check(
      'alarms_title_length_check',
      sql`char_length(${t.title}) BETWEEN 1 AND 100`,
    ),
    check(
      'alarms_body_length_check',
      sql`char_length(${t.body}) BETWEEN 1 AND 1000`,
    ),
    index('alarms_status_id_idx').on(t.status, t.id),
    uniqueIndex('alarms_start_seq_uniq')
      .on(t.startSeq)
      .where(sql`start_seq IS NOT NULL`),
  ],
);

/** 긴급 알림의 수신자 정의. 실제 발송 기록(deliveries)과 구별한다. */
export const alarmRecipients = pgTable(
  'alarm_recipients',
  {
    alarmId: uuid('alarm_id')
      .notNull()
      .references(() => alarms.id),
    recipientId: text('recipient_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.alarmId, t.recipientId] })],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    alarmId: uuid('alarm_id')
      .notNull()
      .references(() => alarms.id),
    recipientId: text('recipient_id').notNull(),
    priority: smallint('priority').notNull(),
    startSeq: bigint('start_seq', { mode: 'number' }).notNull(),
    status: text('status').$type<DeliveryStatus>().notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lookupFailures: integer('lookup_failures').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', tz).notNull().defaultNow(),
    reconcileAfter: timestamp('reconcile_after', tz),
    owner: bigint('owner', { mode: 'number' }),
    claimedAt: timestamp('claimed_at', tz),
    messageId: text('message_id'),
    sentAt: timestamp('sent_at', tz),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    duplicateDetected: boolean('duplicate_detected').notNull().default(false),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check(
      'deliveries_status_check',
      sql`${t.status} IN ('PENDING', 'IN_FLIGHT', 'UNCONFIRMED', 'SENT', 'FAILED', 'CANCELED')`,
    ),
    check('deliveries_priority_check', sql`${t.priority} IN (0, 1)`),
    uniqueIndex('deliveries_alarm_recipient_uniq').on(t.alarmId, t.recipientId),
    index('deliveries_claim_idx')
      .on(t.priority, t.startSeq, t.id)
      .where(sql`status = 'PENDING'`),
    index('deliveries_reconcile_idx')
      .on(t.reconcileAfter)
      .where(sql`status = 'UNCONFIRMED'`),
    index('deliveries_owner_idx')
      .on(t.owner)
      .where(sql`status IN ('IN_FLIGHT', 'UNCONFIRMED')`),
    index('deliveries_unfinished_idx')
      .on(t.alarmId)
      .where(sql`status IN ('PENDING', 'IN_FLIGHT', 'UNCONFIRMED')`),
    index('deliveries_alarm_status_recipient_idx').on(
      t.alarmId,
      t.status,
      t.recipientId,
    ),
  ],
);

/** 모든 워커가 함께 쓰는 토큰 버킷. 행은 하나뿐이다 (ADR-0009). */
export const rateLimiter = pgTable(
  'rate_limiter',
  {
    id: smallint('id').primaryKey(),
    tokens: doublePrecision('tokens').notNull(),
    refilledAt: timestamp('refilled_at', tz).notNull().defaultNow(),
    pausedUntil: timestamp('paused_until', tz)
      .notNull()
      .default(sql`'-infinity'`),
    breakerStreak: smallint('breaker_streak').notNull().default(0),
    breakerLastUntil: timestamp('breaker_last_until', tz)
      .notNull()
      .default(sql`'-infinity'`),
  },
  (t) => [check('rate_limiter_single_row_check', sql`${t.id} = 1`)],
);
