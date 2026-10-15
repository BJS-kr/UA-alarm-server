import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { ExternalApiClient } from '../../../src/shared/external/external-api.client';

/** 응답만 정해 둔 작은 HTTP 서버로 응답 분류를 확인한다 (ADR-0002, 0037). */
function serve(handler: http.RequestListener): Promise<{
  url: string;
  connections: () => number;
  close: () => Promise<void>;
}> {
  const server = http.createServer(handler);
  let connections = 0;

  server.on('connection', () => (connections += 1));

  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;

      resolve({
        url: `http://127.0.0.1:${port}`,
        connections: () => connections,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const input = {
  alarmId: 'a',
  recipientId: 'u_1',
  body: 'b',
  clientRef: 'a:u_1',
};

describe('외부 발송 API 응답 분류', () => {
  const cases: Array<
    [string, (res: http.ServerResponse) => void, Record<string, unknown>]
  > = [
    [
      '202는 접수',
      (res) => res.writeHead(202).end('{"messageId":"m_1"}'),
      { kind: 'accepted', messageId: 'm_1' },
    ],
    [
      '400은 영구 실패',
      (res) =>
        res
          .writeHead(400)
          .end('{"code":"RECIPIENT_BLOCKED","message":"opted out"}'),
      { kind: 'rejected', code: 'RECIPIENT_BLOCKED', message: 'opted out' },
    ],
    [
      '429는 Retry-After를 읽는다',
      (res) => res.writeHead(429, { 'retry-after': '2' }).end('{}'),
      { kind: 'rate_limited', retryAfterSec: 2 },
    ],
    [
      '500은 발송되지 않은 일시 오류',
      (res) => res.writeHead(500).end('{"code":"INTERNAL_ERROR"}'),
      { kind: 'server_error', status: 500 },
    ],
    [
      '503은 발송되지 않은 일시 오류',
      (res) => res.writeHead(503).end('{"code":"SERVICE_UNAVAILABLE"}'),
      { kind: 'server_error', status: 503 },
    ],
    [
      '게이트웨이의 502는 전달 여부를 알 수 없다',
      (res) => res.writeHead(502).end('bad gateway'),
      { kind: 'unknown' },
    ],
    [
      '접수했는데 응답을 해석할 수 없으면 알 수 없다',
      (res) => res.writeHead(202).end('not json'),
      { kind: 'unknown', code: 'UNPARSABLE_ACCEPT' },
    ],
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

    expect(await client.sendMessage(input, 2000)).toMatchObject({
      kind: 'not_sent',
      code: 'ECONNREFUSED',
    });
    client.close();
  });

  it('요청을 보낸 뒤 응답이 없으면 보냈는지 모르는 것이다', async () => {
    const received: string[] = [];
    const server = await serve((req) =>
      req.on('data', (chunk: Buffer) => received.push(chunk.toString())),
    );
    const client = new ExternalApiClient(server.url, 5);

    try {
      expect(await client.sendMessage(input, 300)).toEqual({
        kind: 'unknown',
        code: 'CLIENT_TIMEOUT',
        message: 'No response within 300ms',
      });
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
        res
          .writeHead(200)
          .end(
            '{"messages":[{"messageId":"m_1","recipientId":"u_1","sentAt":"t"}]}',
          );
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
      expect(await client.listUsers('Mw', 2, 1000)).toEqual({
        kind: 'ok',
        users: [{ id: 'u_3' }],
        nextCursor: null,
      });
    } finally {
      client.close();
      await server.close();
    }
  });

  it('발송은 POST /v1/messages에 계약대로의 본문을 보낸다', async () => {
    let seen: { method?: string; url?: string; body?: unknown; type?: string } =
      {};
    const server = await serve((req, res) => {
      const chunks: Buffer[] = [];

      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen = {
          method: req.method,
          url: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString()),
          type: req.headers['content-type'],
        };
        res.writeHead(202).end('{"messageId":"m"}');
      });
    });
    const client = new ExternalApiClient(server.url, 5);

    try {
      await client.sendMessage(input, 1000);
      expect(seen).toEqual({
        method: 'POST',
        url: '/v1/messages',
        body: input,
        type: 'application/json',
      });
    } finally {
      client.close();
      await server.close();
    }
  });

  it('keepAlive로 연결을 재사용한다 (ADR-0013)', async () => {
    const server = await serve((_req, res) =>
      res.writeHead(202).end('{"messageId":"m"}'),
    );
    const client = new ExternalApiClient(server.url, 5);

    try {
      await client.sendMessage(input, 1000);
      await client.sendMessage(input, 1000);
      expect(server.connections()).toBe(1);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('조회도 keepAlive로 연결을 재사용한다', async () => {
    const server = await serve((_req, res) =>
      res.writeHead(200).end('{"messages":[]}'),
    );
    const client = new ExternalApiClient(server.url, 5);

    try {
      await client.lookupMessages('a:u_1', 1000);
      await client.lookupMessages('a:u_1', 1000);
      expect(server.connections()).toBe(1);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('조회가 소켓을 모두 차지해도 발송은 기다리지 않고 나간다 (ADR-0013)', async () => {
    // 조회는 응답하지 않고 붙잡고, 발송은 바로 받는다. 소켓 상한은 1이다.
    const server = await serve((req, res) => {
      const isLookup = req.method === 'GET';
      if (isLookup) return;
      res.writeHead(202).end('{"messageId":"m"}');
    });
    const client = new ExternalApiClient(server.url, 1);

    try {
      const lookup = client.lookupMessages('a:u_1', 2000);

      await new Promise((r) => setTimeout(r, 50));
      expect(await client.sendMessage(input, 500)).toMatchObject({
        kind: 'accepted',
      });
      await lookup;
    } finally {
      client.close();
      await server.close();
    }
  });

  it('소켓 수 상한을 넘겨 동시에 보내지 않는다 (ADR-0013)', async () => {
    let open = 0;
    let maxOpen = 0;
    const server = await serve((_req, res) => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      setTimeout(() => {
        open -= 1;
        res.writeHead(202).end('{"messageId":"m"}');
      }, 100);
    });
    const client = new ExternalApiClient(server.url, 2);

    try {
      await Promise.all(
        Array.from({ length: 5 }, () => client.sendMessage(input, 2000)),
      );
      expect(maxOpen).toBe(2);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('연결 단계에서 시간이 다 되면 요청이 나가지 않은 것이다', async () => {
    // 응답하지 않는 주소로 연결을 시도한다. 환경에 따라 시간 초과나 도달 불가로 끝나며, 어느 쪽이든 나가지 않았다.
    const client = new ExternalApiClient('http://10.255.255.1:81', 5);

    try {
      expect((await client.sendMessage(input, 200)).kind).toBe('not_sent');
    } finally {
      client.close();
    }
  });

  it('상태 코드 경계: 2xx는 접수, 300은 접수가 아니며, 504는 알 수 없다', async () => {
    const statuses = [200, 300, 504];
    const server = await serve((_req, res) =>
      res.writeHead(statuses.shift()!).end('{"messageId":"m_9"}'),
    );
    const client = new ExternalApiClient(server.url, 5);

    try {
      expect(await client.sendMessage(input, 1000)).toEqual({
        kind: 'accepted',
        messageId: 'm_9',
      });
      expect(await client.sendMessage(input, 1000)).toMatchObject({
        kind: 'server_error',
        status: 300,
        code: 'HTTP_300',
      });
      expect((await client.sendMessage(input, 1000)).kind).toBe('unknown');
    } finally {
      client.close();
      await server.close();
    }
  });

  it('JSON이 아닌 오류 본문은 앞 200자만 메시지로 쓴다', async () => {
    const long = 'x'.repeat(500);
    const server = await serve((req, res) =>
      res.writeHead(req.method === 'POST' ? 500 : 503).end(long),
    );
    const client = new ExternalApiClient(server.url, 5);

    try {
      expect(await client.sendMessage(input, 1000)).toEqual({
        kind: 'server_error',
        status: 500,
        code: 'HTTP_500',
        message: 'x'.repeat(200),
      });
      expect(await client.lookupMessages('a:u_1', 1000)).toEqual({
        kind: 'error',
        code: 'HTTP_503',
        message: 'x'.repeat(200),
      });
      expect(await client.listUsers(null, 10, 1000)).toEqual({
        kind: 'error',
        code: 'HTTP_503',
        message: 'x'.repeat(200),
      });
    } finally {
      client.close();
      await server.close();
    }
  });

  it('200이어도 모양이 다르면 오류이고, 커서가 없으면 null이다', async () => {
    const bodies = ['{"messages":"nope"}', '{"users":"nope"}', '{"users":[]}'];
    const server = await serve((req, res) => {
      if (req.url?.startsWith('/v1/users')) {
        expect(req.url).toBe('/v1/users?limit=10');
      }

      res.writeHead(200).end(bodies.shift());
    });
    const client = new ExternalApiClient(server.url, 5);

    try {
      expect((await client.lookupMessages('a:u_1', 1000)).kind).toBe('error');
      expect((await client.listUsers(null, 10, 1000)).kind).toBe('error');
      expect(await client.listUsers(null, 10, 1000)).toEqual({
        kind: 'ok',
        users: [],
        nextCursor: null,
      });
    } finally {
      client.close();
      await server.close();
    }
  });

  it('연결이 거부되면 조회와 사용자 조회도 오류로 돌려준다', async () => {
    const server = await serve(() => undefined);
    const url = server.url;

    await server.close();
    const client = new ExternalApiClient(url, 5);

    expect(await client.lookupMessages('a:u_1', 1000)).toMatchObject({
      kind: 'error',
      code: 'ECONNREFUSED',
    });
    expect(await client.listUsers('c', 10, 1000)).toMatchObject({
      kind: 'error',
      code: 'ECONNREFUSED',
    });
    client.close();
  });

  it('200이 아니면 본문 모양이 맞아도 오류이고, 200이어도 JSON이 아니면 오류다', async () => {
    const replies: Array<[number, string]> = [
      [500, '{"messages":[]}'],
      [500, '{"users":[]}'],
      [200, 'not json'],
      [200, 'not json'],
    ];
    const server = await serve((_req, res) => {
      const [status, body] = replies.shift()!;

      res.writeHead(status).end(body);
    });
    const client = new ExternalApiClient(server.url, 5);

    try {
      expect((await client.lookupMessages('a:u_1', 1000)).kind).toBe('error');
      expect((await client.listUsers(null, 10, 1000)).kind).toBe('error');
      expect((await client.lookupMessages('a:u_1', 1000)).kind).toBe('error');
      expect((await client.listUsers(null, 10, 1000)).kind).toBe('error');
    } finally {
      client.close();
      await server.close();
    }
  });

  it('오류 본문에 message가 없으면 본문을 메시지로, 해석할 수 없는 접수 응답은 앞 200자를 남긴다', async () => {
    const long = 'y'.repeat(300);
    const replies: Array<[number, string]> = [
      [400, '{"code":"INVALID_REQUEST"}'],
      [202, long],
    ];
    const server = await serve((_req, res) => {
      const [status, body] = replies.shift()!;

      res.writeHead(status).end(body);
    });
    const client = new ExternalApiClient(server.url, 5);

    try {
      expect(await client.sendMessage(input, 1000)).toEqual({
        kind: 'rejected',
        status: 400,
        code: 'INVALID_REQUEST',
        message: '{"code":"INVALID_REQUEST"}',
      });
      expect(await client.sendMessage(input, 1000)).toEqual({
        kind: 'unknown',
        code: 'UNPARSABLE_ACCEPT',
        message: 'y'.repeat(200),
      });
    } finally {
      client.close();
      await server.close();
    }
  });

  it('Retry-After가 없거나 0이거나 숫자가 아니면 1초로 본다', async () => {
    const headers: Array<Record<string, string>> = [
      {},
      { 'retry-after': '0' },
      { 'retry-after': 'soon' },
    ];
    const server = await serve((_req, res) =>
      res.writeHead(429, headers.shift()).end('{}'),
    );
    const client = new ExternalApiClient(server.url, 5);

    try {
      for (let i = 0; i < 3; i++) {
        expect(await client.sendMessage(input, 1000)).toEqual({
          kind: 'rate_limited',
          retryAfterSec: 1,
        });
      }
    } finally {
      client.close();
      await server.close();
    }
  });

  it('타임아웃이 나면 요청을 끊어 소켓을 돌려준다', async () => {
    let serverSideClosed = false;
    const server = await serve((req) =>
      req.socket.on('close', () => (serverSideClosed = true)),
    );
    const client = new ExternalApiClient(server.url, 5);

    try {
      await client.sendMessage(input, 100);
      await new Promise((r) => setTimeout(r, 100));
      expect(serverSideClosed).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });

  it('close()는 keepAlive로 남겨 둔 소켓을 닫는다', async () => {
    let closed = 0;
    const server = await serve((req, res) => {
      req.socket.on('close', () => (closed += 1));
      const isLookup = req.method === 'GET';
      if (isLookup) return void res.writeHead(200).end('{"messages":[]}');
      res.writeHead(202).end('{"messageId":"m"}');
    });
    const client = new ExternalApiClient(server.url, 5);

    try {
      // 발송 풀과 조회 풀에 소켓을 하나씩 남긴다.
      await client.sendMessage(input, 1000);
      await client.lookupMessages('a:u_1', 1000);
      await new Promise((r) => setTimeout(r, 50));
      expect(closed).toBe(0);
      client.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(closed).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('조회가 실패하면 오류로 돌려준다', async () => {
    const server = await serve((_req, res) => res.writeHead(500).end('x'));
    const client = new ExternalApiClient(server.url, 5);

    try {
      expect(await client.lookupMessages('a:u_1', 1000)).toMatchObject({
        kind: 'error',
        code: 'HTTP_500',
      });
    } finally {
      client.close();
      await server.close();
    }
  });
});

describe('쓰기 직전 확인 (ADR-0004)', () => {
  const notSent = {
    kind: 'not_sent',
    code: 'SEND_GUARD',
    message: 'Not sent because the pre-write check failed',
  };

  async function withServer(
    run: (client: ExternalApiClient, requests: () => number) => Promise<void>,
  ): Promise<void> {
    let requests = 0;
    const server = await serve((_req, res) => {
      requests += 1;
      res.writeHead(202).end('{"messageId":"m"}');
    });
    const client = new ExternalApiClient(server.url, 5);

    try {
      await run(client, () => requests);
    } finally {
      client.close();
      await server.close();
    }
  }

  it('확인에 실패하면 새 연결에도, 재사용하는 연결에도 쓰지 않는다', () =>
    withServer(async (client, requests) => {
      expect(await client.sendMessage(input, 1000, () => false)).toMatchObject(
        notSent,
      );
      expect(await client.sendMessage(input, 1000, () => true)).toMatchObject({
        kind: 'accepted',
      });
      expect(await client.sendMessage(input, 1000, () => false)).toMatchObject(
        notSent,
      );
      expect(requests()).toBe(1);
    }));

  it('호출할 때가 아니라 연결된 뒤 쓰기 직전에 확인한다', () =>
    withServer(async (client, requests) => {
      // 소켓 배정(nextTick)까지는 허용하고, 연결이 끝나기 전에 막는다. 연결된 뒤에 확인해야 막힌다.
      let allowed = true;
      const pending = client.sendMessage(input, 1000, () => allowed);

      process.nextTick(() => (allowed = false));
      expect(await pending).toMatchObject(notSent);
      expect(requests()).toBe(0);
    }));
});
