#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service_file="${repo_root}/scripts/codex-forum-staging.service"
service_name="codex-forum-staging.service"

docker_compose_file="${repo_root}/docker-compose.yml"

cd "${repo_root}"

# Install dependencies and build
# CI=true prevents pnpm from prompting for TTY confirmation when rebuilding modules
CI=true pnpm install
CI=true pnpm -F @irrigationreal/codex-forum build

# Deploy frontend assets
site_root="/var/www/forum-staging.irrigate.cc/public"
install -d -m 0755 "${site_root}"

find "${site_root}" -mindepth 1 -delete
cp -a "${repo_root}/apps/codex-forum/dist/." "${site_root}/"

echo "Deployed UI to ${site_root}"

deploy_with_docker_compose() {
    if [[ ! -f "${docker_compose_file}" ]]; then
        return 1
    fi
    if ! command -v docker >/dev/null 2>&1; then
        return 1
    fi

    echo "Deploying staging API via docker compose (${docker_compose_file})..."
    # If a legacy systemd service exists, disable it to avoid restart storms.
    if systemctl list-unit-files | grep -q "^${service_name}"; then
        sudo systemctl disable --now "${service_name}" >/dev/null 2>&1 || true
    fi

    # Rebuild and restart services. Remove orphan containers if the compose file changed.
    docker compose -f "${docker_compose_file}" up -d --build --remove-orphans
    echo "Docker compose staging services restarted successfully"
    return 0
}

if deploy_with_docker_compose; then
    exit 0
fi

# Fallback: systemd service

# Install systemd service if not present
if [[ ! -f "/etc/systemd/system/${service_name}" ]]; then
    echo "Installing systemd service..."
    sudo cp "${service_file}" "/etc/systemd/system/${service_name}"
    sudo systemctl daemon-reload
    sudo systemctl enable "${service_name}"
    echo "Systemd service installed and enabled"
fi

# Restart the service
# Use nohup + disown so the restart survives even if this script is a child of the service
nohup bash -c "sleep 1 && systemctl restart ${service_name}" >/dev/null 2>&1 &
disown
echo "Staging service restarted successfully"
