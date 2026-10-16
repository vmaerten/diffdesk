FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates chromium build-essential python3 curl \
    && rm -rf /var/lib/apt/lists/*
COPY mise.lock /tmp/mise.lock
COPY test/platform/install-tools.py /tmp/install-tools.py
RUN python3 /tmp/install-tools.py "$TARGETARCH"
RUN npm install --global pnpm@11.6.0
ENV PATH="/usr/local/go/bin:${PATH}" \
    CHROME_PATH=/usr/bin/chromium \
    GOTOOLCHAIN=local \
    LANG=C.UTF-8
USER node
WORKDIR /tmp
CMD ["bash", "/input/test/platform/linux.sh"]
