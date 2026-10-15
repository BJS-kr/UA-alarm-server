import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** 워커 메모리 안에서 일어나는 일의 메트릭 (ADR-0027). DB에서 세는 값은 api가 낸다. */
export class WorkerMetrics {
  readonly registry = new Registry();

  readonly sendRequests = new Counter({
    name: 'alarm_send_requests_total',
    help: '외부 발송 요청 결과별 건수',
    labelNames: ['priority', 'result'] as const,
    registers: [this.registry],
  });

  readonly sendDuration = new Histogram({
    name: 'alarm_send_duration_seconds',
    help: '외부 발송 요청 응답 시간',
    labelNames: ['priority'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly inFlight = new Gauge({
    name: 'alarm_send_in_flight',
    help: '이 워커에서 응답을 기다리는 발송 요청 수',
    registers: [this.registry],
  });

  readonly urgentDispatchLatency = new Histogram({
    name: 'alarm_urgent_dispatch_latency_seconds',
    help: '긴급 알림 발송 시작부터 외부 접수까지 걸린 시간',
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [this.registry],
  });

  readonly reconciles = new Counter({
    name: 'alarm_reconcile_total',
    help: '결과 확인 결과별 건수',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'alarm_duplicates_detected_total',
    help: '외부 기록이 2건 이상으로 확인된 중복 발송. 1 이상이면 즉시 확인한다',
    registers: [this.registry],
  });

  readonly fencedWrites = new Counter({
    name: 'alarm_fenced_writes_total',
    help: '넘겨받힌 뒤 늦게 도착해 거부된 결과 기록',
    registers: [this.registry],
  });

  readonly takeovers = new Counter({
    name: 'alarm_takeovers_total',
    help: '주인이 사라져 넘겨받은 Delivery 수',
    registers: [this.registry],
  });

  readonly invalidations = new Counter({
    name: 'alarm_worker_invalidations_total',
    help: '이 워커가 무효로 선언해 끊은 세션 수',
    registers: [this.registry],
  });

  readonly breakerTrips = new Counter({
    name: 'alarm_breaker_trips_total',
    help: '서킷 브레이커 발동 횟수',
    registers: [this.registry],
  });

  readonly rateLimitPauses = new Counter({
    name: 'alarm_rate_limit_pauses_total',
    help: '429로 전체를 멈춘 횟수',
    registers: [this.registry],
  });

  readonly expansionPages = new Counter({
    name: 'alarm_expansion_pages_total',
    help: '펼치기로 커밋한 사용자 페이지 수',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
