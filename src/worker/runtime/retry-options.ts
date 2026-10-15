import { AppConfig } from '../../shared/config/app-config';
import { RetryOptions } from '../../shared/domain/send-outcome';

export function retryOptions(config: AppConfig): RetryOptions {
  return {
    baseMs: config.RETRY_BASE_MS,
    maxMs: config.RETRY_MAX_MS,
    jitterRatio: config.RETRY_JITTER_RATIO,
    maxAttempts: config.RETRY_MAX_ATTEMPTS,
  };
}
