# One image: the agent plus the web UI it serves at /.
# The protocol package is shared by agent and app (file:../protocol), so it is
# built first and kept at /protocol, where the agent's symlink points.

# node:24-alpine, pinned by digest (multi-arch index, 2026-11-25) so a moved tag
# cannot change the image; bump it on purpose, with the digest from
# `docker buildx imagetools inspect node:24-alpine`.
ARG NODE_IMAGE=node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

FROM ${NODE_IMAGE} AS protocol
WORKDIR /build/protocol
COPY protocol/package*.json ./
RUN npm ci
COPY protocol/tsconfig*.json ./
COPY protocol/src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS web
COPY --from=protocol /build/protocol /build/protocol
WORKDIR /build/app
COPY app/package*.json ./
RUN npm ci
COPY app/ ./
RUN npx ng build

FROM ${NODE_IMAGE} AS agent
COPY --from=protocol /build/protocol /build/protocol
WORKDIR /build/agent
COPY agent/package*.json ./
RUN npm ci
COPY agent/tsconfig*.json ./
COPY agent/src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
# The agent runs on node alone: no package manager in the image that runs it
# (npm, npx, corepack and yarn come with the base image).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
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
