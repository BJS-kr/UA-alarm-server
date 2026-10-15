import {
  BeforeApplicationShutdown,
  DynamicModule,
  Injectable,
  LoggerService,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppConfig } from '../shared/config/app-config';
import { WorkerRuntime } from './runtime/worker-runtime';

@Injectable()
class WorkerLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(private readonly runtime: WorkerRuntime) {}

  onApplicationBootstrap(): Promise<void> {
    return this.runtime.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.runtime.stop();
  }
}

@Module({})
export class WorkerModule {
  static forRoot(
    config: AppConfig,
    workerId: number,
    logger: LoggerService,
    onFatal: (reason: string, error?: unknown) => never,
  ): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ app: config })],
        }),
      ],
      providers: [
        {
          provide: AppConfig,
          inject: [ConfigService],
          useFactory: (cs: ConfigService) => cs.getOrThrow<AppConfig>('app'),
        },
        {
          provide: WorkerRuntime,
          inject: [AppConfig],
          useFactory: (appConfig: AppConfig) =>
            new WorkerRuntime({ config: appConfig, workerId, logger, onFatal }),
        },
        WorkerLifecycle,
      ],
    };
  }
}
