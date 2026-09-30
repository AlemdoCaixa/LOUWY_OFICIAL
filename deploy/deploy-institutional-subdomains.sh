#!/usr/bin/env bash
set -Eeuo pipefail

stamp="${1:?Informe o timestamp da release}"
archive="/opt/louwy/louwy-${stamp}-institutional-subdomains.tar.gz"
new_release="/opt/louwy/releases/${stamp}-institutional-subdomains"
old_release="$(readlink -f /opt/louwy/current)"
backup_dir="/root/migration-louwy-20260927"
nginx_file="/etc/nginx/sites-available/louwy.com.br"
nginx_backup="$backup_dir/louwy.com.br-before-subdomains-${stamp}.nginx"
db_backup="$backup_dir/louwy-before-subdomains-${stamp}.dump"

mkdir -p "$backup_dir" "$new_release"
test -s "$archive"
cp -a "$nginx_file" "$nginx_backup"
sudo -u postgres pg_dump -Fc louwy > "$db_backup"
tar -xzf "$archive" -C "$new_release"

node_modules_target="$(readlink -f "$old_release/node_modules")"
test -d "$node_modules_target"
ln -s "$node_modules_target" "$new_release/node_modules"
rm -rf "$new_release/server/data" "$new_release/server/models"
ln -s /opt/louwy/shared/data "$new_release/server/data"
ln -s /opt/louwy/shared/models "$new_release/server/models"
chown -R root:root "$new_release"

rollback() {
  echo "ROLLBACK" >&2
  ln -sfn "$old_release" /opt/louwy/current
  cp -a "$nginx_backup" "$nginx_file"
  nginx -t && systemctl reload nginx || true
  systemctl restart louwy || true
}
trap rollback ERR

cp -a "$new_release/deploy/louwy-production.nginx" "$nginx_file"
nginx -t
ln -sfn "$new_release" /opt/louwy/current
systemctl restart louwy

for _ in $(seq 1 25); do
  if curl -fsS http://127.0.0.1:5174/api/health >/tmp/louwy-health.json; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:5174/api/health
systemctl reload nginx

root_branding="$(curl -kfsS --resolve louwy.com.br:443:127.0.0.1 https://louwy.com.br/api/branding)"
primicias_context="$(curl -kfsS --resolve primicias.louwy.com.br:443:127.0.0.1 https://primicias.louwy.com.br/api/church-context)"
node -e 'const value=JSON.parse(process.argv[1]); if(!value.institutional||value.organizationName!=="Louwy") process.exit(1)' "$root_branding"
node -e 'const value=JSON.parse(process.argv[1]); if(value.church?.slug!=="primicias"||!value.explicit) process.exit(1)' "$primicias_context"

trap - ERR
printf '\nDEPLOY_OK\nold=%s\nnew=%s\n' "$old_release" "$new_release"
printf 'root=%s\nprimicias=%s\n' "$root_branding" "$primicias_context"
