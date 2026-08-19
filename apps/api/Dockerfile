# ffmpeg is the reason this is not just `FROM node:22-alpine`: video frame extraction shells out
# to it, and the alpine base does not ship it.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/service/package.json packages/service/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --workspace @caliper/api --include-workspace-root

COPY packages ./packages
COPY apps/api ./apps/api
COPY tsconfig.base.json ./

ENV NODE_ENV=production
EXPOSE 4000
CMD ["npx", "tsx", "apps/api/src/server.ts"]
