#!/usr/bin/env bash

# Run one foreground command while this shell remains PID 1 and owns sibling
# cleanup. Set SUPERVISED_ESSENTIAL_PIDS to a space-separated list of runtime
# child PIDs that must remain alive for the command's full lifetime.
supervise_foreground_command() {
  local command_status exited_pid essential_pid
  local -a wait_pids essential_pids
  SUPERVISED_COMMAND_PID=""
  SUPERVISED_ESSENTIAL_EXIT_PID=""

  forward_supervised_signal() {
    local signal="$1"
    if [ -n "${SUPERVISED_COMMAND_PID:-}" ]; then
      kill -s "$signal" "$SUPERVISED_COMMAND_PID" 2>/dev/null || true
    fi
  }

  trap 'forward_supervised_signal TERM' SIGTERM
  trap 'forward_supervised_signal INT' SIGINT

  # Bash starts asynchronous children with SIGINT ignored. Reset inherited
  # dispositions before exec so both TERM and INT remain effective.
  env --default-signal=INT,TERM -- "$@" &
  SUPERVISED_COMMAND_PID=$!
  read -r -a essential_pids <<< "${SUPERVISED_ESSENTIAL_PIDS:-}"
  wait_pids=("$SUPERVISED_COMMAND_PID" "${essential_pids[@]}")

  while true; do
    exited_pid=""
    wait -n -p exited_pid "${wait_pids[@]}"
    command_status=$?

    # A handled signal can interrupt wait before any child is reaped.
    if [ -z "$exited_pid" ]; then
      continue
    fi
    if [ "$exited_pid" = "$SUPERVISED_COMMAND_PID" ]; then
      break
    fi

    for essential_pid in "${essential_pids[@]}"; do
      if [ "$exited_pid" = "$essential_pid" ]; then
        SUPERVISED_ESSENTIAL_EXIT_PID="$essential_pid"
        [ "$command_status" -ne 0 ] || command_status=1
        forward_supervised_signal TERM
        wait "$SUPERVISED_COMMAND_PID" 2>/dev/null || true
        break 2
      fi
    done
  done

  trap - SIGTERM SIGINT
  SUPERVISED_COMMAND_PID=""
  return "$command_status"
}
