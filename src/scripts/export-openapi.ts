import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { createApiApp } from '../api/create-api-app';
import { buildOpenApiDocument } from '../api/openapi';
import { loadConfig } from '../shared/config/app-config';

/**
 * 서버를 띄우지 않고도 볼 수 있게 OpenAPI 문서를 파일로 내보낸다 (ADR-0037).
 * 사용법: node dist/scripts/export-openapi.js [출력 경로]
 * DB에 연결하지 않는다. 문서는 컨트롤러와 DTO에서만 만든다.
 */
async function main(): Promise<void> {
  const out = process.argv[2] ?? 'docs/openapi.json';
  const config = loadConfig({ DATABASE_URL: 'postgres://unused@localhost/unused', API_KEY: 'unused' }, 'api');
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const silent = { log: () => undefined, error: () => undefined, warn: () => undefined };
  const app = await createApiApp(config, pool, silent);
  await app.init();
  writeFileSync(out, `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`);
  await app.close();
  process.stdout.write(`${out}에 썼다\n`);
}

void main();
