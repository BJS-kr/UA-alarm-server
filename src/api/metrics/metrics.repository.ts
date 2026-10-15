import { and, count, eq, lte, min, sql } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { dbNow } from '../../shared/db/db-clock';
import { alarms, deliveries } from '../../shared/db/schema';
import { AlarmStatus, DeliveryStatus } from '../../shared/domain/status';

/** 지금으로부터 몇 초 전인가. DB 시계로 잰다. */
function secondsSince(column: Parameters<typeof min>[0]) {
  return sql<
    number | null
  >`EXTRACT(EPOCH FROM clock_timestamp() - ${min(column)})::float`;
}

/** api가 DB에서 세어 내는 메트릭의 쿼리 (ADR-0027). 스크레이프할 때 센다. */
export class ApiMetricsRepository {
  constructor(private readonly db: Db) {}

  pendingByPriority() {
    return this.db
      .select({ priority: deliveries.priority, count: count() })
      .from(deliveries)
      .where(eq(deliveries.status, DeliveryStatus.PENDING))
      .groupBy(deliveries.priority);
  }

  /** 지금 꺼낼 수 있는데 아직 남아 있는 가장 오래된 대기 건의 나이 */
  oldestDueByPriority() {
    return this.db
      .select({
        priority: deliveries.priority,
        ageSeconds: secondsSince(deliveries.nextAttemptAt),
      })
      .from(deliveries)
      .innerJoin(alarms, eq(alarms.id, deliveries.alarmId))
      .where(
        and(
          eq(deliveries.status, DeliveryStatus.PENDING),
          lte(deliveries.nextAttemptAt, dbNow),
          eq(alarms.status, AlarmStatus.SENDING),
        ),
      )
      .groupBy(deliveries.priority);
  }

  async oldestInFlightSeconds(): Promise<number> {
    const [row] = await this.db
      .select({ ageSeconds: secondsSince(deliveries.claimedAt) })
      .from(deliveries)
      .where(eq(deliveries.status, DeliveryStatus.IN_FLIGHT));

    return row?.ageSeconds ?? 0;
  }

  async unconfirmedCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(deliveries)
      .where(eq(deliveries.status, DeliveryStatus.UNCONFIRMED));

    return row?.count ?? 0;
  }

  alarmsByStatus() {
    return this.db
      .select({ status: alarms.status, count: count() })
      .from(alarms)
      .groupBy(alarms.status);
  }
}
