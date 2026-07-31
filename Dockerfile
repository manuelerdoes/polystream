# syntax=docker/dockerfile:1

# ---- Build stage -------------------------------------------------------------
# better-sqlite3 is a native module: build it here (with full build toolchain)
# so the runtime image only needs the already-compiled .node binary.
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
	python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
# Drop devDependencies but keep the native build (better-sqlite3) working for the target arch.
RUN npm prune --omit=dev

# ---- Runtime stage -------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
	ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

# Migration SQL is inlined into the server bundle at build time (see src/lib/server/db/index.ts),
# so only the build output + runtime deps need to ship.
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

VOLUME /data
EXPOSE 3000

CMD ["node", "build"]
