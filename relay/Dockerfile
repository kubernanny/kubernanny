# The relay: docker build -f relay/Dockerfile -t kubernanny-relay .
# Built from the repository root, because the relay links the shared protocol
# package (file:../protocol), which is kept at /protocol where the link points.
#
# Runs as non-root and writes nothing: fine with readOnlyRootFilesystem and
# no volumes at all.

# node:24-alpine, pinned by digest like the agent's image (see the Dockerfile at
# the root); bump both together, with the digest from
# `docker buildx imagetools inspect node:24-alpine`.
ARG NODE_IMAGE=node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

FROM ${NODE_IMAGE} AS protocol
WORKDIR /build/protocol
COPY protocol/package*.json ./
RUN npm ci
COPY protocol/tsconfig*.json ./
COPY protocol/src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS relay
COPY --from=protocol /build/protocol /build/protocol
WORKDIR /build/relay
COPY relay/package*.json ./
RUN npm ci
COPY relay/tsconfig*.json ./
COPY relay/src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
COPY --from=protocol /build/protocol/package.json /protocol/package.json
COPY --from=protocol /build/protocol/dist /protocol/dist
COPY --from=protocol /build/protocol/node_modules /protocol/node_modules
WORKDIR /app
COPY --from=relay /build/relay/node_modules ./node_modules
COPY --from=relay /build/relay/dist ./dist
COPY --from=relay /build/relay/package.json ./
USER node
# 8080: the HTTP API and the agents' WebSockets. 9100: Prometheus metrics, keep it private.
EXPOSE 8080 9100
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/main.js"]
