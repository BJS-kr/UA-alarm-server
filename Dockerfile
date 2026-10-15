# api, worker, migrate가 같은 이미지에서 실행 명령만 달리한다 (ADR-0025).
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 단위·통합 테스트용. 크래시 테스트가 컴파일된 워커를 자식 프로세스로 띄우므로 빌드 결과도 함께 둔다 (ADR-0035).
FROM deps AS test
# 변이 테스팅(Stryker)이 테스트 프로세스를 정리할 때 ps를 쓴다. slim 이미지에는 없다.
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run build
CMD ["npm", "run", "check"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
USER node
# exec 형식: SIGTERM이 Node 프로세스에 직접 전달되어야 정상 종료가 동작한다 (ADR-0007).
CMD ["node", "dist/main-api.js"]
