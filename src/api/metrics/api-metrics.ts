import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import { Db } from '../../shared/db/database';
import { unhandledErrors } from '../../shared/runtime/process-guardrail';
import { ApiMetricsRepository } from './metrics.repository';

/**
 * DB 상태 집계 메트릭은 api 프로세스에서만 노출한다 (ADR-0027).
 * 워커마다 중복 집계되는 것을 방지하며 스크레이프 시점에 쿼리한다.
 */
export function createApiRegistry(db: Db): Registry {
  const registry = new Registry();
  const repository = new ApiMetricsRepository(db);

  collectDefaultMetrics({ register: registry });
  registry.registerMetric(unhandledErrors);

  new Gauge({
    name: 'alarm_deliveries_pending',
    help: '우선순위별 발송 대기(PENDING) Delivery 건수 (priority 0=긴급, 1=대량)',
    labelNames: ['priority'],
    registers: [registry],
    async collect() {
      const rows = await repository.pendingByPriority();

      this.reset();

      for (const row of rows) {
        this.set({ priority: String(row.priority) }, row.count);
      }
    },
  });

  new Gauge({
    name: 'alarm_pending_oldest_due_seconds',
    help: '점유 가능 시각(next_attempt_at)이 도래한 최장기 PENDING 건의 경과 시간(초)',
    labelNames: ['priority'],
    registers: [registry],
    async collect() {
      const rows = await repository.oldestDueByPriority();

      this.reset();

      for (const row of rows) {
        this.set({ priority: String(row.priority) }, row.ageSeconds ?? 0);
      }
    },
  });

  new Gauge({
    name: 'alarm_oldest_in_flight_seconds',
    help: '최장기 IN_FLIGHT 건의 경과 시간(초). 리스(30초) 만료 후 회수 지연 여부 확인용',
    registers: [registry],
    async collect() {
      this.set(await repository.oldestInFlightSeconds());
    },
  });

  new Gauge({
    name: 'alarm_deliveries_unconfirmed',
    help: '발송 내역 조회(상태 확정) 대기 중인 UNCONFIRMED Delivery 건수',
    registers: [registry],
    async collect() {
      this.set(await repository.unconfirmedCount());
    },
  });

  new Gauge({
    name: 'alarm_alarms',
    help: '상태별 알림(Alarm) 수',
    labelNames: ['status'],
    registers: [registry],
    async collect() {
      const rows = await repository.alarmsByStatus();

      this.reset();
      for (const row of rows) this.set({ status: row.status }, row.count);
    },
  });

  return registry;
}
