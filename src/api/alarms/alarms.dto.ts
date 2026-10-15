import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AlarmStatus, AlarmType, DeliveryStatus } from '../../shared/domain/status';

const NOT_BLANK = /\S/;

/** 알림 생성 요청 (ADR-0021). 모르는 필드는 전역 ValidationPipe가 거절한다. */
export class CreateAlarmRequest {
  @ApiProperty({ enum: Object.values(AlarmType), description: '필수이며 기본값이 없다. 빠뜨리기만 해도 전체 발송이 되는 사고를 막는다.' })
  @IsIn(Object.values(AlarmType))
  type!: AlarmType;

  @ApiProperty({ minLength: 1, maxLength: 100, description: '알림을 구별하는 관리용 이름. 외부로 발송되지 않는다.' })
  @IsString()
  @Length(1, 100)
  @Matches(NOT_BLANK, { message: 'title은 공백만으로 이루어질 수 없다' })
  title!: string;

  @ApiProperty({ minLength: 1, maxLength: 1000, description: '수신자에게 발송되는 본문' })
  @IsString()
  @Length(1, 1000)
  @Matches(NOT_BLANK, { message: 'body는 공백만으로 이루어질 수 없다' })
  body!: string;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    description: 'URGENT 전용이며 필수다. BULK에 지정하면 거절한다.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique({ message: 'recipientIds에 중복이 있다' })
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  recipientIds?: string[];
}

export class ListAlarmsQuery {
  @ApiPropertyOptional({ enum: Object.values(AlarmStatus) })
  @IsOptional()
  @IsIn(Object.values(AlarmStatus))
  status?: AlarmStatus;

  @ApiPropertyOptional({ enum: Object.values(AlarmType) })
  @IsOptional()
  @IsIn(Object.values(AlarmType))
  type?: AlarmType;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: '이전 응답의 nextCursor' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class ListDeliveriesQuery {
  @ApiPropertyOptional({ enum: Object.values(DeliveryStatus) })
  @IsOptional()
  @IsIn(Object.values(DeliveryStatus))
  status?: DeliveryStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: '이전 응답의 nextCursor' })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class AlarmView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: Object.values(AlarmType) }) type!: AlarmType;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty({ enum: Object.values(AlarmStatus) }) status!: AlarmStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) startedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) finishedAt!: string | null;
}

export class DeliveryCounts {
  @ApiProperty() total!: number;
  @ApiProperty() pending!: number;
  @ApiProperty() inFlight!: number;
  @ApiProperty() unconfirmed!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() canceled!: number;
}

export class AlarmDetailView extends AlarmView {
  @ApiPropertyOptional({ type: [String], description: 'URGENT일 때 지정한 수신자' }) recipientIds?: string[];
  @ApiProperty({ type: DeliveryCounts, description: '조회 시점에 Delivery에서 센 값 (ADR-0018)' }) counts!: DeliveryCounts;
}

export class AlarmListView {
  @ApiProperty({ type: [AlarmView] }) items!: AlarmView[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class DeliveryView {
  @ApiProperty() recipientId!: string;
  @ApiProperty({ enum: Object.values(DeliveryStatus) }) status!: DeliveryStatus;
  @ApiProperty() attempts!: number;
  @ApiProperty({ nullable: true, type: String }) messageId!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) sentAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastErrorCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastErrorMessage!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class DeliveryListView {
  @ApiProperty({ type: [DeliveryView] }) items!: DeliveryView[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

class FieldErrorView {
  @ApiProperty() field!: string;
  @ApiProperty() message!: string;
}

/** RFC 9457 Problem Details (ADR-0019). Content-Type은 application/problem+json이다. */
export class ProblemView {
  @ApiProperty({ example: '/problems/invalid-state', description: '에러 종류. 클라이언트는 이 값으로 분기한다' })
  type!: string;
  @ApiProperty({ example: '현재 상태에서 할 수 없는 요청' }) title!: string;
  @ApiProperty({ example: 409 }) status!: number;
  @ApiPropertyOptional() detail?: string;
  @ApiProperty({ example: '/v1/alarms/0193.../send' }) instance!: string;
  @ApiProperty({ description: '같은 값이 서버 로그에 남는다', example: '4bf92f3577b34da6a3ce929d0e0e4736' }) traceId!: string;
  @ApiPropertyOptional({ type: [FieldErrorView], description: '입력 검증 실패(400)일 때 필드별 오류' }) errors?: FieldErrorView[];
  @ApiPropertyOptional({ description: '상태 충돌(409)일 때 현재 상태' }) currentStatus?: string;
}
