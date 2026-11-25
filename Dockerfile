# One image: the agent plus the web UI it serves at /.
# The protocol package is shared by agent and app (file:../protocol), so it is
# built first. The agent is bundled with esbuild into two files (main.js and
# the admin cli.js): the image carries node, those two files and the web UI,
# no node_modules.

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
COPY agent/scripts/bundle.mjs ./scripts/bundle.mjs
COPY agent/src ./src
RUN npm run bundle

# The runtime: node:24-alpine without npm, npx, corepack and yarn. Deleting
# them in a layer on top would keep their bytes in the base layers, so the
# trimmed file system is copied into an empty image as one layer.
FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/include /usr/local/share/doc \
      /root/.npm /tmp/* \
  && mkdir -p /app

FROM scratch
# What CI built this image as: the image tag and the git commit. The agent reports them (status, /api/info), the app shows them.
ARG KUBERNANNY_BUILD=""
ARG KUBERNANNY_COMMIT=""
COPY --from=runtime / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=production \
    WEB_ROOT=/app/web \
    KUBERNANNY_BUILD=${KUBERNANNY_BUILD} \
    KUBERNANNY_COMMIT=${KUBERNANNY_COMMIT}
WORKDIR /app
# `kubectl exec … node dist/cli.js pair` keeps working: the bundle lands where the build output was.
COPY --from=agent /build/agent/bundle/main.js /build/agent/bundle/cli.js ./dist/
COPY --from=web /build/app/dist/app/browser ./web
# The image's own non-root user (uid 1000); the chart sets runAsNonRoot and the uid too.
USER node
# 8080: API and web UI. 9100: Prometheus metrics, keep it off the ingress.
EXPOSE 8080 9100
CMD ["node", "dist/main.js"]
