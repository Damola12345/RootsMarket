
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


RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev \
      --include-workspace-root \
      --workspace=notification-service \
      --workspace=@rootsmarket/observability


COPY shared/observability ./shared/observability
COPY services/notification-service ./services/notification-service

USER node

WORKDIR /app/services/notification-service

EXPOSE 3005


CMD ["node", "--require", "@rootsmarket/observability/tracing", "src/index.js"]