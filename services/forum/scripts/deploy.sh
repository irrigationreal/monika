#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service_file="${repo_root}/scripts/codex-forum.service"

cd "${repo_root}"

# Install dependencies and build
# CI=true prevents pnpm from prompting for TTY confirmation when rebuilding modules
CI=true pnpm install
CI=true pnpm -F @irrigationreal/codex-forum build

# Deploy frontend assets
site_root="/var/www/forum.irrigate.cc/public"
install -d -m 0755 "${site_root}"

find "${site_root}" -mindepth 1 -delete
cp -a "${repo_root}/apps/codex-forum/dist/." "${site_root}/"

echo "Deployed UI to ${site_root}"

# Install systemd service if not present
if [[ ! -f /etc/systemd/system/codex-forum.service ]]; then
    echo "Installing systemd service..."
    sudo cp "${service_file}" /etc/systemd/system/codex-forum.service
    sudo systemctl daemon-reload
    sudo systemctl enable codex-forum.service
    echo "Systemd service installed and enabled"
fi

# Restart the service
# Use nohup + disown so the restart survives even if this script is a child of the service
nohup bash -c 'sleep 1 && systemctl restart codex-forum.service' >/dev/null 2>&1 &
disown
echo "Service restarted successfully"
