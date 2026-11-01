# One image for every service, chosen by each ECS task's working directory.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@10.30.1 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "!@food/web"
RUN for app in auth restaurant order payment; do \
      (cd "apps/$app" && DATABASE_URL=postgresql://build pnpm exec prisma generate); \
    done
