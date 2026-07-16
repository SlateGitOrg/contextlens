# ContextLens is a VS Code extension — there's no server to containerize.
# This image exists to give a reproducible, host-independent environment for
# linting, compiling, and running the (fully offline) unit test suite, e.g.
# for local CI parity or for running tests on a machine without Node 22.
FROM node:22-slim

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts .eslintrc.json ./
COPY src ./src
COPY test ./test

RUN npm run build

# Default action mirrors CI: lint, then run the unit tests.
CMD ["sh", "-c", "npm run lint && npm test"]
