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

/** 리스 만료 회수(Takeover) 1회당 최대 처리 건수. */
const TAKEOVER_BATCH = 500;

/**
 * Delivery 상태 전이 저장소 (ADR-0032). 모든 전이는 조건부 UPDATE로 수행하며,
 * IN_FLIGHT에서 전이하는 쓰기에는 owner와 attempts 조건(펜싱 토큰)을 부여한다 (ADR-0004).
 */
export class DeliveryRepository {
  /**
   * claimDb는 발송 폴링 루프 전용 커넥션이다. 결과 기록 트랜잭션이 알림 행 잠금을 대기하는 동안에도
   * 점유(claim) 쿼리가 커넥션 풀 고갈로 지연되지 않도록 분리한다.
   */
  constructor(
    private readonly db: Db,
    private readonly workerId: number,
    private readonly claimDb: Db = db,
  ) {}

  /**
   * 발송 대상 점유(claim, ADR-0011, 0012, 0017). 획득한 토큰 수만큼만 점유한다.
   * 우선순위(priority) → 발송 시작 순번(start_seq) → 생성 순번(id) 순으로 정렬하며,
   * SENDING 상태 알림의 Delivery만 점유하여 취소 1단계 커밋 이후 신규 점유를 차단한다 (ADR-0017).
   * 점유 시 만료 시각(lease_until = now + leaseMs)을 기록하며, 만료 시 다른 워커가 회수한다 (ADR-0004).
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

    // UPDATE ... RETURNING은 정렬 순서를 보장하지 않으므로 점유 우선순위 순으로 재정렬한다.
    return claimed.sort((a, b) => a.priority - b.priority || a.id - b.id);
  }

  /** 발송 결과 기록. 리스 만료 회수 이후 뒤늦게 도착한 결과는 펜싱 조건에 의해 거부된다. */
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
              // 장애 동안의 응답 없음은 시도 횟수에 세지 않는다 (ADR-0014).
              ...(decision.uncounted
                ? { attempts: sql`${deliveries.attempts} - 1` }
                : {}),
            };
        }
      },
    );
  }

  /** 미전송 건 반납 (발송 직전 리스 검증 실패 또는 정상 종료 시, ADR-0004, 0007). */
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
   * 리스 만료 회수(Takeover, ADR-0004). lease_until이 경과한 IN_FLIGHT 건을 UNCONFIRMED로 전이하고 owner를 해제한다.
   * owner가 해제되므로 기존 워커의 지연 쓰기는 펜싱 조건에서 거부된다.
   * 전송 여부를 단정할 수 없으므로 즉시 재발송하지 않고 reconcile_after 경과 후 발송 내역 조회(상태 확정)를 수행한다 (ADR-0002).
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
   * 발송 내역 조회(상태 확정) 대상 점유 (ADR-0032).
   * 점유 후 워커가 중단되더라도 leaseMs 경과 후 다른 워커가 재점유한다.
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
   * 발송 내역 조회(상태 확정) 결과 기록 (ADR-0002, 0017).
   * 잠금 하에서 읽은 알림 상태가 취소 중(CANCELING)이고 발송 내역이 없으면 재발송 대신 CANCELED로 전이한다.
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
              // 한 번 감지된 중복 발송 플래그는 유지한다.
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

  /** 펜싱 거부 이후 실제 중복 발송이 확인된 경우 플래그를 기록한다 (ADR-0004). */
  async markDuplicate(deliveryId: number): Promise<void> {
    await this.db
      .update(deliveries)
      .set({ duplicateDetected: true, updatedAt: dbNow })
      .where(eq(deliveries.id, deliveryId));
  }

  /** IN_FLIGHT 상태 전이 펜싱 조건 (현재 워커 ID 및 시도 번호 일치 검증, ADR-0004). */
  private inFlightFence(delivery: ClaimedDelivery): SQL {
    return and(
      eq(deliveries.id, delivery.id),
      eq(deliveries.status, DeliveryStatus.IN_FLIGHT),
      eq(deliveries.owner, this.workerId),
      eq(deliveries.attempts, delivery.attempts),
    )!;
  }

  /**
   * 알림 행 잠금 트랜잭션 내에서 펜싱 조건을 만족하는 행에 변경을 반영하고 완료 판정을 수행한다 (ADR-0018).
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
 * PENDING 복귀 처리. 알림 상태가 SENDING이 아니면 PENDING 대신 CANCELED로 전이한다 (ADR-0017).
 * 취소 정리 완료 후 새로운 PENDING이 생성되어 미처리 상태로 남는 것을 방지한다.
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
