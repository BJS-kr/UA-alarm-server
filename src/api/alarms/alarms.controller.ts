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
const UUID_PROBLEM = { ...PROBLEM, description: 'ID가 UUID가 아님' };

@ApiTags('alarms')
@ApiExtraModels(ProblemView)
@ApiBearerAuth()
@ApiUnauthorizedResponse(PROBLEM)
@ApiServiceUnavailableResponse({
  ...PROBLEM,
  description:
    'DB에 연결할 수 없거나 정해 둔 시간 안에 답이 없음. 잠시 뒤 다시 시도한다 (ADR-0039)',
})
@ApiInternalServerErrorResponse({
  ...PROBLEM,
  description: '예상하지 못한 오류. 내부 정보 없이 traceId만 준다 (ADR-0019)',
})
@Controller('v1/alarms')
export class AlarmsController {
  constructor(private readonly alarms: AlarmsService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: '알림 생성',
    description: '생성만으로는 발송되지 않는다. 발송은 /send로 시작한다.',
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
    summary: '알림 목록',
    description:
      '최신순, 커서 페이지네이션 (ADR-0024). 건수는 단건 조회에서 본다.',
  })
  @ApiOkResponse({ type: AlarmListView })
  @ApiBadRequestResponse(PROBLEM)
  list(@Query() query: ListAlarmsQuery): Promise<AlarmListView> {
    return this.alarms.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '알림 단건',
    description: '상태별 Delivery 건수를 조회 시점에 세어 함께 준다.',
  })
  @ApiOkResponse({ type: AlarmDetailView })
  @ApiBadRequestResponse(UUID_PROBLEM)
  @ApiNotFoundResponse(PROBLEM)
  get(@Param('id', uuidParam) id: string): Promise<AlarmDetailView> {
    return this.alarms.get(id);
  }

  @Post(':id/send')
  @ApiOperation({
    summary: '발송 시작',
    description:
      'CREATED → SENDING. 이미 SENDING이면 202, COMPLETED면 200, 취소된 알림이면 409 (ADR-0016, 0020).',
  })
  @ApiAcceptedResponse({ type: AlarmView, description: '발송이 진행 중' })
  @ApiOkResponse({ type: AlarmView, description: '이미 완료됨' })
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
    summary: '발송 취소',
    description:
      'CREATED → CANCELED(200), SENDING → CANCELING(202). 완료된 알림은 409. 이미 나간 건은 되돌리지 않는다 (ADR-0017).',
  })
  @ApiAcceptedResponse({
    type: AlarmView,
    description: '이미 나가던 건을 정리하는 중',
  })
  @ApiOkResponse({ type: AlarmView, description: '취소가 끝남' })
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
    summary: '수신자별 결과',
    description: '수신자 ID 순, 커서 페이지네이션. 상태로 거를 수 있다.',
  })
  @ApiOkResponse({ type: DeliveryListView })
  @ApiBadRequestResponse({
    ...PROBLEM,
    description: 'ID가 UUID가 아니거나 커서·쿼리가 틀림',
  })
  @ApiNotFoundResponse(PROBLEM)
  deliveries(
    @Param('id', uuidParam) id: string,
    @Query() query: ListDeliveriesQuery,
  ): Promise<DeliveryListView> {
    return this.alarms.deliveries(id, query);
  }
}
