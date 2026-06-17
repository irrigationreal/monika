# Monika agentd forum backend

The forum talks to Monika through `agentd` in the `monika` container. Pi remains
canonical; the forum database is a projection/metadata store.

Current deployment assumptions:

```text
MONIKA_AGENTD_BASE_URL=http://monika:7724
CODEX_FORUM_DB=/forum/data.db
CODEX_FORUM_UPLOADS_DIR=/forum/uploads
CODEX_WORK_DIR=/workspace/monika
```

Use the repository-level `compose.yaml.example` as the deployment template. Copy it
to ignored `compose.yaml` and run Docker Compose from the repo root:

```bash
cp compose.yaml.example compose.yaml
docker compose up -d --build
```

For architecture, endpoint, sync, taxonomy, attachment, and handoff details, see:

```text
docs/forum.md
```
