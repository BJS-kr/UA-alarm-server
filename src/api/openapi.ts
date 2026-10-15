import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** 명세가 OpenAPI 3.0을 요구하므로 버전을 3.0.x로 고정한다 (ADR-0037). */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setOpenAPIVersion('3.0.3')
    .setTitle('Alarm Dispatcher API')
    .setDescription(
      '다수의 수신자에게 알림을 발송한다. 에러는 RFC 9457 Problem Details(application/problem+json)로 응답한다.',
    )
    .setVersion('1.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description: '고정 API 키 (ADR-0033)',
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
