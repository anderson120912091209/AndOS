# The worker in its own box: a Linux container — under colima or Docker Desktop that is a
# real VM on your Mac — reaching the Relay server over HTTP, exactly as a worker on a remote
# machine would. Build from the repo root:
#   docker build -f apps/worker/Dockerfile -t relay-worker .
FROM node:22-slim
WORKDIR /relay
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Manifests first so dependency installs cache across code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/worker apps/worker

# host.docker.internal is your Mac, seen from inside the VM.
ENV RELAY_SERVER=http://host.docker.internal:8787 \
    RELAY_OUTBOX=/outbox
USER node
# Straight to tsx: no package manager at runtime, nothing downloaded when the box starts.
CMD ["node_modules/.bin/tsx", "apps/worker/src/index.ts"]
