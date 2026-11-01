FROM node:22-slim
ARG APP
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@10.30.1 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@food/${APP}..."
RUN if [ -f "apps/${APP}/prisma/schema.prisma" ]; then pnpm --filter "@food/${APP}" exec prisma generate; fi
WORKDIR /repo/apps/${APP}
ENV KAFKAJS_NO_PARTITIONER_WARNING=1
CMD ["pnpm", "start"]
