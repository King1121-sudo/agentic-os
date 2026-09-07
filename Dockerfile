# Agentic OS — single image for api & web (compose runs it twice with different commands)
FROM node:24-slim

WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/
COPY apps/api/package.json apps/api/tsconfig.json apps/api/vitest.config.ts apps/api/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/next.config.js apps/web/
COPY sql ./sql

RUN npm install --no-audit --no-fund

COPY packages/contracts/src packages/contracts/src
COPY apps/api/src apps/api/src
COPY apps/web/src apps/web/src
COPY apps/web/public apps/web/public

RUN npm run build -w packages/contracts \
 && npx tsc -p apps/api/tsconfig.json \
 && cd apps/web && npx next build && cd /app

ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 4000 3000
CMD ["node", "dist/main.js"]
