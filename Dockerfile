# Dev container for aken-harness (dsh).
# Source is bind-mounted at runtime (see docker-compose.yml), so this image
# only needs the toolchain, not the repo contents.
FROM node:22-bookworm

# node-gyp/native addon build deps (e.g. native/landlock-run fallback builds),
# plus socat: dsh web only binds 127.0.0.1 inside the container (hardcoded,
# see docker-compose.yml), so a loopback->published-port proxy is needed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 socat \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /workspace
