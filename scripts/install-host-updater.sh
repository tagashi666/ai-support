#!/usr/bin/env bash
# Однократная установка ограниченного systemd-исполнителя обновлений.
set -euo pipefail
umask 077

[[ "${EUID:-$(id -u)}" == 0 ]] || {
  echo "Запусти от root: sudo scripts/install-host-updater.sh" >&2
  exit 1
}

PROJECT_ROOT="$(readlink -f -- "${1:-$(cd "$(dirname "$0")/.." && pwd)}")"
[[ "$PROJECT_ROOT" =~ ^/[0-9A-Za-z._/-]+$ && "$PROJECT_ROOT" != / && -f "$PROJECT_ROOT/docker-compose.yml" ]] || {
  echo "Некорректный каталог проекта: $PROJECT_ROOT" >&2
  exit 1
}
for command in install sed systemctl; do
  command -v "$command" >/dev/null || { echo "Не найдена команда: $command" >&2; exit 1; }
done

install -d -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$PROJECT_ROOT/scripts/host-updater.sh" \
  /usr/local/libexec/ai-support-host-updater
install -o root -g root -m 0755 "$PROJECT_ROOT/scripts/source-updater.sh" \
  /usr/local/libexec/ai-support-source-updater
install -d -o root -g root -m 0700 /var/lib/ai-support-updater /var/backups/ai-support
mkdir -p "$PROJECT_ROOT/data"

service_tmp="$(mktemp)"
path_tmp="$(mktemp)"
source_service_tmp="$(mktemp)"
source_path_tmp="$(mktemp)"
trap 'rm -f -- "$service_tmp" "$path_tmp" "$source_service_tmp" "$source_path_tmp"' EXIT
sed "s|@PROJECT_ROOT@|$PROJECT_ROOT|g" "$PROJECT_ROOT/deploy/ai-support-updater.service" > "$service_tmp"
sed "s|@PROJECT_ROOT@|$PROJECT_ROOT|g" "$PROJECT_ROOT/deploy/ai-support-updater.path" > "$path_tmp"
sed "s|@PROJECT_ROOT@|$PROJECT_ROOT|g" "$PROJECT_ROOT/deploy/ai-support-source-updater.service" > "$source_service_tmp"
sed "s|@PROJECT_ROOT@|$PROJECT_ROOT|g" "$PROJECT_ROOT/deploy/ai-support-source-updater.path" > "$source_path_tmp"
install -o root -g root -m 0644 "$service_tmp" /etc/systemd/system/ai-support-updater.service
install -o root -g root -m 0644 "$path_tmp" /etc/systemd/system/ai-support-updater.path
install -o root -g root -m 0644 "$source_service_tmp" /etc/systemd/system/ai-support-source-updater.service
install -o root -g root -m 0644 "$source_path_tmp" /etc/systemd/system/ai-support-source-updater.path

systemctl daemon-reload
systemctl enable --now ai-support-updater.path
systemctl enable --now ai-support-source-updater.path
if [[ -f "$PROJECT_ROOT/data/update-request.json" ]]; then
  systemctl start ai-support-updater.service
fi
if [[ -f "$PROJECT_ROOT/data/source-request.json" ]]; then
  systemctl start ai-support-source-updater.service
fi
echo "Host-updater установлен; запросы из панели будут выполняться автоматически."
