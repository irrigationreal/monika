# ── Stage 1: Build memstore ──────────────────────────────
FROM golang:1.22-bookworm AS memstore-build
COPY services/memstore/ /src/
WORKDIR /src
RUN CGO_ENABLED=1 go build -tags fts5 -o /memstore .

# ── Stage 2: Runtime ─────────────────────────────────────
FROM debian:bookworm-slim

ARG MONIKA_BUILD_COMMIT=""
ARG MONIKA_BUILD_SOURCE=""
ARG MONIKA_BUILD_DATE=""

LABEL org.opencontainers.image.revision=$MONIKA_BUILD_COMMIT
LABEL org.opencontainers.image.source=$MONIKA_BUILD_SOURCE
LABEL org.opencontainers.image.created=$MONIKA_BUILD_DATE

# System deps — base + Chromium headless requirements
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl bash openssh-client \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 \
    libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 \
    libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 libxrender1 \
    libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 libglib2.0-0 \
    libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 \
    libcups2 libxshmfence1 libgbm1 \
    fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22.x (matches stanza's system node)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Pin an npm release with native dependency cooldown support. The bootstrap
# upgrade itself necessarily runs before the cooldown can be enabled.
RUN npm install -g npm@11.18.0

# Protect image builds and ad-hoc npm installs inside the finished image from
# newly published packages. Pi is the sole deliberate exception below.
ENV NPM_CONFIG_PREFIX=/usr/local \
    NPM_CONFIG_MIN_RELEASE_AGE=10

# Build metadata is baked into the image for runtime introspection. It is
# intentionally stored in a file rather than supplied as mutable runtime env.
RUN mkdir -p /opt/monika && \
    MONIKA_BUILD_COMMIT="$MONIKA_BUILD_COMMIT" \
    MONIKA_BUILD_SOURCE="$MONIKA_BUILD_SOURCE" \
    MONIKA_BUILD_DATE="$MONIKA_BUILD_DATE" \
    node -e "const fs=require('fs'); const info={commit:process.env.MONIKA_BUILD_COMMIT||null,source:process.env.MONIKA_BUILD_SOURCE||null,date:process.env.MONIKA_BUILD_DATE||null,label:process.env.MONIKA_BUILD_COMMIT?process.env.MONIKA_BUILD_COMMIT.slice(0,12):'local build'}; fs.writeFileSync('/opt/monika/build-info.json', JSON.stringify(info,null,2)+'\\n');"

# Use the image-owned Chrome installed below, rather than a browser under
# /home/monika, which is bind-mounted from the host in production.
ENV AGENT_BROWSER_INSTALL_HOME=/opt/agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/agent-browser/chrome

# Pi coding agent — pinned version. Pi releases are deliberately exempt from
# the cooldown because coordinated @earendil-works updates are reviewed and
# adopted explicitly; the exact version keeps the resulting image reproducible.
RUN npm install -g --min-release-age=0 @earendil-works/pi-coding-agent@0.75.5

# AgentLogs CLI — pinned version. Authentication/config is runtime-owned and
# stored under /agentlogs-home by scripts/agentlogs-monika.
RUN npm install -g agentlogs@0.1.7
ENV AGENTLOGS_CLI_PATH=/usr/local/bin/agentlogs

# Agent browser CLI + Chromium
# agent-browser install uses HOME for its managed Chrome download location on
# platforms where Chrome for Testing is available. Linux ARM64 is not published
# by Chrome for Testing, so use Debian's Chromium package there instead. Expose
# either browser via a stable executable path that runtime sessions use explicitly.
RUN mkdir -p "$AGENT_BROWSER_INSTALL_HOME" && \
    npm install -g agent-browser@0.31.1 && \
    if [ "$(dpkg --print-architecture)" = "arm64" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends chromium && \
      rm -rf /var/lib/apt/lists/* && \
      ln -sf /usr/bin/chromium "$AGENT_BROWSER_EXECUTABLE_PATH"; \
    else \
      HOME="$AGENT_BROWSER_INSTALL_HOME" agent-browser install && \
      chrome_path="$(find "$AGENT_BROWSER_INSTALL_HOME/.agent-browser/browsers" -type f -name chrome | sort -V | tail -n 1)" && \
      test -n "$chrome_path" && \
      ln -sf "$chrome_path" "$AGENT_BROWSER_EXECUTABLE_PATH"; \
    fi && \
    "$AGENT_BROWSER_EXECUTABLE_PATH" --version

# Pre-install pi's declared packages so first run isn't slow.
# This requires a settings.json with the packages list.
COPY config/settings.json /tmp/pi-settings.json
RUN mkdir -p /tmp/pi-prebuild/.pi/agent && \
    cp /tmp/pi-settings.json /tmp/pi-prebuild/.pi/agent/settings.json && \
    cd /tmp/pi-prebuild && \
    HOME=/tmp/pi-prebuild PI_CODING_AGENT_DIR=/tmp/pi-prebuild/.pi/agent \
    pi --version 2>/dev/null || true && \
    rm -rf /tmp/pi-prebuild /tmp/pi-settings.json

# memstore binary
COPY --from=memstore-build /memstore /usr/local/bin/memstore

# Monika agent daemon: a small Pi-backed HTTP/SSE service used by alternate
# frontends such as monika-forum. It runs in the same container as Pi/memstore
# so there is a single owner for agent sessions and memory integration.
WORKDIR /opt/agentd
COPY services/agentd/package.json services/agentd/pnpm-lock.yaml services/agentd/pnpm-workspace.yaml ./
RUN corepack enable && \
    corepack prepare pnpm@10.26.2 --activate && \
    pnpm install --prod --frozen-lockfile
COPY services/agentd/src/ /opt/agentd/src/

# Keep pnpm's 10-day cooldown active outside a checked-out workspace without
# exposing pnpm's differently named setting to npm as an unknown environment
# option. Workspace files can still add precise package exemptions.
RUN rm -f /usr/local/bin/pnpm /usr/local/bin/pnpx && \
    printf '%s\n' \
      '#!/bin/sh' \
      'export NPM_CONFIG_MINIMUM_RELEASE_AGE=14400' \
      'exec corepack pnpm@10.26.2 "$@"' \
      > /usr/local/bin/pnpm && \
    printf '%s\n' \
      '#!/bin/sh' \
      'export NPM_CONFIG_MINIMUM_RELEASE_AGE=14400' \
      'exec corepack pnpm@10.26.2 dlx "$@"' \
      > /usr/local/bin/pnpx && \
    chmod +x /usr/local/bin/pnpm /usr/local/bin/pnpx
WORKDIR /

# AgentLogs runtime wrapper
COPY scripts/agentlogs-monika /usr/local/bin/agentlogs-monika
RUN chmod +x /usr/local/bin/agentlogs-monika

# SSH config for container root user. Runtime deployments may mount
# /runtime/secrets/ssh over /root/.ssh for git and explicit relocate operations.
RUN mkdir -p /root/.ssh && \
    printf '%s\n' \
      'Host *' \
      '    IdentityFile /root/.ssh/id_ed25519' \
      '    IdentityFile /root/.ssh/id_rsa' \
      '    UserKnownHostsFile /tmp/known_hosts' \
      '    StrictHostKeyChecking accept-new' \
    > /root/.ssh/config && \
    chmod 700 /root/.ssh && \
    chmod 600 /root/.ssh/config

# Bundled .pi directory. Runtime deployments may mount selected persistent state
# under /app/.pi, but extensions and defaults are image-owned.
RUN mkdir -p /app/.pi/agent/extensions /app/.pi/stateful-memory/persona_topics \
             /app/.pi/stateful-memory/memory/sessions \
             /app/.pi/stateful-memory/dreams \
             /app/.pi/memstore /data

COPY config/extensions/          /app/.pi/agent/extensions/
COPY config/settings.json        /app/.pi/agent/settings.json
COPY config/stateful-memory.json /app/.pi/agent/stateful-memory.json
COPY config/persona/SOUL.md                /app/.pi/stateful-memory/SOUL.md
COPY config/persona/STYLE.md               /app/.pi/stateful-memory/STYLE.md
COPY config/persona/REGISTER.md            /app/.pi/stateful-memory/REGISTER.md
COPY config/persona/PERSONALITY_MATRIX.md  /app/.pi/stateful-memory/PERSONALITY_MATRIX.md
COPY config/persona/persona_topics/        /app/.pi/stateful-memory/persona_topics/

# Create a test-mode stateful-memory.json that uses /app/.pi as baseDir
RUN node -e "\
  const s = JSON.parse(require('fs').readFileSync('/app/.pi/agent/stateful-memory.json','utf8'));\
  s.baseDir = '/app/.pi';\
  require('fs').writeFileSync('/app/.pi/agent/stateful-memory.json', JSON.stringify(s, null, 2)+'\n');"


VOLUME /data

COPY bin/ /app/bin/
RUN chmod +x /app/bin/agent-runner.mjs

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
