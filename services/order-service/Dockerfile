FROM node:20-alpine

WORKDIR /app

# Every workspace manifest is copied so `npm ci` can validate the lockfile,
# but only this service and the shared package are installed.
COPY package.json package-lock.json ./
COPY services/user-service/package.json ./services/user-service/package.json
COPY services/product-service/package.json ./services/product-service/package.json
COPY services/order-service/package.json ./services/order-service/package.json
COPY services/payment-service/package.json ./services/payment-service/package.json
COPY services/notification-service/package.json ./services/notification-service/package.json
COPY shared/observability/package.json ./shared/observability/package.json

# --omit=dev keeps nodemon out of the runtime image.
# --include-workspace-root is harmless today (the root has no dependencies) and
# correct if one is ever added.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev \
      --include-workspace-root \
      --workspace=order-service \
      --workspace=@rootsmarket/observability


COPY shared/observability ./shared/observability
COPY services/order-service ./services/order-service

USER node

WORKDIR /app/services/order-service

EXPOSE 3003

CMD ["node", "--require", "@rootsmarket/observability/tracing", "src/index.js"]