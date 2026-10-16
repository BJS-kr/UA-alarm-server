import type { OpenAPIObject } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { methodNotAllowed, unsupportedMediaType } from '../errors/problem';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

/**
 * 경로는 있는데 메서드가 틀린 요청은 "없는 경로(404)"가 아니라 405와 Allow 헤더로 답한다 (ADR-0020).
 * 허용 메서드는 OpenAPI 문서에서 읽는다. 문서가 곧 계약이라, 경로를 더해도 따로 고칠 곳이 없다.
 */
export function methodNotAllowedMiddleware(document: OpenAPIObject) {
  const routes = Object.entries(document.paths).map(([path, item]) => {
    const methods = HTTP_METHODS.filter((m) => m in item).map((m) =>
      m.toUpperCase(),
    );
    // Express는 GET 경로에 HEAD를 함께 받는다.
    const allow = methods.includes('GET') ? [...methods, 'HEAD'] : methods;

    return {
      pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}/?$`),
      allow,
    };
  });

  return (req: Request, _res: Response, next: NextFunction): void => {
    const route = routes.find((r) => r.pattern.test(req.path));
    const isWrongMethod =
      route !== undefined && !route.allow.includes(req.method);

    next(isWrongMethod ? methodNotAllowed(route.allow) : undefined);
  };
}

/** 본문은 JSON만 받는다. 다른 형식이면 본문을 읽지 못해 "필드가 모두 없음"으로 답하게 되므로 415로 답한다 (ADR-0020). */
export function jsonBodyMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const hasBody =
      req.headers['transfer-encoding'] !== undefined ||
      Number(req.headers['content-length'] ?? 0) > 0;
    const isNotJson = hasBody && !req.is('application/json');

    next(isNotJson ? unsupportedMediaType() : undefined);
  };
}
