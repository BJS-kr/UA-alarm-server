import { Client } from 'pg';

/**
 * 워커의 잠금 연결 (ADR-0004). 커넥션 풀을 거치지 않는 전용 pg 연결 하나로 자기 ID의 advisory lock을 쥐고 생존 신호를 보낸다.
 * session-level 잠금이라 PgBouncer transaction pooling 같은 중계를 거치면 안 된다.
 * 연결이 끊기면(프로세스 밖에서 무효 선언, DB 재시작, 네트워크 단절) onLost를 부른다.
 */
export class LockConnection {
  private readonly client: Client;

  /**
   * queryTimeoutMs: 생존 신호가 응답 없이 걸려 있으면 그 시간 뒤 실패로 본다.
   * DB와 네트워크만 갈라진 워커가 멈춘 채 살아 있는 것처럼 남지 않게 한다.
   */
  constructor(
    connectionString: string,
    applicationName: string,
    queryTimeoutMs: number,
    onLost: (reason: string) => void,
  ) {
    this.client = new Client({
      connectionString,
      application_name: applicationName,
      query_timeout: queryTimeoutMs,
    });
    this.client.on('error', (error) =>
      onLost(`lock connection error: ${error.message}`),
    );
    this.client.on('end', () => onLost('lock connection ended'));
  }

  /** 연결하고 잠금을 잡는다. 이미 다른 세션이 쥐고 있으면 false. */
  async open(workerId: number): Promise<boolean> {
    await this.client.connect();
    const result = await this.client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [workerId],
    );

    return result.rows[0]?.locked === true;
  }

  /** 생존 신호. DB가 연결별 마지막 활동 시각을 pg_stat_activity에 남긴다. */
  async ping(): Promise<void> {
    await this.client.query('SELECT 1');
  }

  /** 연결을 닫으면 advisory lock도 함께 풀린다. */
  async close(): Promise<void> {
    await this.client.end();
  }
}
