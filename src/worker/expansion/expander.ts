import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import { Db } from '../../shared/db/database';
import { retryDelayMs } from '../../shared/domain/retry-policy';
import { AlarmStatus } from '../../shared/domain/status';
import {
  ExternalApiClient,
  UsersPageResult,
} from '../../shared/external/external-api.client';
import { withLogContext } from '../../shared/logging/log-context';
import { withAlarmLock } from '../completion/alarm-lock.repository';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { durable, sleep } from '../runtime/loop-utils';
import { PollingLoop, Tick } from '../runtime/polling-loop';
import { ExpansionRepository, ExpansionTask } from './expansion.repository';

type PageStep = 'continue' | 'done' | 'stop';
type UsersPage = Extract<UsersPageResult, { kind: 'ok' }>;

/**
 * 수신자 펼치기 (ADR-0006). 알림 하나의 펼치기는 한 번에 한 워커만 쥔다.
 * 페이지마다 "Delivery 삽입 + 다음 커서 저장"을 한 트랜잭션으로 커밋하므로, 죽으면 넘겨받은 워커가 저장된 커서부터 잇는다.
 * 커밋된 Delivery는 즉시 발송 대상이 된다. 발송 모듈과는 DB 테이블로만 이어진다.
 */
export class Expander {
  private readonly loop: PollingLoop;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly repository: ExpansionRepository,
    private readonly workerId: number,
    private readonly client: ExternalApiClient,
    private readonly metrics: WorkerMetrics,
    private readonly logger: LoggerService,
    private readonly onFatal: (reason: string, error?: unknown) => never,
  ) {
    this.loop = new PollingLoop(
      {
        name: 'expansion',
        idleMs: config.IDLE_POLL_MS,
        logger,
        onError: (loop) => metrics.loopErrors.inc({ loop }),
      },
      () => this.tick(),
    );
  }

  start(): void {
    this.loop.start();
  }

  /** 진행 중이면 현재 페이지를 커밋하고 멈춘다 (ADR-0007). */
  stop(): Promise<void> {
    return this.loop.stop();
  }

  private async tick(): Promise<Tick> {
    const task = await this.repository.claim();
    const isIdle = task === undefined;
    if (isIdle) return 'idle';
    await withLogContext({ alarmId: task.alarmId }, () => this.expand(task));

    return 'busy';
  }

  private async expand(task: ExpansionTask): Promise<void> {
    let cursor = task.cursor;
    let failures = 0;

    this.logger.log('Expansion started', { fromCursor: cursor });

    while (!this.loop.isStopping) {
      const page = await this.client.listUsers(
        cursor,
        this.config.USERS_PAGE_SIZE,
        this.config.USERS_TIMEOUT_MS,
      );
      const isFetchFailed = page.kind === 'error';
      if (isFetchFailed) {
        failures += 1;
        const delayMs = retryDelayMs(failures, {
          baseMs: this.config.RETRY_BASE_MS,
          maxMs: this.config.RETRY_MAX_MS,
          jitterRatio: this.config.RETRY_JITTER_RATIO,
        });

        this.logger.warn('Fetching users failed, retrying', {
          code: page.code,
          delayMs,
        });
        await sleep(delayMs);
        continue;
      }

      failures = 0;
      const step = await this.savePage(task, cursor, page);
      const isFinished = step !== 'continue';
      if (isFinished) return;
      cursor = page.nextCursor;
    }
  }

  private async savePage(
    task: ExpansionTask,
    pageCursor: string | null,
    page: UsersPage,
  ): Promise<PageStep> {
    const { result: step, finished } = await durable(
      () =>
        withAlarmLock(
          this.db,
          task.alarmId,
          async (tx, alarm): Promise<PageStep> => {
            const isSending = alarm.status === AlarmStatus.SENDING;
            const isMine = alarm.expansionOwner === this.workerId;
            const isExpectedPage = alarm.expansionCursor === pageCursor;
            // 취소됐거나, 넘겨받혔거나, 이 페이지가 이미 들어갔으면 멈춘다.
            const isMyNextPage = isSending && isMine && isExpectedPage;
            if (!isMyNextPage) return 'stop';
            await this.repository.savePage(
              tx,
              task,
              page.users.map((user) => user.id),
              page.nextCursor,
            );

            return page.nextCursor === null ? 'done' : 'continue';
          },
        ),
      (error) => this.onFatal('Could not record an expansion page', error),
    );
    const isSaved = step !== 'stop';
    if (isSaved) this.metrics.expansionPages.inc();
    const isDone = step === 'done';
    if (isDone) this.logger.log('Expansion finished', { finished });

    return step;
  }
}
