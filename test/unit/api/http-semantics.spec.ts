import type { OpenAPIObject } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ProblemException } from '../../../src/api/errors/problem';
import {
  jsonBodyMiddleware,
  methodNotAllowedMiddleware,
} from '../../../src/api/http/http-semantics.middleware';

const document = {
  paths: {
    '/v1/alarms': { get: {}, post: {} },
    '/v1/alarms/{id}': { get: {}, parameters: [] },
    '/v1/alarms/{id}/send': { post: {} },
    '/v1/things/{id}': { put: {}, delete: {}, patch: {} },
  },
} as unknown as OpenAPIObject;

/** 미들웨어가 next로 넘긴 값. 통과면 undefined, 거절이면 ProblemException이다. */
function run(
  middleware: (
    req: Request,
    res: Response,
    next: (e?: unknown) => void,
  ) => void,
  req: Partial<Request>,
): ProblemException | undefined {
  let passed: unknown;

  middleware(req as Request, {} as Response, (e) => (passed = e));

  return passed as ProblemException | undefined;
}

describe('메서드가 틀린 요청은 405 (ADR-0020)', () => {
  const check = methodNotAllowedMiddleware(document);
  const call = (method: string, path: string) => run(check, { method, path });

  it('문서에 있는 메서드는 통과하고, GET 경로는 HEAD도 받는다', () => {
    expect(call('GET', '/v1/alarms')).toBeUndefined();
    expect(call('POST', '/v1/alarms')).toBeUndefined();
    expect(call('HEAD', '/v1/alarms/abc')).toBeUndefined();
    expect(call('POST', '/v1/alarms/abc/send')).toBeUndefined();
  });

  it('경로는 있는데 메서드가 틀리면 405와 쓸 수 있는 메서드를 준다', () => {
    const problem = call('DELETE', '/v1/alarms/');

    expect(problem?.getStatus()).toBe(405);
    expect(problem?.problem.headers).toEqual({ Allow: 'GET, POST, HEAD' });
    expect(call('GET', '/v1/alarms/abc/send')?.problem.headers).toEqual({
      Allow: 'POST',
    });
    expect(call('GET', '/v1/things/1')?.problem.headers).toEqual({
      Allow: 'PUT, DELETE, PATCH',
    });
    // 경로 항목의 parameters 같은 칸은 메서드가 아니다.
    expect(call('PUT', '/v1/alarms/abc')?.problem.headers).toEqual({
      Allow: 'GET, HEAD',
    });
  });

  it('문서에 없는 경로는 건드리지 않는다(없는 경로는 404로 간다)', () => {
    expect(call('DELETE', '/v1/nothing')).toBeUndefined();
    expect(call('DELETE', '/v1/alarms/abc/send/more')).toBeUndefined();
    expect(call('DELETE', '/x/v1/alarms')).toBeUndefined();
  });
});

describe('JSON이 아닌 본문은 415 (ADR-0020)', () => {
  const check = jsonBodyMiddleware();
  const call = (headers: Record<string, string>) =>
    run(check, {
      headers,
      is: ((type: string) =>
        (headers['content-type'] ?? '').startsWith(type)
          ? type
          : false) as Request['is'],
    });

  it('본문이 있는데 JSON이 아니면 415', () => {
    expect(
      call({
        'content-type': 'text/plain',
        'content-length': '2',
      })?.getStatus(),
    ).toBe(415);
    expect(call({ 'transfer-encoding': 'chunked' })?.getStatus()).toBe(415);
  });

  it('JSON 본문이나 본문이 없는 요청은 통과한다', () => {
    expect(
      call({ 'content-type': 'application/json', 'content-length': '2' }),
    ).toBeUndefined();
    expect(
      call({ 'content-type': 'text/plain', 'content-length': '0' }),
    ).toBeUndefined();
    expect(call({})).toBeUndefined();
  });
});
