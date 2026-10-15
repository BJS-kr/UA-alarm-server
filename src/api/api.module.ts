import {
  DynamicModule,
  Inject,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Pool } from 'pg';
import { AppConfig } from '../shared/config/app-config';
import { createDb, DB, PG_POOL } from '../shared/db/database';
import { AlarmsController } from './alarms/alarms.controller';
import { AlarmsRepository } from './alarms/alarms.repository';
import { AlarmsService } from './alarms/alarms.service';
import { ApiKeyGuard } from './auth/api-key.guard';
import { ProblemDetailsFilter } from './errors/problem-details.filter';
import { createValidationPipe } from './http/validation';

class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Module({})
export class ApiModule {
  /** 설정은 main에서 한 번 검증한 값을 @nestjs/config에 올려 주입한다 (ADR-0030). */
  static forRoot(config: AppConfig, pool: Pool): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ app: config })],
        }),
      ],
      controllers: [AlarmsController],
      providers: [
        {
          provide: AppConfig,
          inject: [ConfigService],
          useFactory: (cs: ConfigService) => cs.getOrThrow<AppConfig>('app'),
        },
        { provide: PG_POOL, useValue: pool },
        {
          provide: DB,
          inject: [PG_POOL],
          useFactory: (p: Pool) => createDb(p),
        },
        AlarmsRepository,
        AlarmsService,
        PoolCloser,
        { provide: APP_GUARD, useClass: ApiKeyGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: APP_PIPE, useFactory: createValidationPipe },
      ],
    };
  }
}
