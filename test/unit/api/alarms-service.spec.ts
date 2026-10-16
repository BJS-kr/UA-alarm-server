import {
  AlarmRow,
  AlarmsRepository,
} from '../../../src/api/alarms/alarms.repository';
import { AlarmsService } from '../../../src/api/alarms/alarms.service';
import { ProblemException } from '../../../src/api/errors/problem';
import { AlarmStatus, AlarmType } from '../../../src/shared/domain/status';

function alarm(status: AlarmStatus): AlarmRow {
  return {
    id: '01900000-0000-7000-8000-000000000000',
    type: AlarmType.BULK,
    title: 't',
    body: 'b',
    status,
    startSeq: 1,
    expansionCursor: null,
    expansionDone: false,
    expansionOwner: null,
    expansionLeaseUntil: null,
    cleanupDone: false,
    cleanupOwner: null,
    cleanupLeaseUntil: null,
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
}

/** 저장소를 대신해, 전이 직후 다른 요청이 상태를 바꾼 상황을 정해서 만든다. */
function serviceWith(repository: Partial<AlarmsRepository>): AlarmsService {
  return new AlarmsService(repository as AlarmsRepository);
}

describe('발송 시작·취소 응답 (ADR-0016, 0020)', () => {
  it('이 요청이 발송을 시작했으면, 그 직후 취소가 들어와도 202로 답한다', async () => {
    // 전이 뒤 다시 읽으면 CANCELING이 보이는 경합을 그대로 만든다.
    const service = serviceWith({
      startSending: async () => alarm(AlarmStatus.SENDING),
      findById: async () => alarm(AlarmStatus.CANCELING),
    });
    const result = await service.send('id');

    expect(result.httpStatus).toBe(202);
    expect(result.view.status).toBe(AlarmStatus.SENDING);
  });

  it('전이하지 못했으면 다시 읽은 상태로 답한다: 취소 중이면 409', async () => {
    const service = serviceWith({
      startSending: async () => undefined,
      findById: async () => alarm(AlarmStatus.CANCELING),
    });

    await expect(service.send('id')).rejects.toBeInstanceOf(ProblemException);
  });

  it('이 요청이 취소를 시작했으면, 그 직후 정리가 끝나도 202로 답한다', async () => {
    const service = serviceWith({
      cancel: async () => alarm(AlarmStatus.CANCELING),
      findById: async () => alarm(AlarmStatus.CANCELED),
    });

    expect((await service.cancel('id')).httpStatus).toBe(202);
  });

  it('없는 알림은 404', async () => {
    const service = serviceWith({
      startSending: async () => undefined,
      findById: async () => undefined,
    });

    await expect(service.send('id')).rejects.toMatchObject({
      problem: { type: '/problems/not-found' },
    });
  });
});
