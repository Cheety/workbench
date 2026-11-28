ARG BUN_IMAGE=oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages packages
RUN bun install --frozen-lockfile --production --ignore-scripts \
	&& rm -rf packages/architecture packages/core/src/testing \
	&& find packages -name '*.test.ts' -delete

FROM ${BUN_IMAGE}
WORKDIR /app
COPY --from=build /app /app
USER 1000:1000
EXPOSE 3000
CMD ["bun", "packages/core/src/main.ts"]
