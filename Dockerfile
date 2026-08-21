# The image Cloud Run runs. Node is pinned by digest as well as by tag, so a rebuild months from
# now produces the same base the deploy was tested against. Keep the tag in step with .node-version:
# stack.test.ts fails when they drift apart.
FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

ENV NODE_ENV=production
# Cloud Run terminates TLS in front of the container and routes requests into it, so the server has
# to accept connections on every interface rather than on loopback.
ENV HOST=all

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public

# Nothing the service does needs root, and Cloud Run will not grant it anything by being root.
USER node

# Documentation only: Cloud Run injects PORT, and the server reads it.
EXPOSE 8080

CMD ["node", "dist/server/index.js"]
