#!/usr/bin/env bash
# Install certbot pre/post/deploy hooks for myco.labxnow.ai:
#   - pre  hook: stop myco so certbot --standalone can bind :80
#   - deploy hook: copy renewed cert into /home/kkrazy/myco/.tls/
#   - post hook: start myco again (runs even if renewal fails)
# Run with sudo.
#
# Usage:  sudo ./install-renewal-hook.sh

set -euo pipefail

DOMAIN="myco.labxnow.ai"
TLS_DIR="/home/kkrazy/myco/.tls"
SERVICE="myco"
HOOKS_ROOT="/etc/letsencrypt/renewal-hooks"

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: must run as root (use sudo)." >&2
  exit 2
fi

mkdir -p "${HOOKS_ROOT}/pre" "${HOOKS_ROOT}/deploy" "${HOOKS_ROOT}/post"

# pre: free port 80 before the HTTP-01 challenge
cat > "${HOOKS_ROOT}/pre/myco.sh" <<EOF
#!/usr/bin/env bash
# Auto-installed — frees :80 for certbot --standalone.
set -euo pipefail
systemctl stop ${SERVICE}
EOF
chmod 755 "${HOOKS_ROOT}/pre/myco.sh"

# deploy: only fires when our cert was actually renewed (RENEWED_LINEAGE set)
cat > "${HOOKS_ROOT}/deploy/myco.sh" <<EOF
#!/usr/bin/env bash
# Auto-installed — copies renewed ${DOMAIN} cert into ${TLS_DIR}.
set -euo pipefail

[[ "\${RENEWED_LINEAGE:-}" == "/etc/letsencrypt/live/${DOMAIN}" ]] || exit 0

install -o kkrazy -g kkrazy -m 644 \\
  "\${RENEWED_LINEAGE}/fullchain.pem" "${TLS_DIR}/cert.pem"
install -o kkrazy -g kkrazy -m 600 \\
  "\${RENEWED_LINEAGE}/privkey.pem"   "${TLS_DIR}/key.pem"
EOF
chmod 755 "${HOOKS_ROOT}/deploy/myco.sh"

# post: restart myco regardless of renewal outcome (so a failed renewal
# doesn't leave the service down)
cat > "${HOOKS_ROOT}/post/myco.sh" <<EOF
#!/usr/bin/env bash
# Auto-installed — brings ${SERVICE} back up after the renewal attempt.
set -euo pipefail
systemctl start ${SERVICE}
EOF
chmod 755 "${HOOKS_ROOT}/post/myco.sh"

echo "Installed hooks:"
echo "  ${HOOKS_ROOT}/pre/myco.sh"
echo "  ${HOOKS_ROOT}/deploy/myco.sh"
echo "  ${HOOKS_ROOT}/post/myco.sh"
echo
echo "Dry-run test (will briefly stop and restart ${SERVICE}):"
certbot renew --dry-run --cert-name "${DOMAIN}"
