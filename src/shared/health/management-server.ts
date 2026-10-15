import * as http from 'node:http';
import { Registry } from 'prom-client';

export interface ManagementHandlers {
  live: () => boolean | Promise<boolean>;
  ready: () => boolean | Promise<boolean>;
  registry: Registry;
}

/**
 * 외부에 공개하지 않는 관리 포트. 헬스체크와 메트릭만 둔다 (ADR-0026, 0027, 0033).
 * 업무 API와 포트를 나눠 인증 규칙을 단순하게 한다.
 */
export class ManagementServer {
  private server?: http.Server;

  constructor(
    private readonly port: number,
    private readonly handlers: ManagementHandlers,
  ) {}

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => {
      void this.route(req.url ?? '/', res);
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, resolve));
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : this.port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async route(url: string, res: http.ServerResponse): Promise<void> {
    try {
      if (url === '/health/live') return this.health(res, await this.handlers.live());
      if (url === '/health/ready') return this.health(res, await this.handlers.ready());
      if (url === '/metrics') {
        res.writeHead(200, { 'content-type': this.handlers.registry.contentType });
        res.end(await this.handlers.registry.metrics());
        return;
      }
      res.writeHead(404).end();
    } catch {
      this.health(res, false);
    }
  }

  private health(res: http.ServerResponse, ok: boolean): void {
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'unavailable' }));
  }
}
