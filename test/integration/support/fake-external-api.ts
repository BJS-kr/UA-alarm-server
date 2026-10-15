import * as http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * mock과 같은 계약(사용자 조회, 발송, 발송 내역 조회)을 따르는 테스트용 가짜 서버 (ADR-0035).
 * 실제 mock은 오류가 무작위라 특정 상황을 골라 만들 수 없으므로, 수신자·시도별로 동작을 미리 정한다.
 * 받은 요청을 모두 기록해 "수신자마다 정확히 한 번"을 그대로 확인한다.
 */
export type SendBehavior =
  | { type: 'accept'; delayMs?: number }
  | { type: 'reject'; code?: string }
  | { type: 'error'; status: 500 | 503 }
  | { type: 'rate_limit'; retryAfterSec?: number }
  /** 접수(기록)는 하고 응답을 늦게 준다. mock의 30초 지연 응답과 같다. */
  | { type: 'record_then_hang'; hangMs: number };

export interface ReceivedSend {
  at: number;
  alarmId: string;
  recipientId: string;
  clientRef: string;
}

interface StoredMessage {
  messageId: string;
  recipientId: string;
  sentAt: string;
}

export class FakeExternalApi {
  readonly received: ReceivedSend[] = [];
  private readonly messages = new Map<string, StoredMessage[]>();
  private readonly attemptsByRef = new Map<string, number>();
  private server?: http.Server;
  private messageSeq = 0;
  private bucket?: { capacity: number; ratePerSec: number; tokens: number; at: number };
  rateLimited = 0;

  /** 수신자와 그 clientRef로 받은 몇 번째 요청인지로 동작을 정한다. 기본은 접수. */
  behavior: (recipientId: string, attempt: number) => SendBehavior = () => ({ type: 'accept' });
  lookupFails = false;
  usersFail = false;

  constructor(public users: string[] = []) {}

  /** mock과 같은 토큰 버킷 처리량 제한을 켠다(거절된 요청은 토큰을 쓰지 않는다). */
  enableRateLimit(ratePerSec: number, capacity: number): void {
    this.bucket = { capacity, ratePerSec, tokens: capacity, at: Date.now() };
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  recordsFor(clientRef: string): number {
    return this.messages.get(clientRef)?.length ?? 0;
  }

  /** 외부 서비스에 이미 발송 기록이 있는 상태를 만든다(워커가 보낸 직후 죽은 경우). */
  preRecord(clientRef: string, recipientId: string): void {
    this.store(clientRef, recipientId);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (req.method === 'GET' && url.pathname === '/v1/users') return this.listUsers(url, res);
    if (req.method === 'GET' && url.pathname === '/v1/messages') return this.lookup(url, res);
    if (req.method === 'POST' && url.pathname === '/v1/messages') return this.send(req, res);
    res.writeHead(404).end();
  }

  private listUsers(url: URL, res: http.ServerResponse): void {
    if (this.usersFail) return void res.writeHead(500).end('{"code":"INTERNAL_ERROR"}');
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const cursor = url.searchParams.get('cursor');
    const offset = cursor ? Number(Buffer.from(cursor, 'base64url').toString()) : 0;
    const page = this.users.slice(offset, offset + limit).map((id) => ({ id }));
    const next = offset + limit < this.users.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ users: page, nextCursor: next }));
  }

  private lookup(url: URL, res: http.ServerResponse): void {
    if (this.lookupFails) return void res.writeHead(503).end('{"code":"SERVICE_UNAVAILABLE"}');
    const clientRef = url.searchParams.get('clientRef') ?? '';
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messages: this.messages.get(clientRef) ?? [] }));
  }

  private async send(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { alarmId: string; recipientId: string; clientRef: string };

    if (this.bucket && !this.takeToken()) {
      this.rateLimited += 1;
      return void res.writeHead(429, { 'retry-after': '1' }).end('{"code":"RATE_LIMITED"}');
    }
    this.received.push({ at: Date.now(), alarmId: body.alarmId, recipientId: body.recipientId, clientRef: body.clientRef });
    const attempt = (this.attemptsByRef.get(body.clientRef) ?? 0) + 1;
    this.attemptsByRef.set(body.clientRef, attempt);
    const behavior = this.behavior(body.recipientId, attempt);

    switch (behavior.type) {
      case 'accept': {
        const message = this.store(body.clientRef, body.recipientId);
        if (behavior.delayMs) await sleep(behavior.delayMs);
        return void res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ messageId: message.messageId }));
      }
      case 'reject':
        return void res.writeHead(400).end(JSON.stringify({ code: behavior.code ?? 'RECIPIENT_BLOCKED', message: 'opted out' }));
      case 'error':
        return void res.writeHead(behavior.status).end(JSON.stringify({ code: behavior.status === 500 ? 'INTERNAL_ERROR' : 'SERVICE_UNAVAILABLE' }));
      case 'rate_limit':
        return void res.writeHead(429, { 'retry-after': String(behavior.retryAfterSec ?? 1) }).end('{"code":"RATE_LIMITED"}');
      case 'record_then_hang': {
        const message = this.store(body.clientRef, body.recipientId);
        await sleep(behavior.hangMs);
        if (!res.destroyed) res.writeHead(202).end(JSON.stringify({ messageId: message.messageId }));
        return;
      }
    }
  }

  private store(clientRef: string, recipientId: string): StoredMessage {
    const message = { messageId: `m_${++this.messageSeq}`, recipientId, sentAt: new Date().toISOString() };
    this.messages.set(clientRef, [...(this.messages.get(clientRef) ?? []), message]);
    return message;
  }

  private takeToken(): boolean {
    const bucket = this.bucket!;
    const now = Date.now();
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + ((now - bucket.at) / 1000) * bucket.ratePerSec);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

/** 늦춘 응답의 타이머가 테스트 종료를 붙잡지 않게 unref한다. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
