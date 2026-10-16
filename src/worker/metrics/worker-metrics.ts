import { unhandledErrors } from '../../shared/runtime/process-guardrail';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

/** 워커 프로세스 내부 동작 메트릭 (ADR-0027). DB 상태 집계 메트릭은 api 프로세스가 노출한다. */
export class WorkerMetrics {
  readonly registry = new Registry();

  readonly sendRequests = new Counter({
    name: 'alarm_send_requests_total',
    help: '외부 발송 API 호출 결과별 누적 건수',
    labelNames: ['priority', 'result'] as const,
    registers: [this.registry],
  });

  readonly sendDuration = new Histogram({
    name: 'alarm_send_duration_seconds',
    help: '외부 발송 API 요청 소요 시간(초)',
    labelNames: ['priority'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly inFlight = new Gauge({
    name: 'alarm_send_in_flight',
    help: '현재 워커에서 진행 중인 외부 발송 요청 수',
    registers: [this.registry],
  });

  readonly urgentDispatchLatency = new Histogram({
    name: 'alarm_urgent_dispatch_latency_seconds',
    help: '긴급 알림 발송 시작(started_at)부터 외부 API 접수(sent_at)까지 소요 시간(초)',
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [this.registry],
  });

  readonly reconciles = new Counter({
    name: 'alarm_reconcile_total',
    help: '결과 미확정(UNCONFIRMED) 건의 발송 내역 조회(상태 확정) 결과별 건수',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'alarm_duplicates_detected_total',
    help: '외부 발송 내역 조회에서 동일 멱등 키로 2건 이상 확인된 중복 발송 건수',
    registers: [this.registry],
  });

  readonly fencedWrites = new Counter({
    name: 'alarm_fenced_writes_total',
    help: '리스 만료 회수 이후 펜싱 토큰(attempt) 불일치로 거부된 지연 결과 기록 횟수',
    registers: [this.registry],
  });

  readonly takeovers = new Counter({
    name: 'alarm_takeovers_total',
    help: '리스 만료(lease_until 경과)로 회수되어 UNCONFIRMED로 전이된 Delivery 건수',
    registers: [this.registry],
  });

  readonly breakerTrips = new Counter({
    name: 'alarm_breaker_trips_total',
    help: '서킷 브레이커 OPEN 전이 횟수',
    registers: [this.registry],
  });

  readonly tokenRequests = new Counter({
    name: 'alarm_token_requests_total',
    help: 'DB 토큰 버킷 차감 요청 횟수 (result=granted|empty)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly breakerProbes = new Counter({
    name: 'alarm_breaker_probes_total',
    help: '서킷 브레이커 프로브(단건 시험 발송) 결과별 건수 (recovered | still_failing)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly rateLimitPauses = new Counter({
    name: 'alarm_rate_limit_pauses_total',
    help: '외부 API 429 응답으로 인한 전역 일시 정지 횟수',
    registers: [this.registry],
  });

  readonly expansionPages = new Counter({
    name: 'alarm_expansion_pages_total',
    help: '수신자 확장(Expansion)으로 커밋된 사용자 페이지 수',
    registers: [this.registry],
  });

  readonly expansionFetchFailures = new Counter({
    name: 'alarm_expansion_fetch_failures_total',
    help: '수신자 확장 중 외부 사용자 목록 조회 실패 횟수 (transient | permanent)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  readonly loopErrors = new Counter({
    name: 'alarm_loop_errors_total',
    help: '워커 폴링 루프 주기에서 발생한 예기치 않은 오류 횟수',
    labelNames: ['loop'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    this.registry.registerMetric(unhandledErrors);
  }
}
