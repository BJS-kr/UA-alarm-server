import { Counter, Gauge, Registry } from 'prom-client';
import { ManagementServer } from '../../../src/shared/health/management-server';

const silent = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('관리 포트 (ADR-0026, 0027)', () => {
  it('생존·준비 확인을 200/503으로, 메트릭을 Prometheus 형식으로 낸다', async () => {
    const registry = new Registry();

    new Counter({
      name: 'alarm_test_total',
      help: 'test',
      registers: [registry],
    }).inc(3);
    let ready = true;
    const server = new ManagementServer(
      0,
      { live: () => true, ready: async () => ready, registry },
      silent,
    );
    const port = await server.start();
    const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

    try {
      expect((await get('/health/live')).status).toBe(200);
      expect((await get('/health/ready')).status).toBe(200);
      ready = false;
      const notReady = await get('/health/ready');

      expect(notReady.status).toBe(503);
      expect(await notReady.json()).toEqual({ status: 'unavailable' });
      const metrics = await get('/metrics');

      expect(metrics.headers.get('content-type')).toContain('text/plain');
      expect(await metrics.text()).toContain('alarm_test_total 3');
      expect((await get('/v1/alarms')).status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('확인 함수가 예외를 던지면 503이다', async () => {
    const server = new ManagementServer(
      0,
      {
        live: () => {
          throw new Error('x');
        },
        ready: () => true,
        registry: new Registry(),
      },
      silent,
    );
    const port = await server.start();

    try {
      expect((await fetch(`http://127.0.0.1:${port}/health/live`)).status).toBe(
        503,
      );
    } finally {
      await server.stop();
    }
  });

  it('메트릭을 모으다 실패해도 응답은 503 한 번으로 끝나고 오류를 로그에 남긴다', async () => {
    const registry = new Registry();

    new Gauge({
      name: 'alarm_broken',
      help: 'test',
      registers: [registry],
      collect() {
        throw new Error('collect failed');
      },
    });
    const errors: unknown[] = [];
    const server = new ManagementServer(
      0,
      { live: () => true, ready: () => true, registry },
      { ...silent, error: (...args: unknown[]) => errors.push(args) },
    );
    const port = await server.start();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'unavailable' });
      expect(errors).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});
