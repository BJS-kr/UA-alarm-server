import { LoggerService } from '@nestjs/common';
import * as http from 'node:http';
import { Registry } from 'prom-client';

export interface ManagementHandlers {
  live: () => boolean | Promise<boolean>;
  ready: () => boolean | Promise<boolean>;
  registry: Registry;
}

interface Reply {
  status: number;
  contentType: string;
  body: string;
}

/**
 * 외부에 공개하지 않는 관리 포트. 헬스체크와 메트릭만 둔다 (ADR-0026, 0027, 0033).
 * 업무 API와 포트를 나눠 인증 규칙을 단순하게 한다.
 * 어떤 요청이든 응답을 끝까지 만든 뒤 한 번에 보낸다. 만드는 도중 실패하면 503으로 답하고 로그를 남긴다 (ADR-0039).
 */
export class ManagementServer {
  private server?: http.Server;

  constructor(
    private readonly port: number,
    private readonly handlers: ManagementHandlers,
    private readonly logger: LoggerService,
  ) {}

  async start(): Promise<number> {
    this.server = http.createServer(
      (req, res) => void this.respond(req.url ?? '/', res),
    );
    await new Promise<void>((resolve) =>
      this.server!.listen(this.port, resolve),
    );
    const address = this.server.address();
    const isBound = typeof address === 'object' && address !== null;

    return isBound ? address.port : this.port;
  }

  async stop(): Promise<void> {
    const isStarted = this.server !== undefined;
    if (!isStarted) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async respond(url: string, res: http.ServerResponse): Promise<void> {
    const reply = await this.build(url).catch((error: unknown) => {
      this.logger.error('Management endpoint failed', {
        url,
        error: error as Error,
      });

      return health(false);
    });

    res
      .writeHead(reply.status, { 'content-type': reply.contentType })
      .end(reply.body);
  }

  private async build(url: string): Promise<Reply> {
    switch (url) {
      case '/health/live':
        return health(await this.handlers.live());
      case '/health/ready':
        return health(await this.handlers.ready());
      case '/metrics':
        return {
          status: 200,
          contentType: this.handlers.registry.contentType,
          body: await this.handlers.registry.metrics(),
        };
      default:
        return { status: 404, contentType: 'text/plain', body: 'not found' };
    }
  }
}

function health(isOk: boolean): Reply {
  return {
    status: isOk ? 200 : 503,
    contentType: 'application/json',
    body: JSON.stringify({ status: isOk ? 'ok' : 'unavailable' }),
  };
}
