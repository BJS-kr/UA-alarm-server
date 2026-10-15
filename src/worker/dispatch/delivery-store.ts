import { sql, SQL } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { Tx } from '../../shared/db/executor';
import { ReconcileDecision, SendDecision } from '../../shared/domain/send-outcome';
import { AlarmStatus } from '../../shared/domain/status';
import { withAlarmLock } from '../completion/alarm-transaction';
import { ownerIsGone } from '../lifecycle/alive-workers';

export interface ClaimedDelivery {
  id: number;
  alarmId: string;
  recipientId: string;
  attempts: number;
  priority: number;
  body: string;
  alarmStartedAt: Date | null;
}

export interface ReconcileItem {
  id: number;
  alarmId: string;
  recipientId: string;
  attempts: number;
}

export type WriteOutcome = { applied: true; finished: AlarmStatus | null } | { applied: false };

/**
 * Delivery 상태 전이 SQL을 모은다 (ADR-0032). 모든 전이는 조건부 UPDATE이며,
 * IN_FLIGHT에서 나가는 쓰기에는 owner와 시도 번호 조건(펜싱)을 건다 (ADR-0004).
 */
export class DeliveryStore {
  /**
   * claimDb는 작업 루프 전용 연결이다. 결과 기록은 알림 행 잠금을 차례로 기다리므로, 같은 풀을 쓰면
   * 그 트랜잭션들이 연결을 붙잡는 동안 루프가 꺼내지 못하고 토큰이 넘쳐 버려진다.
   */
  constructor(
    private readonly db: Db,
    private readonly workerId: number,
    private readonly claimDb: Db = db,
  ) {}

  /**
   * 꺼내기 (ADR-0011, 0012, 0017). 토큰을 받은 개수만큼만 꺼낸다.
   * 긴급 먼저, 먼저 시작한 알림 먼저, 같은 알림 안에서는 원래 순서. 재시도 건은 원래 자리로 돌아온다.
   * SENDING 알림의 건만 집으므로 취소 1단계가 커밋된 순간부터 그 알림의 건은 꺼내지지 않는다.
   */
  async claim(limit: number): Promise<ClaimedDelivery[]> {
    const result = await this.claimDb.execute<{
      id: number;
      alarm_id: string;
      recipient_id: string;
      attempts: number;
      priority: number;
      body: string;
      started_at: Date | null;
    }>(sql`
      WITH picked AS (
        SELECT d.id
          FROM deliveries d
          JOIN alarms a ON a.id = d.alarm_id
         WHERE d.status = 'PENDING'
           AND d.next_attempt_at <= clock_timestamp()
           AND a.status = 'SENDING'
         ORDER BY d.priority, d.start_seq, d.id
         LIMIT ${limit}
           FOR UPDATE OF d SKIP LOCKED
      )
      UPDATE deliveries d
         SET status = 'IN_FLIGHT', owner = ${this.workerId}, attempts = d.attempts + 1,
             claimed_at = clock_timestamp(), updated_at = clock_timestamp()
        FROM picked, alarms a
       WHERE d.id = picked.id AND a.id = d.alarm_id
      RETURNING d.id, d.alarm_id, d.recipient_id, d.attempts, d.priority, a.body, a.started_at`);
    return result.rows
      .map((row) => ({
        id: row.id,
        alarmId: row.alarm_id,
        recipientId: row.recipient_id,
        attempts: row.attempts,
        priority: row.priority,
        body: row.body,
        alarmStartedAt: row.started_at,
      }))
      .sort((a, b) => a.priority - b.priority || a.id - b.id);
  }

  /** 발송 결과 기록. 넘겨받힌 뒤 늦게 도착한 기록은 펜싱 조건에 걸려 반영되지 않는다. */
  async recordSend(delivery: ClaimedDelivery, decision: SendDecision, reconcileDelayMs: number): Promise<WriteOutcome> {
    const fence = sql`id = ${delivery.id} AND status = 'IN_FLIGHT' AND owner = ${this.workerId} AND attempts = ${delivery.attempts}`;
    return this.writeLocked(delivery.alarmId, async (tx, alarmStatus) => {
      switch (decision.kind) {
        case 'sent':
          return update(tx, fence, sql`status = 'SENT', message_id = ${decision.messageId}, sent_at = clock_timestamp(),
                                       last_error_code = NULL, last_error_message = NULL`);
        case 'failed':
          return update(tx, fence, sql`status = 'FAILED', last_error_code = ${decision.code}, last_error_message = ${decision.message}`);
        case 'retry':
          return update(tx, fence, backToPending(alarmStatus, sql`clock_timestamp() + make_interval(secs => ${decision.delayMs / 1000})`, decision));
        case 'requeue_uncounted':
          // 429는 시도 횟수에 세지 않는다 (ADR-0014).
          return update(tx, fence, sql`${backToPending(alarmStatus, sql`clock_timestamp()`, decision)}, attempts = attempts - 1`);
        case 'unconfirmed':
          return update(tx, fence, sql`status = 'UNCONFIRMED', last_error_code = ${decision.code}, last_error_message = ${decision.message},
                                       reconcile_after = clock_timestamp() + make_interval(secs => ${reconcileDelayMs / 1000})`);
      }
    });
  }

  /** 확실히 보내지 않은 건을 반납한다. 발송 직전 확인 실패, 정상 종료 (ADR-0004, 0007). */
  async releaseUnsent(delivery: ClaimedDelivery): Promise<WriteOutcome> {
    const fence = sql`id = ${delivery.id} AND status = 'IN_FLIGHT' AND owner = ${this.workerId} AND attempts = ${delivery.attempts}`;
    return this.writeLocked(delivery.alarmId, (tx, alarmStatus) =>
      update(tx, fence, sql`${backToPending(alarmStatus, sql`clock_timestamp()`)}, attempts = attempts - 1`),
    );
  }

  /**
   * 넘겨받기 (ADR-0004). owner가 살아 있는 워커 명단(pg_locks)에 없는 IN_FLIGHT 건을 결과 미확정으로 돌린다.
   * 넘겨받은 시각 + 조회 대기 뒤에 결과 확인을 한다 (ADR-0002).
   */
  async takeOverOrphans(reconcileDelayMs: number): Promise<number> {
    const result = await this.db.execute(sql`
      WITH orphans AS (
        SELECT d.id FROM deliveries d
         WHERE d.status = 'IN_FLIGHT' AND d.owner IS NOT NULL AND ${ownerIsGone(sql`d.owner`)}
         LIMIT 500
           FOR UPDATE SKIP LOCKED
      )
      UPDATE deliveries d
         SET status = 'UNCONFIRMED', owner = NULL, updated_at = clock_timestamp(),
             last_error_code = 'OWNER_GONE', last_error_message = '전송 중이던 워커가 사라져 넘겨받았다',
             reconcile_after = clock_timestamp() + make_interval(secs => ${reconcileDelayMs / 1000})
        FROM orphans
       WHERE d.id = orphans.id`);
    return result.rowCount ?? 0;
  }

  /**
   * 결과 확인 대상 꺼내기. 조회는 읽기만 하므로 겹쳐도 해롭지 않다 (ADR-0032).
   * 조회 중 죽어도 leaseMs 뒤 다른 워커가 다시 집는다.
   */
  async claimReconcile(limit: number, leaseMs: number): Promise<ReconcileItem[]> {
    const result = await this.db.execute<{ id: number; alarm_id: string; recipient_id: string; attempts: number }>(sql`
      WITH due AS (
        SELECT id FROM deliveries
         WHERE status = 'UNCONFIRMED' AND reconcile_after <= clock_timestamp()
         ORDER BY reconcile_after
         LIMIT ${limit}
           FOR UPDATE SKIP LOCKED
      )
      UPDATE deliveries d
         SET owner = ${this.workerId}, updated_at = clock_timestamp(),
             reconcile_after = clock_timestamp() + make_interval(secs => ${leaseMs / 1000})
        FROM due
       WHERE d.id = due.id
      RETURNING d.id, d.alarm_id, d.recipient_id, d.attempts`);
    return result.rows.map((row) => ({ id: row.id, alarmId: row.alarm_id, recipientId: row.recipient_id, attempts: row.attempts }));
  }

  /**
   * 결과 확인 결과 기록 (ADR-0002, 0017). decide는 잠금 아래에서 읽은 알림 상태로 결정을 내린다.
   * 기록이 없고 알림이 취소 중이면 다시 보내지 않고 CANCELED로 둔다.
   */
  async recordReconcile(
    item: ReconcileItem,
    decide: (alarmCanceling: boolean) => ReconcileDecision,
  ): Promise<{ decision: ReconcileDecision; outcome: WriteOutcome }> {
    let decision: ReconcileDecision = { kind: 'resend' };
    const fence = sql`id = ${item.id} AND status = 'UNCONFIRMED' AND owner = ${this.workerId}`;
    const outcome = await this.writeLocked(item.alarmId, async (tx, alarmStatus) => {
      decision = decide(alarmStatus !== AlarmStatus.SENDING);
      switch (decision.kind) {
        case 'sent':
          return update(tx, fence, sql`status = 'SENT', message_id = ${decision.messageId}, sent_at = ${decision.sentAt}::timestamptz,
                                       duplicate_detected = duplicate_detected OR ${decision.duplicate},
                                       last_error_code = NULL, last_error_message = NULL`);
        case 'canceled':
          return update(tx, fence, sql`status = 'CANCELED'`);
        case 'failed':
          return update(tx, fence, sql`status = 'FAILED', last_error_code = ${decision.code}, last_error_message = ${decision.message}`);
        case 'resend':
          return update(tx, fence, backToPending(alarmStatus, sql`clock_timestamp()`));
        case 'retry_lookup':
          return update(tx, fence, sql`reconcile_after = clock_timestamp() + make_interval(secs => ${decision.delayMs / 1000})`);
      }
    });
    return { decision, outcome };
  }

  /** 펜싱에 걸린 뒤 실제 중복이 확인되면 표시한다 (ADR-0004). 상태와 관계없이 남긴다. */
  async markDuplicate(deliveryId: number): Promise<void> {
    await this.db.execute(sql`UPDATE deliveries SET duplicate_detected = true, updated_at = clock_timestamp() WHERE id = ${deliveryId}`);
  }

  private async writeLocked(
    alarmId: string,
    fn: (tx: Tx, alarmStatus: AlarmStatus) => Promise<boolean>,
  ): Promise<WriteOutcome> {
    const { result, finished } = await withAlarmLock(this.db, alarmId, (tx, alarm) => fn(tx, alarm.status));
    return result ? { applied: true, finished } : { applied: false };
  }
}

/**
 * PENDING으로 되돌리는 SET 절. 알림이 SENDING이 아니면 PENDING 대신 CANCELED로 둔다 (ADR-0017).
 * 정리가 끝난 뒤 PENDING이 다시 생기면 영원히 꺼내지지 않기 때문이다. alarmStatus는 잠금 아래에서 읽은 값이다.
 */
function backToPending(alarmStatus: AlarmStatus, nextAttemptAt: SQL, error?: { code: string; message: string }): SQL {
  const errorSet = error ? sql`, last_error_code = ${error.code}, last_error_message = ${error.message}` : sql``;
  if (alarmStatus !== AlarmStatus.SENDING) return sql`status = 'CANCELED'${errorSet}`;
  return sql`status = 'PENDING', next_attempt_at = ${nextAttemptAt}${errorSet}`;
}

async function update(tx: Tx, fence: SQL, set: SQL): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE deliveries SET ${set}, owner = NULL, updated_at = clock_timestamp() WHERE ${fence}`);
  return (result.rowCount ?? 0) > 0;
}
