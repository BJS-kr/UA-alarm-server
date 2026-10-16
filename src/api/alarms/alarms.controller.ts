import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiExtraModels,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { badRequest } from '../errors/problem';
import {
  AlarmDetailView,
  AlarmListView,
  AlarmView,
  CreateAlarmRequest,
  DeliveryListView,
  ListAlarmsQuery,
  ListDeliveriesQuery,
  ProblemView,
} from './alarms.dto';
import { AlarmsService } from './alarms.service';

const uuidParam = new ParseUUIDPipe({
  exceptionFactory: () => badRequest('id must be a UUID'),
});
const PROBLEM = {
  description: 'Problem Details (RFC 9457, ADR-0019)',
  content: {
    'application/problem+json': {
      schema: { $ref: getSchemaPath(ProblemView) },
    },
  },
};
const UUID_PROBLEM = { ...PROBLEM, description: '유효하지 않은 UUID 형식' };

@ApiTags('alarms')
@ApiExtraModels(ProblemView)
@ApiBearerAuth()
@ApiUnauthorizedResponse(PROBLEM)
@ApiServiceUnavailableResponse({
  ...PROBLEM,
  description: 'DB 연결 실패 또는 쿼리 타임아웃 (ADR-0039)',
})
@ApiInternalServerErrorResponse({
  ...PROBLEM,
  description:
    '예기치 않은 서버 내부 오류 (내부 정보 노출 없이 traceId만 반환, ADR-0019)',
})
@Controller('v1/alarms')
export class AlarmsController {
  constructor(private readonly alarms: AlarmsService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: '알림 생성',
    description:
      'CREATED 상태의 알림을 생성한다. 실제 발송은 POST /v1/alarms/:id/send 호출 시 시작된다.',
  })
  @ApiCreatedResponse({ type: AlarmView })
  @ApiBadRequestResponse(PROBLEM)
  @ApiPayloadTooLargeResponse(PROBLEM)
  async create(
    @Body() body: CreateAlarmRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AlarmView> {
    const view = await this.alarms.create(body);

    res.location(`/v1/alarms/${view.id}`);

    return view;
  }

  @Get()
  @ApiOperation({
    summary: '알림 목록 조회',
    description:
      '최신순(UUIDv7 내림차순) 커서 페이지네이션으로 알림 목록을 조회한다 (ADR-0024). 상태별 Delivery 집계는 단건 조회에서 반환한다.',
  })
  @ApiOkResponse({ type: AlarmListView })
  @ApiBadRequestResponse(PROBLEM)
  list(@Query() query: ListAlarmsQuery): Promise<AlarmListView> {
    return this.alarms.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '알림 단건 조회',
    description: '알림 상세 정보와 상태별 Delivery 집계 건수를 반환한다.',
  })
  @ApiOkResponse({ type: AlarmDetailView })
  @ApiBadRequestResponse(UUID_PROBLEM)
  @ApiNotFoundResponse(PROBLEM)
  get(@Param('id', uuidParam) id: string): Promise<AlarmDetailView> {
    return this.alarms.get(id);
  }

  @Post(':id/send')
  @ApiOperation({
    summary: '알림 발송 시작',
    description:
      'CREATED → SENDING 전이. 이미 SENDING/CANCELING이면 202, COMPLETED면 200, CANCELED면 409를 반환한다 (ADR-0016, ADR-0020).',
  })
  @ApiAcceptedResponse({
    type: AlarmView,
    description: '발송 시작 또는 진행 중',
  })
  @ApiOkResponse({ type: AlarmView, description: '이미 발송 완료된 알림' })
  @ApiBadRequestResponse(UUID_PROBLEM)
  @ApiNotFoundResponse(PROBLEM)
  @ApiConflictResponse(PROBLEM)
  async send(
    @Param('id', uuidParam) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AlarmView> {
    const { httpStatus, view } = await this.alarms.send(id);

    res.status(httpStatus);

    return view;
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: '알림 발송 취소',
    description:
      'CREATED → CANCELED(200), SENDING → CANCELING(202) 전이. 이미 완료된 알림(COMPLETED)은 409를 반환하며 기발송 건은 취소되지 않는다 (ADR-0017).',
  })
  @ApiAcceptedResponse({
    type: AlarmView,
    description: '발송 진행 중인 건의 정리 후 취소 진행 중 (CANCELING)',
  })
  @ApiOkResponse({ type: AlarmView, description: '취소 완료 (CANCELED)' })
  @ApiBadRequestResponse(UUID_PROBLEM)
  @ApiNotFoundResponse(PROBLEM)
  @ApiConflictResponse(PROBLEM)
  async cancel(
    @Param('id', uuidParam) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AlarmView> {
    const { httpStatus, view } = await this.alarms.cancel(id);

    res.status(httpStatus);

    return view;
  }

  @Get(':id/deliveries')
  @ApiOperation({
    summary: '수신자별 발송 내역 조회',
    description:
      '수신자 ID 오름차순 커서 페이지네이션으로 발송 내역을 조회한다. status 필터를 지원한다.',
  })
  @ApiOkResponse({ type: DeliveryListView })
  @ApiBadRequestResponse({
    ...PROBLEM,
    description: '유효하지 않은 UUID 형식 또는 잘못된 쿼리/커서 파라미터',
  })
  @ApiNotFoundResponse(PROBLEM)
  deliveries(
    @Param('id', uuidParam) id: string,
    @Query() query: ListDeliveriesQuery,
  ): Promise<DeliveryListView> {
    return this.alarms.deliveries(id, query);
  }
}
