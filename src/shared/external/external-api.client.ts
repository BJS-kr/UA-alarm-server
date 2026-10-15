import * as http from 'node:http';
import { LookupResult, SendResult } from '../domain/send-outcome';

type RawOutcome =
  | { kind: 'response'; status: number; headers: http.IncomingHttpHeaders; body: string }
  | { kind: 'error'; flushed: boolean; code: string; message: string };

export interface ExternalUser {
  id: string;
}

export type UsersPageResult =
  | { kind: 'ok'; users: ExternalUser[]; nextCursor: string | null }
  | { kind: 'error'; code: string; message: string };

export interface SendMessageInput {
  alarmId: string;
  recipientId: string;
  body: string;
  clientRef: string;
}

/**
 * 외부 발송 API 클라이언트. Node 기본 `node:http`만 쓴다 (ADR-0037).
 * keepAlive 소켓 수를 동시 발송 한도와 같게 두어, 토큰을 받은 요청이 소켓을 기다리며 쌓였다가
 * 한꺼번에 나가지 않게 한다 (ADR-0013).
 */
export class ExternalApiClient {
  private readonly agent: http.Agent;

  constructor(
    private readonly baseUrl: string,
    maxSockets: number,
  ) {
    this.agent = new http.Agent({ keepAlive: true, maxSockets });
  }

  /**
   * canWrite는 요청 바이트를 소켓에 쓰기 직전에 부른다. false면 보내지 않고 not_sent로 끝낸다.
   * 워커는 여기에 발송 직전 확인을 넘긴다 (ADR-0004).
   */
  async sendMessage(input: SendMessageInput, timeoutMs: number, canWrite?: () => boolean): Promise<SendResult> {
    const outcome = await this.request('POST', '/v1/messages', input, timeoutMs, canWrite);
    if (outcome.kind === 'error') {
      // 요청 바이트를 커널에 다 넘기기 전에 실패했으면(연결 거부, 연결 단계 시간 초과 등) 서버는 완전한 요청을
      // 받지 못했으므로 처리할 수 없다. 다 넘긴 뒤의 실패는 보냈는지 모른다 (ADR-0037).
      return outcome.flushed
        ? { kind: 'unknown', code: outcome.code, message: outcome.message }
        : { kind: 'not_sent', code: outcome.code, message: outcome.message };
    }
    const { status, body } = outcome;
    const parsed = safeJson(body);
    const code = typeof parsed?.code === 'string' ? parsed.code : `HTTP_${status}`;
    const message = typeof parsed?.message === 'string' ? parsed.message : body.slice(0, 200);
    if (status >= 200 && status < 300) {
      if (typeof parsed?.messageId === 'string') return { kind: 'accepted', messageId: parsed.messageId };
      // 접수는 됐는데 응답을 해석하지 못했다. 결과 확인으로 messageId를 얻는다.
      return { kind: 'unknown', code: 'UNPARSABLE_ACCEPT', message: body.slice(0, 200) };
    }
    if (status === 400) return { kind: 'rejected', status, code, message };
    if (status === 429) return { kind: 'rate_limited', retryAfterSec: parseRetryAfter(outcome.headers['retry-after']) };
    // 계약상 500·503은 발송되지 않았다. 앞단 게이트웨이의 502·504는 전달 여부를 알 수 없다.
    if (status === 502 || status === 504) return { kind: 'unknown', code, message };
    return { kind: 'server_error', status, code, message };
  }

  async lookupMessages(clientRef: string, timeoutMs: number): Promise<LookupResult> {
    const outcome = await this.request('GET', `/v1/messages?clientRef=${encodeURIComponent(clientRef)}`, undefined, timeoutMs);
    if (outcome.kind === 'error') return { kind: 'error', code: outcome.code, message: outcome.message };
    const parsed = safeJson(outcome.body);
    if (outcome.status === 200 && Array.isArray(parsed?.messages)) {
      return { kind: 'ok', messages: parsed.messages };
    }
    return { kind: 'error', code: `HTTP_${outcome.status}`, message: outcome.body.slice(0, 200) };
  }

  async listUsers(cursor: string | null, limit: number, timeoutMs: number): Promise<UsersPageResult> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const outcome = await this.request('GET', `/v1/users?${query.toString()}`, undefined, timeoutMs);
    if (outcome.kind === 'error') return { kind: 'error', code: outcome.code, message: outcome.message };
    const parsed = safeJson(outcome.body);
    if (outcome.status === 200 && Array.isArray(parsed?.users)) {
      return { kind: 'ok', users: parsed.users, nextCursor: parsed.nextCursor ?? null };
    }
    return { kind: 'error', code: `HTTP_${outcome.status}`, message: outcome.body.slice(0, 200) };
  }

  close(): void {
    this.agent.destroy();
  }

  private request(method: string, path: string, body: unknown, timeoutMs: number, canWrite?: () => boolean): Promise<RawOutcome> {
    return new Promise((resolve) => {
      let flushed = false;
      let settled = false;
      const finish = (outcome: RawOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        new URL(path, this.baseUrl),
        {
          method,
          agent: this.agent,
          headers: payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            finish({ kind: 'response', status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', (err: NodeJS.ErrnoException) =>
            finish({ kind: 'error', flushed: true, code: err.code ?? 'RESPONSE_ERROR', message: err.message }),
          );
        },
      );
      const timer = setTimeout(() => {
        finish({ kind: 'error', flushed, code: 'CLIENT_TIMEOUT', message: `${timeoutMs}ms 안에 응답이 없다` });
        req.destroy();
      }, timeoutMs);
      req.on('error', (err: NodeJS.ErrnoException) =>
        finish({ kind: 'error', flushed, code: err.code ?? 'REQUEST_ERROR', message: err.message }),
      );
      const send = () => {
        if (canWrite && !canWrite()) {
          req.destroy(Object.assign(new Error('쓰기 직전 확인에 실패해 보내지 않았다'), { code: 'SEND_GUARD' }));
          return;
        }
        // 'finish'는 요청 바이트가 소켓에 넘어간 뒤에 온다. 이후의 실패는 "보냈는지 모르는" 실패다.
        req.end(payload, () => {
          flushed = true;
        });
      };
      // 소켓을 배정받고 연결된 뒤에 쓴다. 호출과 쓰기 사이의 비동기 틈(소켓 배정, 연결)에서 멈췄다 깨어난 워커가
      // 그 사이 넘겨받힌 건을 보내지 않도록, 확인을 쓰기 바로 앞에 둔다 (ADR-0004).
      req.once('socket', (socket) => (socket.connecting ? socket.once('connect', send) : send()));
    });
  }
}

/** JSON이 아니면 undefined. 원시값이 와도 호출하는 쪽이 ?.로 읽으므로 그대로 둔다. */
function safeJson(text: string): Record<string, any> | undefined {
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return undefined;
  }
}

function parseRetryAfter(header: string | string[] | undefined): number {
  const value = Number(Array.isArray(header) ? header[0] : header);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
