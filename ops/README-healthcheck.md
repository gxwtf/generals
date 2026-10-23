# 将军棋（gxwtf）运维健康检查 / 自动重启

本目录是 Healthcheck 的受版本管理副本；线上实际运行位置为
`/home/gxwtf/gxwtf_generals/ops/gx-generals-healthcheck.sh`。

## 组件

| 文件 | 线上位置 | 作用 |
| --- | --- | --- |
| `ops/gx-generals-healthcheck.sh` | `/home/gxwtf/gxwtf_generals/ops/gx-generals-healthcheck.sh` | 健康检查 + 自动重启脚本（root 运行，由 timer 每 60s 触发） |
| `ops/systemd/gx-generals-healthcheck.service` | `/etc/systemd/system/gx-generals-healthcheck.service` | oneshot service，执行脚本 `--once` |
| `ops/systemd/gx-generals-healthcheck.timer` | `/etc/systemd/system/gx-generals-healthcheck.timer` | 每 60s 触发 service（`OnBootSec=60s`, `OnUnitActiveSec=60s`, `AccuracySec=5s`） |
| `ops/logrotate/gx-generals-healthcheck` | `/etc/logrotate.d/gx-generals-healthcheck` | 日志按天轮转、保留 14 天、压缩 |

运行时数据（不属于仓库）：

- 日志：`/var/log/gx-generals-healthcheck.log`
- 状态：`/var/lib/gx-generals-healthcheck/<service>.failures`、`<service>.last_restart`、`<service>.last_action_at`
- 锁：`/var/lib/gx-generals-healthcheck/.healthcheck.lock`（flock，防止两轮叠加）

## 检查项（每轮逐项 OK/FAIL 记录到日志与 stdout）

| 分组 | 检查 | 期望 |
| --- | --- | --- |
| backend | `GET http://127.0.0.1:3001/ping` | 200 |
| backend | `GET http://127.0.0.1:3001/get_rooms` | 200 且 body 为 JSON 对象 `{}` |
| backend | `GET http://127.0.0.1:3001/socket.io/?EIO=4&transport=polling` | 200 且 body 以 `0` 开头 |
| bot | `GET http://127.0.0.1:1214/type/` | 200 且含 `"success":true` |
| bot | `GET http://127.0.0.1:1214/status/` | 200 且含 `"success":true` |
| client | `GET http://127.0.0.1:1984/` | 200 且 body 为 HTML |
| public | `GET https://api.generals.gxwtf.cn/get_rooms` | 200 且 body 为 JSON 对象 |
| public | `GET https://generals.gxwtf.cn/` | 200 且 body 为 HTML |

> 公网探针超时默认 `PUBLIC_HTTP_TIMEOUT=20`：实测公网侧存在 0.05s~9s 的抖动（服务器上同时有大流量），
> 10s 会造成偶发假失败，进而误触发 nginx reload。超时仍按 FAIL 计入（符合"HTTP 超时即失败"约定）。

> 机器人判定只看 HTTP 200 + JSON `success:true`，**不看** `/status/` 里的 `alive`/`rooms` 残留：
> 历史房间与已退出机器人（alive:false、uptime 很大）是正常现象，不得据此判故障。

## 判定与恢复

- 分组连续失败 `FAIL_THRESHOLD=2` 次才动作；成功一次即把该组失败计数清零。
- backend 组失败 → `systemctl restart gxgen_server`
- bot 组失败 → `systemctl restart gxgenbot`
- client 组失败 → `systemctl restart gxgen_client`
- public 组失败：
  - 本地上游（backend/bot/client）同时异常 → 判定为上游故障，不操作 nginx；
  - 本地上游健康 → `nginx -t` 通过后 `systemctl reload nginx`，reload 失败再 `systemctl restart nginx`；
    `nginx -t` 不通过 → 放弃动作并记 ERROR（避免公网入口直接中断）。
- 同一服务动作后 `COOLDOWN_SECONDS=300` 秒冷却，冷却期内只记日志不重复动作。
- 每次动作后最多 ~10s 恢复验证（5 次 × 2s）并写日志。

## 用法 / 自测

```bash
# 正常单次执行（生产默认参数，需 root 才能写 /var/log 与执行重启）
sudo /home/gxwtf/gxwtf_generals/ops/gx-generals-healthcheck.sh --once

# dry-run：只检查/报告/演练判定，不执行任何 systemctl，不写冷却时间
# 注意：dry-run 仍会按检查结果持久化"连续失败次数"（便于在独立 STATE_DIR 下演练 1/2→2/2），
#       但不会写 last_restart（冷却时间），因此不会影响真实重启节奏。
sudo /home/gxwtf/gxwtf_generals/ops/gx-generals-healthcheck.sh --dry-run

# 把后端探针指向关闭端口，用独立状态目录验证「连续 2 次失败」逻辑（不影响生产）
sudo env STATE_DIR=/tmp/hc-sim LOG_FILE=/tmp/hc-sim.log \
     BACKEND_BASE_URL=http://127.0.0.1:39999 \
     /home/gxwtf/gxwtf_generals/ops/gx-generals-healthcheck.sh --dry-run
```

全部可用环境变量：见 `--help`。常用：`SERVER_PORT`、`BOT_PORT`、`CLIENT_PORT`、
`BACKEND_BASE_URL`、`BOT_BASE_URL`、`CLIENT_BASE_URL`、`PUBLIC_API_URL`、`PUBLIC_WEB_URL`、
`HTTP_TIMEOUT`、`PUBLIC_HTTP_TIMEOUT`、`FAIL_THRESHOLD`、`COOLDOWN_SECONDS`、
`STATE_DIR`、`LOG_FILE`、`SERVER_SERVICE`、`BOT_SERVICE`、`CLIENT_SERVICE`、`NGINX_SERVICE`
（`*_SERVICE` 仅用于自测时指向临时单元，生产保持默认）。

退出码：`0` 全部正常；`1` 有分组失败；`2` 本地环境问题（状态目录/日志不可写等）。

## 安装（在服务器上）

```bash
mkdir -p ~/gxwtf_generals/ops/systemd ~/gxwtf_generals/ops/logrotate
# 将本目录下 4 个文件放到对应位置（见上表）
chmod 755 ~/gxwtf_generals/ops/gx-generals-healthcheck.sh
sudo cp ~/gxwtf_generals/ops/systemd/gx-generals-healthcheck.service /etc/systemd/system/
sudo cp ~/gxwtf_generals/ops/systemd/gx-generals-healthcheck.timer   /etc/systemd/system/
sudo cp ~/gxwtf_generals/ops/logrotate/gx-generals-healthcheck       /etc/logrotate.d/
sudo systemctl daemon-reload
sudo systemctl enable --now gx-generals-healthcheck.timer
sudo systemctl start gx-generals-healthcheck.service   # 立即跑一轮（可选）
systemctl list-timers gx-generals-healthcheck.timer
```

## 排障

```bash
tail -50 /var/log/gx-generals-healthcheck.log
systemctl status gx-generals-healthcheck.service --no-pager
journalctl -u gx-generals-healthcheck.service -n 50 --no-pager
cat /var/lib/gx-generals-healthcheck/*.failures
cat /var/lib/gx-generals-healthcheck/*.last_action_at
logrotate -d /etc/logrotate.d/gx-generals-healthcheck   # 语法自检
```
