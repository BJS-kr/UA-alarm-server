import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** OpenAPI 3.0 스펙 호환을 위해 버전을 3.0.3으로 고정한다 (ADR-0037). */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setOpenAPIVersion('3.0.3')
    .setTitle('Alarm Dispatcher API')
    .setDescription(
      '대량/긴급 알림 발송 API. 오류 응답은 RFC 9457 Problem Details(application/problem+json) 형식을 따른다.',
    )
    .setVersion('1.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description: 'Bearer API 키 인증 (ADR-0033)',
    })
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function setupOpenApi(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);

  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  return document;
}
