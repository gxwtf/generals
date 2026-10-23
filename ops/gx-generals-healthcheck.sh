#!/usr/bin/env bash
# =============================================================================
# gx-generals-healthcheck.sh — 将军棋（Gennia 私有部署）定时健康检查 + 自动重启
#
# 部署位置 : /home/gxwtf/gxwtf_generals/ops/gx-generals-healthcheck.sh
# 触发方式 : systemd timer gx-generals-healthcheck.timer（每 60s 一次，service 以 root 运行）
# 日志     : /var/log/gx-generals-healthcheck.log（append，含时间戳/逐项结果/动作）
# 状态     : /var/lib/gx-generals-healthcheck/（按服务分文件持久化连续失败次数与上次重启时间）
#
# 检查分组：
#   backend  127.0.0.1:3001  /ping、/get_rooms、socket.io 握手
#   bot      127.0.0.1:1214  /type/、/status/
#   client   127.0.0.1:1984  首页（客户端页面）
#   public   https://api.generals.gxwtf.cn/get_rooms、https://generals.gxwtf.cn/
#
# 判定与恢复：
#   backend 组连续 FAIL_THRESHOLD(2) 次失败 → systemctl restart gxgen_server
#   bot     组连续失败 → systemctl restart gxgenbot
#   client  组连续失败 → systemctl restart gxgen_client
#   public  组连续失败且本地上游(backend/bot/client)均健康 → nginx -t 通过后
#           systemctl reload nginx，reload 失败再 restart nginx
#   * 同一服务操作后 COOLDOWN_SECONDS(300) 秒冷却，冷却期内只记录不重复操作；
#   * 失败计数与冷却时间持久化；某项检查恢复成功后对应失败计数立即清零；
#   * 重启后做最多 ~10s 的恢复验证并写日志；失败计数不做清零（冷却负责限速）。
#
# 用法：
#   gx-generals-healthcheck.sh [--once] [--dry-run] [--help] [--version]
#     --once      单次执行（默认行为；显式传入仅为兼容 crontab/文档习惯）
#     --dry-run   只检查/报告/演练判定：不执行任何 systemctl 动作，也不写冷却时间，
#                 失败计数照常持久化（便于用 STATE_DIR 指向测试目录做自测）
#
# 自测环境变量（括号内为默认值）：
#   SERVER_HOST(127.0.0.1) SERVER_PORT(3001) BOT_HOST(127.0.0.1) BOT_PORT(1214)
#   CLIENT_HOST(127.0.0.1) CLIENT_PORT(1984)
#   BACKEND_BASE_URL(http://$SERVER_HOST:$SERVER_PORT)  BOT_BASE_URL(...)
#   CLIENT_BASE_URL(...) PUBLIC_API_URL(https://api.generals.gxwtf.cn/get_rooms)
#   PUBLIC_WEB_URL(https://generals.gxwtf.cn/)
#   HTTP_TIMEOUT(5) PUBLIC_HTTP_TIMEOUT(20) FAIL_THRESHOLD(2) COOLDOWN_SECONDS(300)
#   STATE_DIR(/var/lib/gx-generals-healthcheck) LOG_FILE(/var/log/gx-generals-healthcheck.log)
#   SERVER_SERVICE(gxgen_server) BOT_SERVICE(gxgenbot) CLIENT_SERVICE(gxgen_client)
#   NGINX_SERVICE(nginx)
#
# 自测示例（把后端探针指向关闭端口，只演练判定，不动生产）：
#   sudo env STATE_DIR=/tmp/hc-sim LOG_FILE=/tmp/hc-sim.log \
#        BACKEND_BASE_URL=http://127.0.0.1:39999 \
#        /home/gxwtf/gxwtf_generals/ops/gx-generals-healthcheck.sh --dry-run
# =============================================================================
set -u
umask 022

VERSION="1.0.0"
PROG="$(basename "$0")"

# ---------------------------------------------------------------------------
# 配置（全部可用环境变量覆盖，便于自测/迁移）
# ---------------------------------------------------------------------------
SERVER_HOST="${SERVER_HOST:-127.0.0.1}"
SERVER_PORT="${SERVER_PORT:-3001}"
BOT_HOST="${BOT_HOST:-127.0.0.1}"
BOT_PORT="${BOT_PORT:-1214}"
CLIENT_HOST="${CLIENT_HOST:-127.0.0.1}"
CLIENT_PORT="${CLIENT_PORT:-1984}"

BACKEND_BASE_URL="${BACKEND_BASE_URL:-http://${SERVER_HOST}:${SERVER_PORT}}"
BOT_BASE_URL="${BOT_BASE_URL:-http://${BOT_HOST}:${BOT_PORT}}"
CLIENT_BASE_URL="${CLIENT_BASE_URL:-http://${CLIENT_HOST}:${CLIENT_PORT}}"
PUBLIC_API_URL="${PUBLIC_API_URL:-https://api.generals.gxwtf.cn/get_rooms}"
PUBLIC_WEB_URL="${PUBLIC_WEB_URL:-https://generals.gxwtf.cn/}"

HTTP_TIMEOUT="${HTTP_TIMEOUT:-5}"
# 公网探针经由公网 DNS/TLS/回源，实测存在 0.05s ~ 9s 的抖动（服务器上还有其它大流量），
# 10s 会造成假失败；默认放宽到 20s。超时仍按 FAIL 计入（符合健康判定约定）。
PUBLIC_HTTP_TIMEOUT="${PUBLIC_HTTP_TIMEOUT:-20}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-300}"

STATE_DIR="${STATE_DIR:-/var/lib/gx-generals-healthcheck}"
LOG_FILE="${LOG_FILE:-/var/log/gx-generals-healthcheck.log}"

SERVER_SERVICE="${SERVER_SERVICE:-gxgen_server}"
BOT_SERVICE="${BOT_SERVICE:-gxgenbot}"
CLIENT_SERVICE="${CLIENT_SERVICE:-gxgen_client}"
NGINX_SERVICE="${NGINX_SERVICE:-nginx}"

DRY_RUN=0
ACTION_COUNT=0
RUN_STARTED_EPOCH="$(date +%s)"

usage() {
  cat <<'EOF'
用法: gx-generals-healthcheck.sh [--once] [--dry-run] [--help] [--version]

  --once      单次执行（默认行为）
  --dry-run   只检查/报告/演练判定，不执行任何 systemctl 动作，也不写冷却时间
  -h, --help  显示帮助（含全部可覆盖的环境变量说明）
  -V, --version 显示版本

默认探针：backend 127.0.0.1:3001（/ping、/get_rooms、socket.io 握手）
          bot 127.0.0.1:1214（/type/、/status/）
          client 127.0.0.1:1984（首页）
          public https://api.generals.gxwtf.cn/get_rooms、https://generals.gxwtf.cn/
默认日志 /var/log/gx-generals-healthcheck.log
默认状态 /var/lib/gx-generals-healthcheck/
连续失败阈值 2，重启后冷却 300 秒（可用 FAIL_THRESHOLD/COOLDOWN_SECONDS 覆盖）
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --once) ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -V|--version) echo "$PROG $VERSION"; exit 0 ;;
    *) echo "$PROG: 未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# 运行环境
# ---------------------------------------------------------------------------
RUNDIR="$(mktemp -d "${TMPDIR:-/tmp}/gxhc.XXXXXX")" || { echo "$PROG: mktemp 失败" >&2; exit 2; }
cleanup() { rm -rf "$RUNDIR"; }
trap cleanup EXIT

mkdir -p "$STATE_DIR" 2>/dev/null || { echo "$PROG: 无法创建状态目录 $STATE_DIR（需要 root）" >&2; exit 2; }
touch "$LOG_FILE" 2>/dev/null || { echo "$PROG: 无法写入日志 $LOG_FILE（需要 root）" >&2; exit 2; }

LOCK_FILE="$STATE_DIR/.healthcheck.lock"
exec 9>"$LOCK_FILE" 2>/dev/null || { echo "$PROG: 无法打开锁文件 $LOCK_FILE" >&2; exit 2; }
# 加非阻塞排他锁：上一轮未结束时跳过本轮，避免探针/动作叠加。
# （flock 缺失时退化为不加锁，行为仍正确，只是失去防叠加能力。）
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    printf '%s [WARN] 上一轮 %s 仍在运行（锁 %s），本轮跳过\n' "$(date -Is)" "$PROG" "$LOCK_FILE" >> "$LOG_FILE"
    exit 0
  fi
fi

now_epoch() { date +%s; }
now_iso()   { date -Is; }

log() { # level message...
  local level="$1"; shift
  local line
  line="$(now_iso) [$level] $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >> "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# 状态读写（按服务分文件，纯 bash，无 jq 依赖）
#   $STATE_DIR/<service>.failures     连续失败次数（整数）
#   $STATE_DIR/<service>.last_restart 上次重启/动作的 epoch 秒（整数，0=从未）
#   $STATE_DIR/<service>.last_action_at 上次动作的 ISO 时间（文本，便于排查）
# ---------------------------------------------------------------------------
state_file() { printf '%s/%s.%s' "$STATE_DIR" "$1" "$2"; }

state_get() { # service field default
  local f v=""
  f="$(state_file "$1" "$2")"
  [ -f "$f" ] && v="$(head -c 64 "$f" 2>/dev/null | tr -dc '0-9')"
  [ -z "$v" ] && v="${3:-0}"
  printf '%s' "$v"
}

state_get_raw() { # service field
  local f v=""
  f="$(state_file "$1" "$2")"
  [ -f "$f" ] && v="$(head -c 200 "$f" 2>/dev/null)"
  printf '%s' "$v"
}

state_set() { # service field value
  local f
  f="$(state_file "$1" "$2")"
  printf '%s\n' "$3" > "$f.tmp.$$" 2>/dev/null && mv -f "$f.tmp.$$" "$f" 2>/dev/null
}

# ---------------------------------------------------------------------------
# HTTP 探针
#   探测结果放全局：P_CODE / P_BODY_FILE / P_BODY / P_ERR
# ---------------------------------------------------------------------------
P_CODE="000"; P_BODY_FILE=""; P_BODY=""; P_ERR=""; P_TIME="0.000"

probe_http() { # url [timeout]
  local url="$1" timeout="${2:-$HTTP_TIMEOUT}"
  local bf ef rc=0 meta=""
  bf="$RUNDIR/body.$RANDOM"; ef="$RUNDIR/err.$RANDOM"
  P_CODE="000"; P_BODY=""; P_ERR=""; P_TIME="0.000"; P_BODY_FILE="$bf"
  : > "$bf"
  meta="$(curl -sS --max-time "$timeout" -o "$bf" -w '%{http_code} %{time_total}' "$url" 2>"$ef")" || rc=$?
  P_CODE="${meta%% *}"; P_TIME="${meta##* }"
  [ -n "$P_CODE" ] || P_CODE="000"
  [ -n "$P_TIME" ] || P_TIME="0.000"
  if [ "$rc" -ne 0 ]; then
    P_CODE="000"
    P_ERR="$(tr -d '\r\n' < "$ef" 2>/dev/null | head -c 220)"
    [ -z "$P_ERR" ] && P_ERR="curl exit=$rc"
  fi
  # 单行预览，供日志查看（完整内容留在 P_BODY_FILE 里做校验）
  # 注意：CHECK_LINES 以 "|" 分隔，body 内的 "|" 需替换掉，否则会串字段
  P_BODY="$(tr -d '\r\n' < "$bf" 2>/dev/null | sed 's/|/¦/g' | head -c 200)"
  rm -f "$ef"
  return 0
}

# ---- body 校验器（参数为 body 文件路径） ----
body_is_json_object() { # 允许 {} 或 {..}（首尾花括号）
  local f="$1" first last
  [ -s "$f" ] || return 1
  first="$(head -c 1 "$f" 2>/dev/null)"
  last="$(tail -c 8192 "$f" 2>/dev/null | tr -d '[:space:]' | tail -c 1 2>/dev/null)"
  [ "$first" = "{" ] && [ "$last" = "}" ]
}

body_is_socket_handshake() { # socket.io polling 握手包以 "0" 开头
  [ "$(head -c 1 "$1" 2>/dev/null)" = "0" ]
}

body_has_success_true() { # 机器人接口约定返回 {"success":true,...}
  grep -Eq '"success"[[:space:]]*:[[:space:]]*true' "$1" 2>/dev/null
}

body_is_html() { # 页面类检查：body 含 HTML 结构特征
  head -c 8192 "$1" 2>/dev/null | grep -Eqi '<(!doctype|html|head|body|div|meta|title)' 2>/dev/null
}

# ---------------------------------------------------------------------------
# 检查项收集与输出
# ---------------------------------------------------------------------------
declare -A GROUP_FAIL=()
for g in backend bot client public; do GROUP_FAIL["$g"]=0; done
CHECK_LINES=()

run_check() { # group label url validator [timeout]
  local group="$1" label="$2" url="$3" validator="$4" timeout="${5:-$HTTP_TIMEOUT}"
  local ok=0 reason="" status
  probe_http "$url" "$timeout"
  if [ "$P_CODE" = "200" ]; then
    case "$validator" in
      ping)     ok=1 ;;
      json)     body_is_json_object "$P_BODY_FILE" && ok=1 || reason="body 不是 JSON 对象" ;;
      socketio) body_is_socket_handshake "$P_BODY_FILE" && ok=1 || reason="body 不以 0 开头（socket.io 握手包异常）" ;;
      success)  body_has_success_true "$P_BODY_FILE" && ok=1 || reason="body 中缺少 \"success\":true" ;;
      html)     body_is_html "$P_BODY_FILE" && ok=1 || reason="body 不是 HTML" ;;
      *)        ok=1 ;;
    esac
  else
    reason="${P_ERR:-HTTP $P_CODE}"
  fi
  if [ "$ok" -eq 1 ]; then status="OK"; else status="FAIL"; GROUP_FAIL["$group"]=1; fi
  reason="${reason//|/¦}"
  CHECK_LINES+=("${status}|${group}|${label}|${url}|${P_CODE}|${reason}|${P_BODY}|${P_TIME}")
}

print_results() {
  local line status group label url code reason body ptime detail
  for line in "${CHECK_LINES[@]}"; do
    IFS='|' read -r status group label url code reason body ptime <<<"$line"
    detail="${group} ${label} http=${code} time=${ptime}s url=${url}"
    [ -n "$reason" ] && detail="${detail} reason=${reason}"
    [ -n "$body" ] && detail="${detail} body=[${body}]"
    log "$status" "$detail"
  done
}

# 供重启后的恢复验证使用：仅探测、不记录
group_healthy() { # group
  case "$1" in
    backend)
      probe_http "$BACKEND_BASE_URL/ping" "$HTTP_TIMEOUT";                 [ "$P_CODE" = "200" ] || return 1
      probe_http "$BACKEND_BASE_URL/get_rooms" "$HTTP_TIMEOUT";            { [ "$P_CODE" = "200" ] && body_is_json_object "$P_BODY_FILE"; } || return 1
      probe_http "$BACKEND_BASE_URL/socket.io/?EIO=4&transport=polling" "$HTTP_TIMEOUT"; { [ "$P_CODE" = "200" ] && body_is_socket_handshake "$P_BODY_FILE"; } || return 1
      ;;
    bot)
      probe_http "$BOT_BASE_URL/type/" "$HTTP_TIMEOUT";   { [ "$P_CODE" = "200" ] && body_has_success_true "$P_BODY_FILE"; } || return 1
      probe_http "$BOT_BASE_URL/status/" "$HTTP_TIMEOUT"; { [ "$P_CODE" = "200" ] && body_has_success_true "$P_BODY_FILE"; } || return 1
      ;;
    client)
      probe_http "$CLIENT_BASE_URL/" "$HTTP_TIMEOUT";     { [ "$P_CODE" = "200" ] && body_is_html "$P_BODY_FILE"; } || return 1
      ;;
    public)
      probe_http "$PUBLIC_API_URL" "$PUBLIC_HTTP_TIMEOUT"; { [ "$P_CODE" = "200" ] && body_is_json_object "$P_BODY_FILE"; } || return 1
      probe_http "$PUBLIC_WEB_URL" "$PUBLIC_HTTP_TIMEOUT"; { [ "$P_CODE" = "200" ] && body_is_html "$P_BODY_FILE"; } || return 1
      ;;
    *) return 1 ;;
  esac
  return 0
}

verify_group_recovery() { # group unit
  local group="$1" unit="$2" i
  for i in 1 2 3 4 5; do
    sleep 2
    if group_healthy "$group"; then
      log "INFO" "${unit} 重启后恢复验证通过（第 ${i} 次探测，间隔 2s）：${group} 组探针全部正常"
      return 0
    fi
  done
  log "ERROR" "${unit} 重启后恢复验证失败（10s 内 ${group} 组仍异常），请人工介入"
  return 1
}

# ---------------------------------------------------------------------------
# 状态计数与恢复动作
# ---------------------------------------------------------------------------
declare -A SERVICE_FAIL_COUNT=()
declare -A GROUP_TO_UNIT=()

update_service_state() { # group unit failed
  local group="$1" unit="$2" failed="$3" prev count
  prev="$(state_get "$unit" failures 0)"
  if [ "$failed" -eq 1 ]; then
    count=$((prev + 1))
    state_set "$unit" failures "$count"
  else
    if [ "$prev" -gt 0 ]; then
      log "INFO" "${group} 组已恢复正常（此前连续失败 ${prev} 次），失败计数清零"
    fi
    count=0
    state_set "$unit" failures 0
  fi
  SERVICE_FAIL_COUNT["$unit"]="$count"
}

check_cooldown() { # unit -> 0=可操作 3=冷却中；设置 COOLDOWN_REMAINING
  local unit="$1" now last elapsed
  COOLDOWN_REMAINING=0
  now="$(now_epoch)"
  last="$(state_get "$unit" last_restart 0)"
  if [ "$last" -gt 0 ]; then
    elapsed=$((now - last))
    if [ "$elapsed" -lt "$COOLDOWN_SECONDS" ]; then
      COOLDOWN_REMAINING=$((COOLDOWN_SECONDS - elapsed))
      return 3
    fi
  fi
  return 0
}

handle_service_failure() { # group unit desc
  local group="$1" unit="$2" desc="$3"
  local count="${SERVICE_FAIL_COUNT[$unit]:-0}" out rc active
  log "WARN" "${group} 组检查失败（连续 ${count}/${FAIL_THRESHOLD} 次，目标服务 ${unit}）"
  if [ "$count" -lt "$FAIL_THRESHOLD" ]; then
    log "INFO" "未达阈值（需连续 ${FAIL_THRESHOLD} 次失败），本轮不重启 ${unit}"
    return 0
  fi
  if ! check_cooldown "$unit"; then
    log "WARN" "${unit} 处于冷却期（剩余 ${COOLDOWN_REMAINING}s / 共 ${COOLDOWN_SECONDS}s），本轮不重复重启"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "WARN" "[dry-run] ${desc}服务 ${unit} 连续失败已达阈值，本应执行：systemctl restart ${unit}（dry-run 不执行、不写冷却时间）"
    return 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    log "ERROR" "重启 ${unit} 需要 root（当前 uid=$(id -u)）；请通过 gx-generals-healthcheck.service 或 sudo 运行"
    return 0
  fi
  log "WARN" "${desc}服务 ${unit} 连续失败达到阈值，执行：systemctl restart ${unit}"
  out="$(systemctl restart "$unit" 2>&1)"; rc=$?
  sleep 2
  active="$(systemctl is-active "$unit" 2>&1 || true)"
  if [ "$rc" -eq 0 ] && [ "$active" = "active" ]; then
    log "INFO" "重启成功：systemctl restart ${unit}（rc=0, is-active=active）"
  else
    log "ERROR" "重启异常：systemctl restart ${unit}（rc=${rc}, is-active=${active}）输出：$(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
  fi
  state_set "$unit" last_restart "$(now_epoch)"
  state_set "$unit" last_action_at "$(now_iso)"
  ACTION_COUNT=$((ACTION_COUNT + 1))
  verify_group_recovery "$group" "$unit"
}

handle_nginx_failure() { # reason
  local count="${SERVICE_FAIL_COUNT[$NGINX_SERVICE]:-0}" out rc active nt_out nt_rc
  log "WARN" "public 组检查失败（连续 ${count}/${FAIL_THRESHOLD} 次，nginx 公网入口）"
  if [ "$count" -lt "$FAIL_THRESHOLD" ]; then
    log "INFO" "未达阈值（需连续 ${FAIL_THRESHOLD} 次失败），本轮不操作 ${NGINX_SERVICE}"
    return 0
  fi
  if ! check_cooldown "$NGINX_SERVICE"; then
    log "WARN" "${NGINX_SERVICE} 处于冷却期（剩余 ${COOLDOWN_REMAINING}s / 共 ${COOLDOWN_SECONDS}s），本轮不重复操作"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "WARN" "[dry-run] 公网入口连续失败已达阈值，本应执行：systemctl reload/restart ${NGINX_SERVICE}（dry-run 不执行、不写冷却时间）"
    return 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    log "ERROR" "操作 ${NGINX_SERVICE} 需要 root（当前 uid=$(id -u)）；请通过 gx-generals-healthcheck.service 或 sudo 运行"
    return 0
  fi
  # 先做配置检查：配置有误时绝不清 reload/restart，避免公网入口直接中断
  if command -v nginx >/dev/null 2>&1; then
    nt_out="$(nginx -t 2>&1)"; nt_rc=$?
    if [ "$nt_rc" -ne 0 ]; then
      log "ERROR" "nginx -t 配置检查失败，放弃 reload/restart 以避免入口中断：$(printf '%s' "$nt_out" | tr '\n' ' ' | head -c 300)"
      state_set "$NGINX_SERVICE" last_restart "$(now_epoch)"
      state_set "$NGINX_SERVICE" last_action_at "$(now_iso)"
      return 0
    fi
    log "INFO" "nginx -t 配置检查通过"
  fi
  log "WARN" "公网入口异常，执行：systemctl reload ${NGINX_SERVICE}"
  out="$(systemctl reload "$NGINX_SERVICE" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    log "WARN" "systemctl reload ${NGINX_SERVICE} 失败（rc=${rc}），退化为 restart：$(printf '%s' "$out" | tr '\n' ' ' | head -c 200)"
    out="$(systemctl restart "$NGINX_SERVICE" 2>&1)"; rc=$?
    sleep 2
  fi
  active="$(systemctl is-active "$NGINX_SERVICE" 2>&1 || true)"
  if [ "$rc" -eq 0 ] && [ "$active" = "active" ]; then
    log "INFO" "nginx 操作成功：is-active=active（reload/restart rc=${rc}）"
  else
    log "ERROR" "nginx 操作异常：rc=${rc}, is-active=${active}，输出：$(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
  fi
  state_set "$NGINX_SERVICE" last_restart "$(now_epoch)"
  state_set "$NGINX_SERVICE" last_action_at "$(now_iso)"
  ACTION_COUNT=$((ACTION_COUNT + 1))
  verify_group_recovery public "$NGINX_SERVICE"
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
main() {
  local group_summary="" result="OK" g
  local mode="normal"; [ "$DRY_RUN" -eq 1 ] && mode="dry-run"

  log "INFO" "==== ${PROG} v${VERSION} 开始（mode=${mode}, host=$(hostname 2>/dev/null), pid=$$, threshold=${FAIL_THRESHOLD}, cooldown=${COOLDOWN_SECONDS}s）===="
  log "INFO" "探针：backend=${BACKEND_BASE_URL} bot=${BOT_BASE_URL} client=${CLIENT_BASE_URL} public_api=${PUBLIC_API_URL} public_web=${PUBLIC_WEB_URL}"

  run_check backend "/ping"                "${BACKEND_BASE_URL}/ping"                               ping     "$HTTP_TIMEOUT"
  run_check backend "/get_rooms"           "${BACKEND_BASE_URL}/get_rooms"                          json     "$HTTP_TIMEOUT"
  run_check backend "/socket.io 握手"      "${BACKEND_BASE_URL}/socket.io/?EIO=4&transport=polling" socketio "$HTTP_TIMEOUT"
  run_check bot     "/type/"               "${BOT_BASE_URL}/type/"                                  success  "$HTTP_TIMEOUT"
  run_check bot     "/status/"             "${BOT_BASE_URL}/status/"                                success  "$HTTP_TIMEOUT"
  run_check client  "首页 /"               "${CLIENT_BASE_URL}/"                                    html     "$HTTP_TIMEOUT"
  run_check public  "api /get_rooms"       "${PUBLIC_API_URL}"                                      json     "$PUBLIC_HTTP_TIMEOUT"
  run_check public  "web 首页 /"           "${PUBLIC_WEB_URL}"                                      html     "$PUBLIC_HTTP_TIMEOUT"

  print_results

  for g in backend bot client public; do
    if [ "${GROUP_FAIL[$g]}" -eq 1 ]; then group_summary="${group_summary}${g}=FAIL "; result="FAIL"
    else group_summary="${group_summary}${g}=OK "; fi
  done

  update_service_state backend "$SERVER_SERVICE" "${GROUP_FAIL[backend]}"
  update_service_state bot     "$BOT_SERVICE"    "${GROUP_FAIL[bot]}"
  update_service_state client  "$CLIENT_SERVICE" "${GROUP_FAIL[client]}"

  local local_fail=0
  [ "${GROUP_FAIL[backend]}" -eq 1 ] && local_fail=1
  [ "${GROUP_FAIL[bot]}" -eq 1 ] && local_fail=1
  [ "${GROUP_FAIL[client]}" -eq 1 ] && local_fail=1

  if [ "${GROUP_FAIL[public]}" -eq 1 ]; then
    if [ "$local_fail" -eq 1 ]; then
      # 公网入口的失败可由本地上游异常解释：只记录，不操作 nginx（避免误 reload）
      log "WARN" "public 组失败，但本地上游（backend/bot/client）同时异常，判定为上游故障，本轮不对 ${NGINX_SERVICE} 采取动作"
      GROUP_TO_UNIT[public]="${NGINX_SERVICE}"
    else
      update_service_state public "$NGINX_SERVICE" 1
      GROUP_TO_UNIT[public]="${NGINX_SERVICE}"
    fi
  else
    update_service_state public "$NGINX_SERVICE" 0
  fi

  # ---- 恢复动作（顺序：本地上游服务 → 公网入口） ----
  if [ "${GROUP_FAIL[backend]}" -eq 1 ]; then
    handle_service_failure backend "$SERVER_SERVICE" "后端"
  fi
  if [ "${GROUP_FAIL[bot]}" -eq 1 ]; then
    handle_service_failure bot "$BOT_SERVICE" "机器人"
  fi
  if [ "${GROUP_FAIL[client]}" -eq 1 ]; then
    handle_service_failure client "$CLIENT_SERVICE" "客户端"
  fi
  if [ "${GROUP_FAIL[public]}" -eq 1 ] && [ "$local_fail" -eq 0 ]; then
    handle_nginx_failure
  fi

  local duration
  duration=$(awk -v a="$RUN_STARTED_EPOCH" -v b="$(now_epoch)" 'BEGIN{printf "%.1f", b-a}')
  log "INFO" "summary: ${group_summary}| 失败计数: ${SERVER_SERVICE}=$(state_get "$SERVER_SERVICE" failures 0) ${BOT_SERVICE}=$(state_get "$BOT_SERVICE" failures 0) ${CLIENT_SERVICE}=$(state_get "$CLIENT_SERVICE" failures 0) ${NGINX_SERVICE}=$(state_get "$NGINX_SERVICE" failures 0) | actions=${ACTION_COUNT} | duration=${duration}s | result=${result}"
  log "INFO" "==== ${PROG} 结束（result=${result}）===="

  [ "$result" = "OK" ] && exit 0
  exit 1
}

main
