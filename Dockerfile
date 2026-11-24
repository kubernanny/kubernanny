# One image: the agent plus the web UI it serves at /.
# The protocol package is shared by agent and app (file:../protocol), so it is
# built first and kept at /protocol, where the agent's symlink points.

FROM node:24-alpine AS protocol
WORKDIR /build/protocol
COPY protocol/package*.json ./
RUN npm ci
COPY protocol/tsconfig*.json ./
COPY protocol/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS web
COPY --from=protocol /build/protocol /build/protocol
WORKDIR /build/app
COPY app/package*.json ./
RUN npm ci
COPY app/ ./
RUN npx ng build

FROM node:24-alpine AS agent
COPY --from=protocol /build/protocol /build/protocol
WORKDIR /build/agent
COPY agent/package*.json ./
RUN npm ci
COPY agent/tsconfig*.json ./
COPY agent/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production \
    WEB_ROOT=/app/web
COPY --from=protocol /build/protocol/package.json /protocol/package.json
COPY --from=protocol /build/protocol/dist /protocol/dist
COPY --from=protocol /build/protocol/node_modules /protocol/node_modules
WORKDIR /app
COPY --from=agent /build/agent/node_modules ./node_modules
COPY --from=agent /build/agent/dist ./dist
COPY --from=agent /build/agent/package.json ./
COPY --from=web /build/app/dist/app/browser ./web
USER node
# 8080: API and web UI. 9100: Prometheus metrics, keep it off the ingress.
EXPOSE 8080 9100
CMD ["node", "dist/main.js"]
