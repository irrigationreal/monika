# Host-side launcher for the standalone Monika container.
#
# Source this from ~/.bashrc.local or ~/.zshrc. It maps host project paths under
# ~/repos into the container's /workspace mount so Pi opens sessions in the
# matching project directory.

unalias pi 2>/dev/null || true

pi() {
  local host_cwd container_cwd workspace_root
  host_cwd="$PWD"
  workspace_root="${MONIKA_HOST_WORKSPACE:-$HOME/repos}"

  case "$host_cwd" in
    "$workspace_root")
      container_cwd="/workspace"
      ;;
    "$workspace_root"/*)
      container_cwd="/workspace/${host_cwd#"$workspace_root/"}"
      ;;
    *)
      container_cwd="${MONIKA_CONTAINER_DEFAULT_CWD:-/workspace/monika}"
      ;;
  esac

  docker exec -it \
    -e TERM="${TERM:-xterm-256color}" \
    -e COLORTERM="${COLORTERM:-truecolor}" \
    -w "$container_cwd" \
    monika pi "$@"
}
