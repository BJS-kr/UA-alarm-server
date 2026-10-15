import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { createApiApp } from '../../src/api/create-api-app';
import { loadConfig } from '../../src/shared/config/app-config';
import { createPool } from '../../src/shared/db/database';
import { CapturingLogger, insertAlarm } from './support/fixtures';
import { createTestDatabase, TestDatabase } from './support/test-database';

const KEY = 'test-key';

describe('API (ADR-0015, 0016, 0019~0024)', () => {
  let database: TestDatabase;
  let app: INestApplication;
  let base: string;

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    auth = true,
  ) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${KEY}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return {
      status: res.status,
      headers: res.headers,
      json: (await res.json()) as any,
    };
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    const config = loadConfig(
      { DATABASE_URL: database.url, API_KEY: KEY },
      'api',
    );

    app = await createApiApp(config, database.pool, new CapturingLogger());
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // pool은 앱 종료 훅이 닫는다.
    await app.close();
    await database.drop();
  });

  it('키가 없거나 틀리면 401과 WWW-Authenticate를 준다 (ADR-0033)', async () => {
    const missing = await call('GET', '/v1/alarms', undefined, false);

    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    expect(missing.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    expect(missing.json).toMatchObject({
      type: '/problems/unauthorized',
      status: 401,
      instance: '/v1/alarms',
    });
    expect(missing.json.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('생성은 201과 Location을 주고 발송하지 않는다', async () => {
    const created = await call('POST', '/v1/alarms', {
      type: 'BULK',
      title: '추석 이벤트',
      body: '본문',
    });

    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe(
      `/v1/alarms/${created.json.id}`,
    );
    expect(created.json).toMatchObject({
      type: 'BULK',
      title: '추석 이벤트',
      status: 'CREATED',
      startedAt: null,
    });
    const deliveries = await database.db.execute(
      sql`SELECT count(*)::int AS n FROM deliveries`,
    );

    expect(deliveries.rows[0]).toEqual({ n: 0 });
  });

  it.each([
    ['type 누락', { title: 't', body: 'b' }, 'type'],
    [
      '모르는 필드',
      { type: 'URGENT', title: 't', body: 'b', recipientIDs: ['u_1'] },
      'recipientIDs',
    ],
    [
      '대량에 수신자 지정',
      { type: 'BULK', title: 't', body: 'b', recipientIds: ['u_1'] },
      'recipientIds',
    ],
    [
      '긴급에 수신자 없음',
      { type: 'URGENT', title: 't', body: 'b' },
      'recipientIds',
    ],
    [
      '수신자 중복',
      { type: 'URGENT', title: 't', body: 'b', recipientIds: ['u_1', 'u_1'] },
      'recipientIds',
    ],
    [
      '수신자 101명',
      {
        type: 'URGENT',
        title: 't',
        body: 'b',
        recipientIds: Array.from({ length: 101 }, (_, i) => `u_${i}`),
      },
      'recipientIds',
    ],
    ['공백 제목', { type: 'BULK', title: '   ', body: 'b' }, 'title'],
  ])('%s → 400과 필드별 오류 (ADR-0021)', async (_name, body, field) => {
    const res = await call('POST', '/v1/alarms', body);

    expect(res.status).toBe(400);
    expect(res.json.type).toBe('/problems/validation-failed');
    expect(res.json.errors.map((e: { field: string }) => e.field)).toContain(
      field,
    );
  });

  it('잘못된 ID는 400, 없는 알림은 404 (ADR-0020)', async () => {
    expect((await call('GET', '/v1/alarms/abc')).status).toBe(400);
    const missing = await call(
      'GET',
      '/v1/alarms/01a14061-ccd0-7cf7-8965-64f6fc45d0aa',
    );

    expect(missing.status).toBe(404);
    expect(missing.json.type).toBe('/problems/not-found');
  });

  it('긴급 알림의 발송 시작은 같은 트랜잭션에서 수신자 정의로 Delivery를 만든다 (ADR-0011)', async () => {
    const created = await call('POST', '/v1/alarms', {
      type: 'URGENT',
      title: '결제',
      body: '482913',
      recipientIds: ['u_2', 'u_1'],
    });
    const started = await call('POST', `/v1/alarms/${created.json.id}/send`);

    expect(started.status).toBe(202);
    expect(started.json.status).toBe('SENDING');
    const rows = await database.db.execute<{
      recipient_id: string;
      priority: number;
      status: string;
    }>(
      sql`SELECT recipient_id, priority, status FROM deliveries WHERE alarm_id = ${created.json.id} ORDER BY recipient_id`,
    );

    expect(rows.rows).toEqual([
      { recipient_id: 'u_1', priority: 0, status: 'PENDING' },
      { recipient_id: 'u_2', priority: 0, status: 'PENDING' },
    ]);
    const detail = await call('GET', `/v1/alarms/${created.json.id}`);

    expect(detail.json.counts).toMatchObject({ total: 2, pending: 2 });
    expect(detail.json.recipientIds).toEqual(['u_1', 'u_2']);
  });

  it('같은 발송 시작이 동시에 10번 와도 전이는 한 번이고 모두 성공으로 답한다 (ADR-0016)', async () => {
    const created = await call('POST', '/v1/alarms', {
      type: 'URGENT',
      title: 't',
      body: 'b',
      recipientIds: ['u_1', 'u_2', 'u_3'],
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        call('POST', `/v1/alarms/${created.json.id}/send`),
      ),
    );

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(202));
    const rows = await database.db.execute(
      sql`SELECT count(*)::int AS n FROM deliveries WHERE alarm_id = ${created.json.id}`,
    );

    expect(rows.rows[0]).toEqual({ n: 3 });
  });

  it('발송 시작과 취소가 동시에 와도, 실제로 발송을 시작한 요청은 202를 받는다 (ADR-0016)', async () => {
    for (let round = 0; round < 20; round++) {
      const created = await call('POST', '/v1/alarms', {
        type: 'BULK',
        title: `race ${round}`,
        body: 'b',
      });
      const id = created.json.id;
      const [send, ...cancels] = await Promise.all([
        call('POST', `/v1/alarms/${id}/send`),
        ...Array.from({ length: 10 }, () =>
          call('POST', `/v1/alarms/${id}/cancel`),
        ),
      ]);
      const final = await call('GET', `/v1/alarms/${id}`);
      // 발송이 먼저였다면 시작 시각이 남는다. 그 경우 발송 요청은 시작을 했으므로 202여야 한다.
      const isStarted = final.json.startedAt !== null;

      expect([round, send.status]).toEqual([round, isStarted ? 202 : 409]);
      for (const cancel of cancels) expect([200, 202]).toContain(cancel.status);
    }
  });

  it('시작 전 취소는 바로 CANCELED(200)이고, 취소된 알림의 시작은 409와 현재 상태를 준다', async () => {
    const created = await call('POST', '/v1/alarms', {
      type: 'BULK',
      title: 't',
      body: 'b',
    });
    const canceled = await call('POST', `/v1/alarms/${created.json.id}/cancel`);

    expect(canceled.status).toBe(200);
    expect(canceled.json).toMatchObject({ status: 'CANCELED' });
    expect(canceled.json.finishedAt).not.toBeNull();
    expect(
      (await call('POST', `/v1/alarms/${created.json.id}/cancel`)).status,
    ).toBe(200);
    const started = await call('POST', `/v1/alarms/${created.json.id}/send`);

    expect(started.status).toBe(409);
    expect(started.json).toMatchObject({
      type: '/problems/invalid-state',
      currentStatus: 'CANCELED',
    });
  });

  it('발송 중 취소는 CANCELING(202)이고 다시 요청해도 202다 (ADR-0017)', async () => {
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      recipients: ['u_1'],
    });

    expect((await call('POST', `/v1/alarms/${alarm.id}/cancel`)).status).toBe(
      202,
    );
    const again = await call('POST', `/v1/alarms/${alarm.id}/cancel`);

    expect(again.status).toBe(202);
    expect(again.json.status).toBe('CANCELING');
  });

  it('완료된 알림의 취소는 409, 시작은 200이다', async () => {
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      status: 'COMPLETED',
    });

    expect(
      (await call('POST', `/v1/alarms/${alarm.id}/cancel`)).json,
    ).toMatchObject({ status: 409, currentStatus: 'COMPLETED' });
    expect((await call('POST', `/v1/alarms/${alarm.id}/send`)).status).toBe(
      200,
    );
  });

  it('목록은 최신순 커서로 나뉘고 상태로 거를 수 있다 (ADR-0024)', async () => {
    const ids: string[] = [];

    for (let i = 0; i < 5; i++) {
      ids.push(
        (
          await call('POST', '/v1/alarms', {
            type: 'BULK',
            title: `p${i}`,
            body: 'b',
          })
        ).json.id,
      );
    }

    const first = await call('GET', '/v1/alarms?limit=2&status=CREATED');
    const second = await call(
      'GET',
      `/v1/alarms?limit=2&status=CREATED&cursor=${first.json.nextCursor}`,
    );

    expect(first.json.items.map((a: { id: string }) => a.id)).toEqual([
      ids[4],
      ids[3],
    ]);
    expect(second.json.items.map((a: { id: string }) => a.id)).toEqual([
      ids[2],
      ids[1],
    ]);
    expect((await call('GET', '/v1/alarms?cursor=garbage')).status).toBe(400);
  });

  it('수신자별 결과는 수신자 순서 커서로 나뉘고 상태로 거를 수 있다', async () => {
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      recipients: ['u_3', 'u_1', 'u_2', 'u_4'],
    });

    await database.db.execute(
      sql`UPDATE deliveries SET status = 'FAILED' WHERE alarm_id = ${alarm.id} AND recipient_id IN ('u_2', 'u_4')`,
    );
    const page1 = await call(
      'GET',
      `/v1/alarms/${alarm.id}/deliveries?limit=2`,
    );
    const page2 = await call(
      'GET',
      `/v1/alarms/${alarm.id}/deliveries?limit=2&cursor=${page1.json.nextCursor}`,
    );

    expect(
      [...page1.json.items, ...page2.json.items].map(
        (d: { recipientId: string }) => d.recipientId,
      ),
    ).toEqual(['u_1', 'u_2', 'u_3', 'u_4']);
    expect(page2.json.nextCursor).toBeNull();
    const failed = await call(
      'GET',
      `/v1/alarms/${alarm.id}/deliveries?status=FAILED`,
    );

    expect(
      failed.json.items.map((d: { recipientId: string }) => d.recipientId),
    ).toEqual(['u_2', 'u_4']);
  });

  it('OpenAPI 문서는 3.0.x다 (ADR-0037)', async () => {
    const res = await fetch(`${base}/docs/openapi.json`);

    expect(((await res.json()) as { openapi: string }).openapi).toMatch(
      /^3\.0\./,
    );
  });
});

describe('DB를 기다리다 응답 없이 멈추지 않는다 (ADR-0039)', () => {
  it('DB 연결을 얻지 못하면 정해 둔 시간 안에 503 Problem Details로 답한다', async () => {
    const database = await createTestDatabase();
    const config = loadConfig(
      { DATABASE_URL: database.url, API_KEY: KEY },
      'api',
    );
    // 연결 하나짜리 풀. 그 연결을 다른 쿼리가 붙잡으면 요청은 연결을 얻지 못한다.
    const pool = createPool(
      database.url,
      'alarm-api-test',
      1,
      () => undefined,
      { acquireMs: 200, queryMs: 5_000 },
    );
    const app = await createApiApp(config, pool, new CapturingLogger());

    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;

    try {
      const holder = pool.query('SELECT pg_sleep(1.5)');
      const startedAt = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/v1/alarms`, {
        headers: { authorization: `Bearer ${KEY}` },
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        type: '/problems/service-unavailable',
        status: 503,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await holder;
    } finally {
      await app.close();
      await database.drop();
    }
  });
});
