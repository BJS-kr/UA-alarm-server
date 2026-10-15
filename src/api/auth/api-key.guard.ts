import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AppConfig } from '../../shared/config/app-config';
import { unauthorized } from '../errors/problem';

/**
 * 업무 API의 최소 인증 (ADR-0033). 운영에서 언제나 적절한 방식이라는 뜻은 아니며,
 * 비공개여야 할 경로를 고려했다는 것을 보여 주는 최소 구현이다.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(config: AppConfig) {
    this.expected = digest(config.API_KEY ?? '');
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    // 길이가 다르면 바로 끝나는 비교는 키 길이를 흘린다. 해시를 비교해 길이를 고정한다.
    if (!match || !timingSafeEqual(digest(match[1]), this.expected)) throw unauthorized();
    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
