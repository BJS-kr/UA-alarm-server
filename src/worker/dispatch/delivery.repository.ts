import { and, asc, eq, lt, lte, sql, SQL } from 'drizzle-orm';
import { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { Db } from '../../shared/db/database';
import { dbNow, dbNowPlus } from '../../shared/db/db-clock';
import { Tx } from '../../shared/db/executor';
import { alarms, deliveries } from '../../shared/db/schema';
import {
  ReconcileDecision,
  SendDecision,
} from '../../shared/domain/send-outcome';
import { AlarmStatus, DeliveryStatus } from '../../shared/domain/status';
import { withAlarmLock } from '../completion/alarm-lock.repository';

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
  lookupFailures: number;
}

export type WriteOutcome =
  { applied: true; finished: AlarmStatus | null } | { applied: false };

type DeliveryChange = PgUpdateSetSource<typeof deliveries>;

/** 넘겨받기 한 번에 회수하는 최대 건수. */
const TAKEOVER_BATCH = 500;

/**
 * Delivery 상태 전이를 모은 저장소 (ADR-0032). 모든 전이는 조건부 UPDATE이며,
 * IN_FLIGHT에서 나가는 쓰기에는 owner와 시도 번호 조건(펜싱)을 건다 (ADR-0004).
 */
export class DeliveryRepository {
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
   * SENDING 알림의 건만 집으므로, 취소 1단계가 커밋된 뒤에 시작한 claim 쿼리는 그 알림의 건을 집지 않는다 (ADR-0017).
   * 꺼낸 건에는 기한(지금 + leaseMs)을 적는다. 기한이 지나도록 결과가 기록되지 않으면 다른 워커가 넘겨받는다 (ADR-0004).
   */
  async claim(limit: number, leaseMs: number): Promise<ClaimedDelivery[]> {
    const picked = this.claimDb.$with('picked').as(
      this.claimDb
        .select({ id: deliveries.id, alarmId: deliveries.alarmId })
        .from(deliveries)
        .innerJoin(alarms, eq(alarms.id, deliveries.alarmId))
        .where(
          and(
            eq(deliveries.status, DeliveryStatus.PENDING),
            lte(deliveries.nextAttemptAt, dbNow),
            eq(alarms.status, AlarmStatus.SENDING),
          ),
        )
        .orderBy(
          asc(deliveries.priority),
          asc(deliveries.startSeq),
          asc(deliveries.id),
        )
        .limit(limit)
        .for('update', { of: deliveries, skipLocked: true }),
    );
    const claimed = await this.claimDb
      .with(picked)
      .update(deliveries)
      .set({
        status: DeliveryStatus.IN_FLIGHT,
        owner: this.workerId,
        attempts: sql`${deliveries.attempts} + 1`,
        claimedAt: dbNow,
        leaseUntil: dbNowPlus(leaseMs),
        updatedAt: dbNow,
      })
      .from(picked)
      .innerJoin(alarms, eq(alarms.id, picked.alarmId))
      .where(eq(deliveries.id, picked.id))
      .returning({
        id: deliveries.id,
        alarmId: deliveries.alarmId,
        recipientId: deliveries.recipientId,
        attempts: deliveries.attempts,
        priority: deliveries.priority,
        body: alarms.body,
        alarmStartedAt: alarms.startedAt,
      });

    // UPDATE ... RETURNING은 꺼낸 순서를 지키지 않는다. 보내는 순서를 꺼낸 순서와 맞춘다.
    return claimed.sort((a, b) => a.priority - b.priority || a.id - b.id);
  }

  /** 발송 결과 기록. 넘겨받힌 뒤 늦게 도착한 기록은 펜싱 조건에 걸려 반영되지 않는다. */
  recordSend(
    delivery: ClaimedDelivery,
    decision: SendDecision,
    reconcileDelayMs: number,
  ): Promise<WriteOutcome> {
    return this.writeLocked(
      delivery.alarmId,
      this.inFlightFence(delivery),
      (alarmStatus) => {
        switch (decision.kind) {
          case 'sent':
            return {
              status: DeliveryStatus.SENT,
              messageId: decision.messageId,
              sentAt: dbNow,
              lastErrorCode: null,
              lastErrorMessage: null,
            };
          case 'failed':
            return {
              status: DeliveryStatus.FAILED,
              lastErrorCode: decision.code,
              lastErrorMessage: decision.message,
            };
          case 'retry':
            return backToPending(
              alarmStatus,
              dbNowPlus(decision.delayMs),
              decision,
            );
          case 'requeue_uncounted':
            // 429는 시도 횟수에 세지 않는다 (ADR-0014).
            return {
              ...backToPending(alarmStatus, dbNow, decision),
              attempts: sql`${deliveries.attempts} - 1`,
            };
          case 'unconfirmed':
            return {
              status: DeliveryStatus.UNCONFIRMED,
              lastErrorCode: decision.code,
              lastErrorMessage: decision.message,
              reconcileAfter: dbNowPlus(reconcileDelayMs),
              lookupFailures: 0,
            };
        }
      },
    );
  }

  /** 확실히 보내지 않은 건을 반납한다. 발송 직전 확인 실패, 정상 종료 (ADR-0004, 0007). */
  releaseUnsent(delivery: ClaimedDelivery): Promise<WriteOutcome> {
    return this.writeLocked(
      delivery.alarmId,
      this.inFlightFence(delivery),
      (alarmStatus) => ({
        ...backToPending(alarmStatus, dbNow),
        attempts: sql`${deliveries.attempts} - 1`,
      }),
    );
  }

  /**
   * 넘겨받기 (ADR-0004). 기한이 지나도록 결과가 기록되지 않은 IN_FLIGHT 건을 결과 미확정으로 돌리고 owner를 비운다.
   * owner를 비우므로 원래 주인이 늦게 보내는 결과 기록은 펜싱에 걸린다.
   * 보냈는지 모르므로 바로 다시 보내지 않고, 넘겨받은 시각 + 조회 대기 뒤에 결과 확인을 한다 (ADR-0002).
   */
  async takeOverExpired(reconcileDelayMs: number): Promise<number> {
    const expired = this.db.$with('expired').as(
      this.db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.status, DeliveryStatus.IN_FLIGHT),
            lt(deliveries.leaseUntil, dbNow),
          ),
        )
        .limit(TAKEOVER_BATCH)
        .for('update', { skipLocked: true }),
    );
    const result = await this.db
      .with(expired)
      .update(deliveries)
      .set({
        status: DeliveryStatus.UNCONFIRMED,
        owner: null,
        leaseUntil: null,
        updatedAt: dbNow,
        lastErrorCode: 'LEASE_EXPIRED',
        lastErrorMessage:
          'Taken over because no result was recorded before the lease expired',
        reconcileAfter: dbNowPlus(reconcileDelayMs),
        lookupFailures: 0,
      })
      .from(expired)
      .where(eq(deliveries.id, expired.id));

    return result.rowCount ?? 0;
  }

  /**
   * 결과 확인 대상 꺼내기. 조회는 읽기만 하므로 겹쳐도 해롭지 않다 (ADR-0032).
   * 조회 중 죽어도 leaseMs 뒤 다른 워커가 다시 집는다.
   */
  async claimReconcile(
    limit: number,
    leaseMs: number,
  ): Promise<ReconcileItem[]> {
    const due = this.db.$with('due').as(
      this.db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.status, DeliveryStatus.UNCONFIRMED),
            lte(deliveries.reconcileAfter, dbNow),
          ),
        )
        .orderBy(asc(deliveries.reconcileAfter))
        .limit(limit)
        .for('update', { skipLocked: true }),
    );

    return this.db
      .with(due)
      .update(deliveries)
      .set({
        owner: this.workerId,
        updatedAt: dbNow,
        reconcileAfter: dbNowPlus(leaseMs),
      })
      .from(due)
      .where(eq(deliveries.id, due.id))
      .returning({
        id: deliveries.id,
        alarmId: deliveries.alarmId,
        recipientId: deliveries.recipientId,
        attempts: deliveries.attempts,
        lookupFailures: deliveries.lookupFailures,
      });
  }

  /**
   * 결과 확인 결과 기록 (ADR-0002, 0017). decide는 잠금 아래에서 읽은 알림 상태로 결정을 내린다.
   * 기록이 없고 알림이 취소 중이면 다시 보내지 않고 CANCELED로 둔다.
   */
  async recordReconcile(
    item: ReconcileItem,
    decide: (isAlarmCanceling: boolean) => ReconcileDecision,
  ): Promise<{ decision: ReconcileDecision; outcome: WriteOutcome }> {
    let decision: ReconcileDecision = { kind: 'resend' };
    const fence = and(
      eq(deliveries.id, item.id),
      eq(deliveries.status, DeliveryStatus.UNCONFIRMED),
      eq(deliveries.owner, this.workerId),
    )!;
    const outcome = await this.writeLocked(
      item.alarmId,
      fence,
      (alarmStatus) => {
        decision = decide(alarmStatus !== AlarmStatus.SENDING);

        switch (decision.kind) {
          case 'sent':
            return {
              status: DeliveryStatus.SENT,
              messageId: decision.messageId,
              sentAt: new Date(decision.sentAt),
              // 한 번 확인된 중복 표시는 지우지 않는다.
              ...(decision.duplicate ? { duplicateDetected: true } : {}),
              lastErrorCode: null,
              lastErrorMessage: null,
            };
          case 'canceled':
            return { status: DeliveryStatus.CANCELED };
          case 'failed':
            return {
              status: DeliveryStatus.FAILED,
              lastErrorCode: decision.code,
              lastErrorMessage: decision.message,
            };
          case 'resend':
            return backToPending(alarmStatus, dbNow);
          case 'retry_lookup':
            return {
              status: DeliveryStatus.UNCONFIRMED,
              reconcileAfter: dbNowPlus(decision.delayMs),
              lookupFailures: sql`${deliveries.lookupFailures} + 1`,
            };
        }
      },
    );

    return { decision, outcome };
  }

  /** 펜싱에 걸린 뒤 실제 중복이 확인되면 표시한다 (ADR-0004). 상태와 관계없이 남긴다. */
  async markDuplicate(deliveryId: number): Promise<void> {
    await this.db
      .update(deliveries)
      .set({ duplicateDetected: true, updatedAt: dbNow })
      .where(eq(deliveries.id, deliveryId));
  }

  /** IN_FLIGHT에서 나가는 쓰기의 조건. 이 워커가 이 시도로 쥔 건일 때만 반영한다 (ADR-0004). */
  private inFlightFence(delivery: ClaimedDelivery): SQL {
    return and(
      eq(deliveries.id, delivery.id),
      eq(deliveries.status, DeliveryStatus.IN_FLIGHT),
      eq(deliveries.owner, this.workerId),
      eq(deliveries.attempts, delivery.attempts),
    )!;
  }

  /**
   * 알림 행을 잠근 트랜잭션에서 fence에 맞는 행에만 change를 반영하고, 같은 트랜잭션에서 완료 판정을 한다 (ADR-0018).
   * change는 잠금 아래에서 읽은 알림 상태로 정한다.
   */
  private async writeLocked(
    alarmId: string,
    fence: SQL,
    change: (alarmStatus: AlarmStatus) => DeliveryChange,
  ): Promise<WriteOutcome> {
    const { result: isApplied, finished } = await withAlarmLock(
      this.db,
      alarmId,
      (tx, alarm) => applyFenced(tx, fence, change(alarm.status)),
    );

    return isApplied ? { applied: true, finished } : { applied: false };
  }
}

/**
 * 대기로 되돌리는 변경. 알림이 SENDING이 아니면 PENDING 대신 CANCELED로 둔다 (ADR-0017).
 * 정리가 끝난 뒤 PENDING이 다시 생기면 영원히 꺼내지지 않기 때문이다. alarmStatus는 잠금 아래에서 읽은 값이다.
 */
function backToPending(
  alarmStatus: AlarmStatus,
  nextAttemptAt: SQL,
  error?: { code: string; message: string },
): DeliveryChange {
  const errorFields = error
    ? { lastErrorCode: error.code, lastErrorMessage: error.message }
    : {};
  const isStillSending = alarmStatus === AlarmStatus.SENDING;
  if (!isStillSending) {
    return { status: DeliveryStatus.CANCELED, ...errorFields };
  }

  return { status: DeliveryStatus.PENDING, nextAttemptAt, ...errorFields };
}

async function applyFenced(
  tx: Tx,
  fence: SQL,
  change: DeliveryChange,
): Promise<boolean> {
  const result = await tx
    .update(deliveries)
    .set({ ...change, owner: null, updatedAt: dbNow })
    .where(fence);

  return (result.rowCount ?? 0) > 0;
}
