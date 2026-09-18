#!/bin/sh
set -eu

if [ -z "${ASAMI_FRONTEND_PASSWORD:-}" ]; then
  echo "ASAMI_FRONTEND_PASSWORD is required; refusing to start without access protection." >&2
  exit 1
fi

hash="$(openssl passwd -apr1 "$ASAMI_FRONTEND_PASSWORD")"
printf 'asami:%s\n' "$hash" > /etc/nginx/.htpasswd

# Nginx workers run as the nginx user on the official Alpine image.
# Keep the credentials file private while allowing the workers to read it.
chown nginx:nginx /etc/nginx/.htpasswd
chmod 600 /etc/nginx/.htpasswd

exec nginx -g 'daemon off;'
