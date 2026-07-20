#!/usr/bin/env bash
#
# tproxy-net.sh — own the "tproxy" docker network (172.31.255.0/24) and steer it
# into the host's existing v2ray TPROXY listener on 127.0.0.1:65535.
#
# This script is the single owner of the docker network lifecycle:
#   start:  sysctl bridge-nf-call-iptables=0 -> docker network create
#           -> iptables mangle TPROXY chain + jump
#   stop:   reverse — iptables teardown -> docker network rm
#           -> restore bridge-nf-call-iptables
#
# Design (mirrors the host setup):
#   * REUSES the host fwmark 0x20151130 and policy-routing table 1130
#     (local default dev lo) — so we never touch PROXY_V2RAY / PROXY_MARK,
#     the ip rules, or table 1130.
#   * Sets net.bridge.bridge-nf-call-iptables=0 so bridged frames are NOT fed
#     into host iptables twice (avoids double TPROXY/NAT on the L2 path).
#   * Creates docker network ${NET_NAME} (${NET_CIDR}) if absent.
#   * Adds ONE dedicated mangle chain (DOCKER_TPROXY) jumped from PREROUTING
#     for source 172.31.255.0/24, placed BEFORE the host's -j PROXY_V2RAY.
#   * Excludes private/special destinations (so container -> gateway / LAN /
#     other containers is NOT proxied) — same list as PROXY_V2RAY.
#   * Uses --tproxy-mark 0x20151130 (not 0x0) so forwarded packets get routed
#     to local via table 1130 and delivered to the v2ray socket.
#   * Sets route_localnet=1 on the bridge so diverting to 127.0.0.1 is allowed.
#
# Usage:
#   sudo ./tproxy-net.sh start      # sysctl + create network + chain/jump
#   sudo ./tproxy-net.sh stop       # remove everything start added
#   sudo ./tproxy-net.sh status     # show current state
#   sudo ./tproxy-net.sh restart    # stop then start
#
# Env overrides (optional):
#   NET_NAME           (default: tproxy)         docker network name
#   NET_CIDR           (default: 172.31.255.0/24) subnet + source to intercept
#   TPROXY_IP          (default: 127.0.0.1)      v2ray listen ip
#   TPROXY_PORT        (default: 65535)          v2ray listen port
#   FWMARK             (default: 0x20151130)     mark reused -> table 1130
#   BRIDGE_NF_RESTORE  (default: 1)              value restored on stop
#
# Rules are NOT persistent across reboot. Wire `start` into a systemd unit
# or @reboot cron. Run `start` BEFORE `docker compose up -d` so the network
# + rules exist first; run `stop` AFTER `docker compose down`.

set -euo pipefail

NET_NAME="${NET_NAME:-tproxy}"
NET_CIDR="${NET_CIDR:-172.31.255.0/24}"
TPROXY_IP="${TPROXY_IP:-127.0.0.1}"
TPROXY_PORT="${TPROXY_PORT:-65535}"
FWMARK="${FWMARK:-0x20151130}"
BRIDGE_NF_KEY="net.bridge.bridge-nf-call-iptables"
# BRIDGE_NF_RESTORE="${BRIDGE_NF_RESTORE:-1}"
CHAIN="DOCKER_TPROXY"

# Private / special destinations we must NOT proxy (mirrors host PROXY_V2RAY).
# 172.16.0.0/12 already covers this docker network itself (172.31.255.0/24).
EXCLUDE_DST=(
  "0.0.0.0/8" "10.0.0.0/8" "127.0.0.0/8" "169.254.0.0/16"
  "172.16.0.0/12" "192.168.0.0/16" "224.0.0.0/4" "240.0.0.0/4"
)

# ---- helpers ----------------------------------------------------------------
ipt() { iptables -t mangle "$@"; }            # mangle-table wrapper

bridge_if() {                                  # resolve host bridge for CIDR
  ip -o route show "${NET_CIDR}" 2>/dev/null | awk '{print $3; exit}'
}

rule_exists() { ipt -C "$@" 2>/dev/null; }     # -C check, silent

add_rule_once() {                              # idempotent -A
  if rule_exists "$@"; then
    echo "  [skip] already present: $*"
  else
    ipt -A "$@" && echo "  [ ok ] added: $*"
  fi
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "error: must run as root (iptables/sysctl need CAP_NET_ADMIN)" >&2
    exit 1
  fi
}

network_exists() {                             # true if docker network present
  docker network inspect "${NET_NAME}" >/dev/null 2>&1
}

create_network() {                             # idempotent docker network create
  if network_exists; then
    echo "  [skip] docker network '${NET_NAME}' already exists"
    return
  fi
  if docker network create \
      --driver bridge \
      --subnet "${NET_CIDR}" \
      "${NET_NAME}" >/dev/null 2>&1; then
    echo "  [ ok ] created docker network '${NET_NAME}' (${NET_CIDR})"
  else
    echo "  [error] 'docker network create ${NET_NAME} --subnet ${NET_CIDR}' failed" >&2
    exit 1
  fi
}

remove_network() {                             # idempotent docker network rm
  if ! network_exists; then
    echo "  [skip] docker network '${NET_NAME}' absent"
    return
  fi
  if docker network rm "${NET_NAME}" >/dev/null 2>&1; then
    echo "  [ ok ] removed docker network '${NET_NAME}'"
  else
    echo "  [warn] could not remove network '${NET_NAME}' (containers still attached?)"
  fi
}

set_bridge_nf() {                              # net.bridge.bridge-nf-call-iptables=N
  local val="$1"
  if sysctl -w "${BRIDGE_NF_KEY}=${val}" >/dev/null 2>&1; then
    echo "  [ ok ] ${BRIDGE_NF_KEY}=${val}"
  else
    echo "  [warn] could not set ${BRIDGE_NF_KEY}=${val} (br_netfilter not loaded?)"
  fi
}

preflight() {
  if ! ss -tln 2>/dev/null | grep -q ":${TPROXY_PORT}\b"; then
    echo "  [warn] nothing listening on ${TPROXY_IP}:${TPROXY_PORT} — TPROXY will drop traffic"
  fi
  if ! ip rule show 2>/dev/null | grep -qi "fwmark .*${FWMARK}"; then
    echo "  [warn] no 'ip rule fwmark ${FWMARK}' found — TPROXY delivery will fail"
  fi
  if ! ip route show table 1130 2>/dev/null | grep -q "local default"; then
    echo "  [warn] table 1130 has no 'local default' — TPROXY delivery will fail"
  fi
}

# ---- actions ----------------------------------------------------------------
start() {
  echo "==> Starting tproxy for docker network '${NET_NAME}' (${NET_CIDR}) -> ${TPROXY_IP}:${TPROXY_PORT}"
  preflight

  # 1) stop bridged frames from being fed into host iptables twice
  set_bridge_nf 0

  # 2) create the docker network this script owns (defines 172.31.255.0/24)
  create_network

  # 3) route_localnet on the bridge: forwarded packets can be diverted to 127.0.0.1
  local br; br="$(bridge_if || true)"
  if [[ -n "$br" ]]; then
    if sysctl -w "net.ipv4.conf.${br}.route_localnet=1" >/dev/null 2>&1; then
      echo "  [ ok ] net.ipv4.conf.${br}.route_localnet=1"
    else
      echo "  [warn] could not set route_localnet on ${br}"
    fi
  else
    echo "  [warn] bridge for ${NET_CIDR} not found (network down?)."
    echo "         Rules are source-based and still installed; re-run 'start'"
    echo "         after 'docker compose up -d' to set route_localnet."
  fi

  # 4) create our chain (flush if it somehow pre-existed)
  if ipt -N "${CHAIN}" 2>/dev/null; then
    echo "  [ ok ] created chain ${CHAIN}"
  else
    echo "  [info] chain ${CHAIN} exists; flushing"
    ipt -F "${CHAIN}"
  fi

  # 5) exclude private/special destinations
  for dst in "${EXCLUDE_DST[@]}"; do
    add_rule_once "${CHAIN}" -d "$dst" -j RETURN
  done

  # 6) TPROXY the rest, reusing fwmark -> table 1130 (local default dev lo)
  add_rule_once "${CHAIN}" -p tcp -j TPROXY \
    --on-port "${TPROXY_PORT}" --on-ip "${TPROXY_IP}" --tproxy-mark "${FWMARK}"
  add_rule_once "${CHAIN}" -p udp -j TPROXY \
    --on-port "${TPROXY_PORT}" --on-ip "${TPROXY_IP}" --tproxy-mark "${FWMARK}"

  # 7) jump from PREROUTING for our subnet, BEFORE the host's -j PROXY_V2RAY
  if rule_exists PREROUTING -s "${NET_CIDR}" -j "${CHAIN}"; then
    echo "  [skip] PREROUTING jump already present"
  else
    ipt -I PREROUTING 1 -s "${NET_CIDR}" -j "${CHAIN}" \
      && echo "  [ ok ] inserted PREROUTING jump (-s ${NET_CIDR} -> ${CHAIN})"
  fi

  echo "==> Done."
}

stop() {
  echo "==> Stopping tproxy for docker network '${NET_NAME}'"

  # 1) remove the PREROUTING jump we added
  if ipt -D PREROUTING -s "${NET_CIDR}" -j "${CHAIN}" 2>/dev/null; then
    echo "  [ ok ] removed PREROUTING jump"
  else
    echo "  [skip] PREROUTING jump absent"
  fi

  # 2) flush + delete our chain
  if ipt -L "${CHAIN}" >/dev/null 2>&1; then
    ipt -F "${CHAIN}" 2>/dev/null || true
    if ipt -X "${CHAIN}" 2>/dev/null; then
      echo "  [ ok ] deleted chain ${CHAIN}"
    else
      echo "  [warn] could not delete ${CHAIN} (still referenced?)"
    fi
  else
    echo "  [skip] chain ${CHAIN} absent"
  fi

  # 3) restore route_localnet on the bridge (must run BEFORE remove_network)
  local br; br="$(bridge_if || true)"
  if [[ -n "$br" ]] && sysctl -w "net.ipv4.conf.${br}.route_localnet=0" >/dev/null 2>&1; then
    echo "  [ ok ] net.ipv4.conf.${br}.route_localnet=0"
  else
    echo "  [skip] route_localnet left as-is"
  fi

  # 4) remove the docker network this script owns
  remove_network

  # # 5) restore net.bridge.bridge-nf-call-iptables
  # set_bridge_nf "${BRIDGE_NF_RESTORE}"

  echo "==> Done. Host v2ray chains / ip rules / table 1130 left untouched."
}

status() {
  echo "==== docker network ===="
  docker network inspect "${NET_NAME}" \
    --format '  name={{.Name}}  driver={{.Driver}}  subnet={{range .IPAM.Config}}{{.Subnet}}{{end}}' \
    2>/dev/null || echo "  (network '${NET_NAME}' not found)"
  echo
  echo "==== bridge interface ===="
  local br; br="$(bridge_if || true)"
  if [[ -n "$br" ]]; then
    ip -o addr show "$br" | awk '{print "  "$2" "$4}'
    sysctl "net.ipv4.conf.${br}.route_localnet" 2>/dev/null | sed 's/^/  /'
  else
    echo "  (no route to ${NET_CIDR} — network down?)"
  fi
  echo
  echo "==== bridge netfilter ===="
  local nf
  if nf="$(sysctl -n "${BRIDGE_NF_KEY}" 2>/dev/null)"; then
    echo "  ${BRIDGE_NF_KEY}=${nf}"
  else
    echo "  (br_netfilter not loaded)"
  fi
  echo
  echo "==== our mangle chain (${CHAIN}) ===="
  ipt -S "${CHAIN}" 2>/dev/null | sed 's/^/  /' || echo "  (not present — stopped)"
  echo
  echo "==== PREROUTING (first jumps) ===="
  ipt -S PREROUTING 2>/dev/null | grep -E -- "${CHAIN}|PROXY_V2RAY" | sed 's/^/  /'
  echo
  echo "==== reused host policy routing ===="
  ip rule show 2>/dev/null | grep -- "${FWMARK}" | sed 's/^/  /'
  ip route show table 1130 2>/dev/null | sed 's/^/  table 1130: /'
  echo
  echo "==== listener ===="
  ss -tlnp 2>/dev/null | grep ":${TPROXY_PORT}" | sed 's/^/  /' || echo "  (nothing on ${TPROXY_PORT})"
}

# ---- dispatch ---------------------------------------------------------------
require_root
case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  *) echo "Usage: $0 {start|stop|restart|status}" >&2; exit 1 ;;
esac
