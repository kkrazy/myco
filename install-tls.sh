#!/usr/bin/env bash
# Issue a Let's Encrypt cert for myco.labxnow.ai and install it into
# /home/kkrazy/myco/.tls/. Run with sudo.
#
# Usage:  sudo EMAIL=you@example.com ./install-tls.sh
#    or:  sudo ./install-tls.sh you@example.com

set -euo pipefail

DOMAIN="myco.labxnow.ai"
TLS_DIR="/home/kkrazy/myco/.tls"
LE_DIR="/etc/letsencrypt/live/${DOMAIN}"
OWNER="kkrazy:kkrazy"
SERVICE="myco"

EMAIL="${EMAIL:-${1:-}}"
if [[ -z "${EMAIL}" ]]; then
  echo "ERROR: provide an email (for Let's Encrypt renewal notices)." >&2
  echo "  sudo EMAIL=you@example.com $0" >&2
  echo "  sudo $0 you@example.com" >&2
  exit 2
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: must run as root (use sudo)." >&2
  exit 2
fi

echo "==> Installing certbot (if missing)"
if ! command -v certbot >/dev/null; then
  apt-get update -qq
  apt-get install -y certbot
fi

ts=$(date +%Y%m%d-%H%M%S)
backup="${TLS_DIR}.bak.${ts}"
echo "==> Backing up current ${TLS_DIR} -> ${backup}"
cp -a "${TLS_DIR}" "${backup}"

echo "==> Stopping ${SERVICE} so certbot can bind :80"
systemctl stop "${SERVICE}"

cleanup() {
  if ! systemctl is-active --quiet "${SERVICE}"; then
    echo "==> Restarting ${SERVICE}"
    systemctl start "${SERVICE}" || true
  fi
}
trap cleanup EXIT

echo "==> Requesting certificate for ${DOMAIN}"
certbot certonly --standalone \
  --non-interactive --agree-tos \
  -m "${EMAIL}" \
  -d "${DOMAIN}"

echo "==> Installing cert + key into ${TLS_DIR}"
install -o "${OWNER%:*}" -g "${OWNER#*:}" -m 644 \
  "${LE_DIR}/fullchain.pem" "${TLS_DIR}/cert.pem"
install -o "${OWNER%:*}" -g "${OWNER#*:}" -m 600 \
  "${LE_DIR}/privkey.pem"   "${TLS_DIR}/key.pem"

echo "==> Starting ${SERVICE}"
systemctl start "${SERVICE}"
trap - EXIT

sleep 1
systemctl is-active --quiet "${SERVICE}" \
  && echo "==> ${SERVICE} is active" \
  || { echo "ERROR: ${SERVICE} did not start; check 'journalctl -u ${SERVICE}'" >&2; exit 1; }

echo "==> Verifying live cert"
echo | openssl s_client -connect "${DOMAIN}:443" -servername "${DOMAIN}" 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates

echo
echo "Done. Backup of old TLS dir: ${backup}"
