#!/usr/bin/env bash
# VibeDock Ubuntu/Debian Bare-Metal Server Bootstrap Script
# Automatically installs missing base dependencies (Node.js 22+, Caddy, SSHD, PM2, uv, rsync, zip),
# creates the restricted deployment user (`vibe-deploy`), configures sudoers whitelist,
# authorizes the generated SSH key, and wires Caddy reverse-proxy site imports.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VIBEDOCK_HOME="${VIBEDOCK_HOME:-/var/lib/vibedock}"
DEPLOY_USER="${VIBEDOCK_DEPLOY_USER:-vibe-deploy}"
DEPLOY_HOME="${VIBEDOCK_HOME}/deploy"
APPS_DIR="${VIBEDOCK_APPS_DIR:-${VIBEDOCK_HOME}/apps}"
CADDY_SITES_DIR="${VIBEDOCK_CADDY_SITES_DIR:-${VIBEDOCK_HOME}/caddy/sites}"
CADDY_MAIN_CONFIG="${VIBEDOCK_CADDY_CONFIG:-/etc/caddy/Caddyfile}"
NGINX_SITES_DIR="${VIBEDOCK_NGINX_SITES_DIR:-${VIBEDOCK_HOME}/nginx/sites}"
KEY_PUB="${VIBEDOCK_HOME}/keys/deploy_key.pub"
CONFIG_FILE="${VIBEDOCK_HOME}/vibedock.config.json"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 sudo 运行此脚本：sudo bash scripts/setup-ubuntu-host.sh"
  exit 1
fi

USE_NGINX=0
if command -v systemctl &>/dev/null && systemctl is-active --quiet nginx && ! systemctl is-active --quiet caddy; then
  USE_NGINX=1
fi

echo "==> [1/5] 检查并安装 Ubuntu 系统基础组件 (SSHD / 网关 / rsync / zip / cron)"
NEED_APT=0
PKGS="curl ca-certificates gnupg openssh-server zip unzip rsync cron"
CHECK_LIST="sshd:openssh-server rsync:rsync zip:zip unzip:unzip curl:curl gpg:gnupg crontab:cron"
if [[ "${USE_NGINX}" -eq 0 ]]; then
  PKGS="${PKGS} caddy"
  CHECK_LIST="${CHECK_LIST} caddy:caddy"
fi

for pkg_cmd in ${CHECK_LIST}; do
  cmd_name="${pkg_cmd%%:*}"
  if ! command -v "${cmd_name}" &>/dev/null && [[ ! -x "/usr/sbin/${cmd_name}" ]]; then
    NEED_APT=1
    break
  fi
done

if [[ "${NEED_APT}" -eq 1 ]] && command -v apt-get &>/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # shellcheck disable=SC2086
  apt-get install -y -qq ${PKGS}
fi
systemctl enable --now cron 2>/dev/null || service cron start 2>/dev/null || true

if ! command -v node &>/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  echo "    正在安装 Node.js 22 LTS..."
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

NODE_BIN="$(command -v node)"

if [[ -n "${1:-}" ]] && [[ -f "${1}" ]]; then
  echo "    正在全局安装 VibeDock CLI 包 (${1})..."
  npm install -g "${1}" --no-audit --no-fund
  GLOBAL_VD="$(npm root -g)/vibedock"
  if [[ -f "${GLOBAL_VD}/dist/cli/main.js" ]]; then
    ROOT_DIR="${GLOBAL_VD}"
  fi
elif [[ ! -f "${ROOT_DIR}/dist/cli/main.js" ]] && command -v npm &>/dev/null; then
  GLOBAL_VD="$(npm root -g)/vibedock"
  if [[ -f "${GLOBAL_VD}/dist/cli/main.js" ]]; then
    ROOT_DIR="${GLOBAL_VD}"
  fi
fi

if command -v systemctl &>/dev/null; then
  systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || true
  if [[ "${USE_NGINX}" -eq 0 ]]; then
    systemctl enable --now caddy 2>/dev/null || true
  fi
fi

echo "==> [2/5] 初始化统一资产目录 ${VIBEDOCK_HOME} 与受限部署账号 ${DEPLOY_USER}"
mkdir -p "${VIBEDOCK_HOME}" "${DEPLOY_HOME}/.ssh" "${APPS_DIR}" "${CADDY_SITES_DIR}" "${NGINX_SITES_DIR}" "${VIBEDOCK_HOME}/certs" "${VIBEDOCK_HOME}/databases"
mkdir -p -m 700 "${VIBEDOCK_HOME}/keys" "${VIBEDOCK_HOME}/secrets" "${VIBEDOCK_HOME}/secrets/databases"
chmod 700 "${VIBEDOCK_HOME}/keys" "${VIBEDOCK_HOME}/secrets" "${VIBEDOCK_HOME}/secrets/databases"
chmod 755 "${VIBEDOCK_HOME}" "${VIBEDOCK_HOME}/caddy" "${CADDY_SITES_DIR}" "${VIBEDOCK_HOME}/nginx" "${NGINX_SITES_DIR}" "${VIBEDOCK_HOME}/certs"

if [[ ! -f "${VIBEDOCK_HOME}/catalog.json" ]] && [[ -f "${ROOT_DIR}/data/catalog.json" ]]; then
  cp "${ROOT_DIR}/data/catalog.json" "${VIBEDOCK_HOME}/catalog.json"
  chmod 644 "${VIBEDOCK_HOME}/catalog.json"
fi

if ! id "${DEPLOY_USER}" &>/dev/null; then
  useradd -m -d "${DEPLOY_HOME}" -s /bin/bash "${DEPLOY_USER}"
else
  usermod -d "${DEPLOY_HOME}" "${DEPLOY_USER}" 2>/dev/null || true
fi

chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_HOME}" "${APPS_DIR}"
chmod 755 "${DEPLOY_HOME}" "${APPS_DIR}"
chmod 700 "${DEPLOY_HOME}/.ssh"

if [[ -f "${KEY_PUB}" ]]; then
  cp "${KEY_PUB}" "${DEPLOY_HOME}/.ssh/authorized_keys"
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_HOME}/.ssh/authorized_keys"
  chmod 600 "${DEPLOY_HOME}/.ssh/authorized_keys"
  echo "    已写入专用部署公钥: ${KEY_PUB}"
else
  echo "    提示: 未找到 ${KEY_PUB}，稍后运行 vibedock init 将自动生成并写入密钥"
fi

echo "==> [3/5] 检查并安装 Python uv 与 PM2 进程守护"
if ! command -v uv &>/dev/null; then
  echo "    正在安装 uv (Python 极速包与虚拟环境管理器)..."
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="/usr/local/bin" sh
fi
if ! command -v pm2 &>/dev/null && command -v npm &>/dev/null; then
  echo "    正在全局安装 PM2..."
  npm install -g pm2 --no-audit --no-fund
fi

echo "==> [4/5] 安装受控 CLI 包装脚本与 sudoers 规则 (/etc/sudoers.d/vibedock)"
cat >/usr/local/bin/vibedock-publish <<EOF
#!/usr/bin/env bash
export VIBEDOCK_HOME="${VIBEDOCK_HOME}"
exec "${NODE_BIN}" "${ROOT_DIR}/dist/cli/main.js" publish "\$@"
EOF
chmod 755 /usr/local/bin/vibedock-publish

cat >/usr/local/bin/vibedock-db-provision <<EOF
#!/usr/bin/env bash
set -euo pipefail
export VIBEDOCK_HOME="${VIBEDOCK_HOME}"
SUBCMD="\${1:-status}"
case "\${SUBCMD}" in
  status|get|provision|bind|verify)
    exec "${NODE_BIN}" "${ROOT_DIR}/dist/cli/main.js" db "\$@"
    ;;
  *)
    echo '{"ok":false,"error":"Subcommand not allowed for deploy user (allowed: status|get|provision|bind|verify)"}' >&2
    exit 1
    ;;
esac
EOF
chmod 755 /usr/local/bin/vibedock-db-provision

cat >/etc/sudoers.d/vibedock <<EOF
Defaults:${DEPLOY_USER} !requiretty
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/local/bin/vibedock-publish
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/local/bin/vibedock-db-provision *
EOF
chmod 440 /etc/sudoers.d/vibedock
visudo -cf /etc/sudoers.d/vibedock

echo "==> [5/5] 配置网关站点导入与门户反向代理"
if [[ "${USE_NGINX}" -eq 1 ]]; then
  echo "    检测到本机已有 Nginx 正在运行，采用非侵入式 Nginx drop-in 模式 (${NGINX_SITES_DIR})..."
  "${NODE_BIN}" -e "
const fs = require('fs');
let domain = '127.0.0.1.nip.io';
let tlsLines = '';
try {
  const cfg = JSON.parse(fs.readFileSync('${CONFIG_FILE}', 'utf8'));
  domain = cfg.primaryDomain || domain;
  if (cfg.domainMode === 'custom' && cfg.tls && cfg.tls.certFile && cfg.tls.keyFile) {
    tlsLines = '    listen 443 ssl;\n    ssl_certificate ' + cfg.tls.certFile + ';\n    ssl_certificate_key ' + cfg.tls.keyFile + ';\n';
  }
} catch {}
const content = '# Managed by VibeDock (Portal Reverse Proxy)\nserver {\n    listen 80;\n' + tlsLines + '    server_name portal.' + domain + ' services.' + domain + ';\n    location / {\n        proxy_pass http://127.0.0.1:39090;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade \$http_upgrade;\n        proxy_set_header Connection \"upgrade\";\n        proxy_set_header Host \$host;\n        proxy_set_header X-Real-IP \$remote_addr;\n        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto \$scheme;\n    }\n}\n';
fs.writeFileSync('${NGINX_SITES_DIR}/00-vibedock-portal.conf', content, 'utf8');
"
  if [[ -d /etc/nginx/conf.d ]]; then
    printf "# Managed by VibeDock\ninclude %s/*.conf;\n" "${NGINX_SITES_DIR}" > /etc/nginx/conf.d/vibedock.conf
  fi
  if command -v nginx &>/dev/null; then
    nginx -t && nginx -s reload || true
  fi
else
  "${NODE_BIN}" -e "
const fs = require('fs');
let hostLine = 'http://portal.127.0.0.1.nip.io';
let tlsLine = '';
try {
  const cfg = JSON.parse(fs.readFileSync('${CONFIG_FILE}', 'utf8'));
  const domain = cfg.primaryDomain || '127.0.0.1.nip.io';
  const mode = cfg.domainMode || 'nip';
  const scheme = mode === 'nip' ? 'http' : 'https';
  hostLine = scheme + '://portal.' + domain + ', ' + scheme + '://services.' + domain;
  if (mode === 'custom' && cfg.tls && cfg.tls.certFile && cfg.tls.keyFile) {
    tlsLine = '  tls ' + cfg.tls.certFile + ' ' + cfg.tls.keyFile + '\n';
  }
} catch {}
const content = '# Managed by VibeDock (Portal Reverse Proxy)\n' + hostLine + ' {\n' + tlsLine + '  reverse_proxy 127.0.0.1:39090\n}\n';
fs.writeFileSync('${CADDY_SITES_DIR}/00-vibedock-portal.caddy', content, 'utf8');
"

  if [[ -d "$(dirname "${CADDY_MAIN_CONFIG}")" ]]; then
    IMPORT_LINE="import ${CADDY_SITES_DIR}/*.caddy"
    if [[ -f "${CADDY_MAIN_CONFIG}" ]]; then
      sed -i.bak '/data\/caddy\/sites\/\*\.caddy/d' "${CADDY_MAIN_CONFIG}" && rm -f "${CADDY_MAIN_CONFIG}.bak"
    fi
    if [[ ! -f "${CADDY_MAIN_CONFIG}" ]] || ! grep -Fq "${IMPORT_LINE}" "${CADDY_MAIN_CONFIG}"; then
      printf "\n# VibeDock managed sites\n%s\n" "${IMPORT_LINE}" >> "${CADDY_MAIN_CONFIG}"
    fi
    if command -v caddy &>/dev/null; then
      caddy reload --config "${CADDY_MAIN_CONFIG}" || true
    fi
  fi
fi

echo "==> 完成！Ubuntu 生产底座、受限部署账号 ${DEPLOY_USER} 与网关路由入口已全部就绪。"
