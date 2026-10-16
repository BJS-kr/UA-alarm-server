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
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  AlarmStatus,
  AlarmType,
  CancelReason,
  DeliveryStatus,
} from '../../shared/domain/status';
import { ProblemType } from '../errors/problem';
import { CharLength, NoNulCharacter } from '../http/validation';

const NOT_BLANK = /\S/;

/** 알림 생성 요청 DTO (ADR-0021). 정의되지 않은 필드는 전역 ValidationPipe에서 거부한다. */
export class CreateAlarmRequest {
  @ApiProperty({
    enum: Object.values(AlarmType),
    description: '알림 발송 유형 (URGENT | BULK). 기본값 없이 필수로 지정한다.',
  })
  @IsIn(Object.values(AlarmType))
  type!: AlarmType;

  @ApiProperty({
    minLength: 1,
    maxLength: 100,
    description: '알림 식별용 관리 제목 (외부 발송 본문에 포함되지 않음)',
  })
  @IsString()
  @CharLength(1, 100)
  @NoNulCharacter()
  @Matches(NOT_BLANK, { message: 'title must not be blank' })
  title!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 1000,
    description: '수신자에게 발송되는 알림 본문',
  })
  @IsString()
  @CharLength(1, 1000)
  @NoNulCharacter()
  @Matches(NOT_BLANK, { message: 'body must not be blank' })
  body!: string;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    description:
      'URGENT 알림의 대상 수신자 ID 목록 (BULK 알림에서는 지정 불가)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique({ message: 'recipientIds must not contain duplicates' })
  @IsString({ each: true })
  @CharLength(1, 64, { each: true })
  @NoNulCharacter({ each: true })
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
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  startedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  finishedAt!: string | null;
  @ApiProperty({
    enum: Object.values(CancelReason),
    nullable: true,
    description:
      '취소 사유 (REQUESTED: 사용자 취소 요청, EXPANSION_FAILED: 수신자 목록 조회 영구 오류로 인한 중단)',
  })
  cancelReason!: CancelReason | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: '비정상 중단 시 기록된 마지막 오류 코드',
  })
  lastErrorCode!: string | null;
  @ApiProperty({ nullable: true, type: String })
  lastErrorMessage!: string | null;
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
  @ApiPropertyOptional({
    type: [String],
    description: 'URGENT 알림의 대상 수신자 ID 목록',
  })
  recipientIds?: string[];
  @ApiProperty({
    type: DeliveryCounts,
    description: '조회 시점의 상태별 Delivery 집계 (ADR-0018)',
  })
  counts!: DeliveryCounts;
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
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) sentAt!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) lastErrorCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastErrorMessage!:
    string | null;
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

/** RFC 9457 Problem Details 응답 스키마 (ADR-0019). Content-Type: application/problem+json */
export class ProblemView {
  @ApiProperty({
    example: '/problems/invalid-state',
    enum: Object.values(ProblemType),
    description: '오류 유형 식별자 URI',
  })
  type!: string;
  @ApiProperty({ example: 'Not allowed in the current state' }) title!: string;
  @ApiProperty({ example: 409 }) status!: number;
  @ApiPropertyOptional() detail?: string;
  @ApiProperty({ example: '/v1/alarms/0193.../send' }) instance!: string;
  @ApiProperty({
    description: '요청 추적용 식별자 (서버 로그와 매핑)',
    example: '4bf92f3577b34da6a3ce929d0e0e4736',
  })
  traceId!: string;
  @ApiPropertyOptional({
    type: [FieldErrorView],
    description: '요청 검증 실패(400) 시 필드별 상세 오류 목록',
  })
  errors?: FieldErrorView[];
  @ApiPropertyOptional({
    description: '상태 전이 충돌(409) 시 현재 리소스 상태',
  })
  currentStatus?: string;
}
