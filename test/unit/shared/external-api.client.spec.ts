import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { ExternalApiClient } from '../../../src/shared/external/external-api.client';

/** 응답만 정해 둔 작은 HTTP 서버로 응답 분류를 확인한다 (ADR-0002, 0037). */
function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const input = { alarmId: 'a', recipientId: 'u_1', body: 'b', clientRef: 'a:u_1' };

describe('외부 발송 API 응답 분류', () => {
  const cases: Array<[string, (res: http.ServerResponse) => void, Record<string, unknown>]> = [
    ['202는 접수', (res) => res.writeHead(202).end('{"messageId":"m_1"}'), { kind: 'accepted', messageId: 'm_1' }],
    [
      '400은 영구 실패',
      (res) => res.writeHead(400).end('{"code":"RECIPIENT_BLOCKED","message":"opted out"}'),
      { kind: 'rejected', code: 'RECIPIENT_BLOCKED' },
    ],
    ['429는 Retry-After를 읽는다', (res) => res.writeHead(429, { 'retry-after': '2' }).end('{}'), { kind: 'rate_limited', retryAfterSec: 2 }],
    ['500은 발송되지 않은 일시 오류', (res) => res.writeHead(500).end('{"code":"INTERNAL_ERROR"}'), { kind: 'server_error', status: 500 }],
    ['503은 발송되지 않은 일시 오류', (res) => res.writeHead(503).end('{"code":"SERVICE_UNAVAILABLE"}'), { kind: 'server_error', status: 503 }],
    ['게이트웨이의 502는 전달 여부를 알 수 없다', (res) => res.writeHead(502).end('bad gateway'), { kind: 'unknown' }],
    ['접수했는데 응답을 해석할 수 없으면 알 수 없다', (res) => res.writeHead(202).end('not json'), { kind: 'unknown', code: 'UNPARSABLE_ACCEPT' }],
  ];

  it.each(cases)('%s', async (_name, respond, expected) => {
    const server = await serve((_req, res) => respond(res));
    const client = new ExternalApiClient(server.url, 5);
    try {
      expect(await client.sendMessage(input, 2000)).toMatchObject(expected);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('연결이 거부되면 요청이 나가지 않은 것이다', async () => {
    const server = await serve(() => undefined);
    const url = server.url;
    await server.close();
    const client = new ExternalApiClient(url, 5);
    expect(await client.sendMessage(input, 2000)).toMatchObject({ kind: 'not_sent', code: 'ECONNREFUSED' });
    client.close();
  });

  it('요청을 보낸 뒤 응답이 없으면 보냈는지 모르는 것이다', async () => {
    const received: string[] = [];
    const server = await serve((req) => req.on('data', (chunk: Buffer) => received.push(chunk.toString())));
    const client = new ExternalApiClient(server.url, 5);
    try {
      expect(await client.sendMessage(input, 300)).toMatchObject({ kind: 'unknown', code: 'CLIENT_TIMEOUT' });
      expect(received.join('')).toContain('a:u_1');
    } finally {
      client.close();
      await server.close();
    }
  });

  it('발송 내역 조회와 사용자 조회를 해석한다', async () => {
    const server = await serve((req, res) => {
      if (req.url?.startsWith('/v1/messages')) {
        expect(req.url).toBe('/v1/messages?clientRef=a%3Au_1');
        res.writeHead(200).end('{"messages":[{"messageId":"m_1","recipientId":"u_1","sentAt":"t"}]}');
      } else {
        expect(req.url).toBe('/v1/users?limit=2&cursor=Mw');
        res.writeHead(200).end('{"users":[{"id":"u_3"}],"nextCursor":null}');
      }
    });
    const client = new ExternalApiClient(server.url, 5);
    try {
      expect(await client.lookupMessages('a:u_1', 1000)).toEqual({
        kind: 'ok',
        messages: [{ messageId: 'm_1', recipientId: 'u_1', sentAt: 't' }],
      });
      expect(await client.listUsers('Mw', 2, 1000)).toEqual({ kind: 'ok', users: [{ id: 'u_3' }], nextCursor: null });
    } finally {
      client.close();
      await server.close();
    }
  });

  it('조회가 실패하면 오류로 돌려준다', async () => {
    const server = await serve((_req, res) => res.writeHead(500).end('x'));
    const client = new ExternalApiClient(server.url, 5);
    try {
      expect(await client.lookupMessages('a:u_1', 1000)).toMatchObject({ kind: 'error', code: 'HTTP_500' });
    } finally {
      client.close();
      await server.close();
    }
  });
});
