import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import { Db } from '../../shared/db/database';
import { isPermanentFetchFailure } from '../../shared/domain/fetch-failure';
import { retryDelayMs } from '../../shared/domain/retry-policy';
import { AlarmStatus } from '../../shared/domain/status';
import {
  ExternalApiClient,
  UsersPageResult,
} from '../../shared/external/external-api.client';
import { withLogContext } from '../../shared/logging/log-context';
import { withAlarmLock } from '../completion/alarm-lock.repository';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { durable } from '../runtime/loop-utils';
import { PollingLoop, Tick } from '../runtime/polling-loop';
import { ExpansionRepository, ExpansionTask } from './expansion.repository';

type PageStep = 'continue' | 'done' | 'stop';
type UsersPage = Extract<UsersPageResult, { kind: 'ok' }>;

/**
 * 대량 알림 수신자 확장(Expansion, ADR-0006). 단일 알림의 수신자 확장은 한 번에 하나의 워커만 점유한다.
 * 페이지마다 "Delivery 일괄 삽입 + 다음 커서 갱신"을 단일 트랜잭션으로 커밋하여, 워커 중단 시 인계받은 워커가 저장된 커서부터 재개한다.
 * 커밋된 Delivery는 즉시 발송 대상이 된다.
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

  /** 진행 중인 페이지 커밋을 마치고 종료한다 (ADR-0007). */
  stop(): Promise<void> {
    return this.loop.stop();
  }

  private async tick(): Promise<Tick> {
    const task = await this.repository.claim(this.config.TASK_LEASE_MS);
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
      // 외부 사용자 API 호출 직전마다 리스를 갱신한다. 취소되었거나 다른 워커에 인계된 경우 갱신이 실패하므로 즉시 중단한다 (ADR-0004, 0017).
      const isStillMine = await this.repository.renew(
        task,
        this.config.TASK_LEASE_MS,
      );
      if (!isStillMine) {
        this.logger.log(
          'Expansion stopped because the alarm was canceled or taken over',
        );

        return;
      }

      const page = await this.client.listUsers(
        cursor,
        this.config.USERS_PAGE_SIZE,
        this.config.USERS_TIMEOUT_MS,
      );
      const isFetchFailed = page.kind === 'error';
      if (isFetchFailed) {
        const isPermanent = isPermanentFetchFailure(page.status);

        this.metrics.expansionFetchFailures.inc({
          kind: isPermanent ? 'permanent' : 'transient',
        });
        // 비재시도성 영구 오류 시 무한 재시도하지 않고 알림을 CANCELING(EXPANSION_FAILED)으로 전이한다 (ADR-0006).
        if (isPermanent) return this.giveUp(task, page);
        failures += 1;
        const delayMs = retryDelayMs(failures, {
          baseMs: this.config.RETRY_BASE_MS,
          maxMs: this.config.RETRY_MAX_MS,
          jitterRatio: this.config.RETRY_JITTER_RATIO,
        });

        // 백오프 지연이 상한에 도달한 경우(외부 사용자 서비스 장기 장애) error 레벨로 로깅한다.
        const isStalled = delayMs >= this.config.RETRY_MAX_MS;
        const log = isStalled ? 'error' : 'warn';

        this.logger[log](
          isStalled
            ? 'Expansion is stalled because fetching users keeps failing'
            : 'Fetching users failed, retrying',
          { code: page.code, delayMs },
        );
        // 백오프 대기 중 리스 만료로 인계되지 않도록 대기 시간만큼 리스를 연장한다.
        const isStillMineWhileWaiting = await this.repository.renew(
          task,
          delayMs + this.config.TASK_LEASE_MS,
        );
        if (!isStillMineWhileWaiting) return;
        await this.loop.pause(delayMs);
        continue;
      }

      failures = 0;
      const step = await this.savePage(task, cursor, page);
      const isFinished = step !== 'continue';
      if (isFinished) return;
      cursor = page.nextCursor;
    }

    // 정상 종료 시 점유를 즉시 해제하여 다른 워커가 리스 만료 대기 없이 이어받도록 한다 (ADR-0007).
    await this.repository.release(task);
  }

  private async giveUp(
    task: ExpansionTask,
    page: { code: string; message: string; status?: number },
  ): Promise<void> {
    const isAbandoned = await this.repository.abandon(task, page);
    if (!isAbandoned) return;
    this.logger.error(
      'Fetching users failed with an error that retrying cannot fix, canceling the alarm',
      { code: page.code, status: page.status },
    );
  }

  private async savePage(
    task: ExpansionTask,
    pageCursor: string | null,
    page: UsersPage,
  ): Promise<PageStep> {
    const { result: step, finished } = await durable(() =>
      withAlarmLock(
        this.db,
        task.alarmId,
        async (tx, alarm): Promise<PageStep> => {
          const isSending = alarm.status === AlarmStatus.SENDING;
          const isMine = alarm.expansionOwner === this.workerId;
          const isExpectedPage = alarm.expansionCursor === pageCursor;
          // 취소되었거나, 다른 워커에 인계되었거나, 이미 반영된 페이지면 중단한다.
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
    );
    const isSaved = step !== 'stop';
    if (isSaved) this.metrics.expansionPages.inc();
    const isDone = step === 'done';
    if (isDone) this.logger.log('Expansion finished', { finished });

    return step;
  }
}
