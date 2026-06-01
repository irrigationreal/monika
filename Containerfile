# ── Stage 1: Build memstore ──────────────────────────────
FROM golang:1.22-bookworm AS memstore-build
COPY services/memstore/ /src/
WORKDIR /src
RUN CGO_ENABLED=1 go build -tags fts5 -o /memstore .

# ── Stage 2: Runtime ─────────────────────────────────────
FROM debian:bookworm-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl bash openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22.x (matches stanza's system node)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Pi coding agent — pinned version
RUN npm install -g @earendil-works/pi-coding-agent@0.75.5

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

# Host shell wrapper
COPY host-shell /usr/local/bin/host-shell
RUN chmod +x /usr/local/bin/host-shell

# SSH config for container root user — all SSH connections (relocate, git,
# --ssh remote) use the deploy key and accept new host keys automatically.
# The key itself is bind-mounted at /persist/keys/ssh-local at runtime.
RUN mkdir -p /root/.ssh && \
    printf '%s\n' \
      'Host *' \
      '    IdentityFile /persist/keys/ssh-local' \
      '    UserKnownHostsFile /home/monika/.ssh/known_hosts' \
      '    StrictHostKeyChecking accept-new' \
    > /root/.ssh/config && \
    chmod 700 /root/.ssh && \
    chmod 600 /root/.ssh/config

# Bundled .pi directory for standalone/test mode.
# In production, /home/monika/.pi is bind-mounted over this.
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

# The production config at /home/monika/.pi/agent/stateful-memory.json
# will have baseDir=/home/monika/.pi and be bind-mounted from the host.

VOLUME /data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
