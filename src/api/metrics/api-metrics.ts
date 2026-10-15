import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import { Db } from '../../shared/db/database';
import { unhandledErrors } from '../../shared/runtime/process-guardrail';
import { ApiMetricsRepository } from './metrics.repository';

/**
 * DB에서 세는 메트릭은 api 한 곳에서만 낸다 (ADR-0027).
 * 워커마다 세면 같은 값이 워커 수만큼 중복되기 때문이다. 값은 스크레이프할 때 센다.
 */
export function createApiRegistry(db: Db): Registry {
  const registry = new Registry();
  const repository = new ApiMetricsRepository(db);

  collectDefaultMetrics({ register: registry });
  registry.registerMetric(unhandledErrors);

  new Gauge({
    name: 'alarm_deliveries_pending',
    help: '우선순위별 대기 건수 (priority 0=긴급, 1=대량)',
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
    help: '지금 꺼낼 수 있는데 아직 남아 있는 가장 오래된 대기 건의 나이. 긴급이 10초를 넘으면 밀리고 있다',
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
    help: '가장 오래 전송 중인 건의 나이. 1분을 넘으면 멈춘 워커가 있다',
    registers: [registry],
    async collect() {
      this.set(await repository.oldestInFlightSeconds());
    },
  });

  new Gauge({
    name: 'alarm_deliveries_unconfirmed',
    help: '결과 확인을 기다리는 건수',
    registers: [registry],
    async collect() {
      this.set(await repository.unconfirmedCount());
    },
  });

  new Gauge({
    name: 'alarm_alarms',
    help: '상태별 알림 수',
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
