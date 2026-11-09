#!/usr/bin/env bash
# Собирает архив для сервера. Главное здесь — MANIFEST: по нему установщик
# удаляет файлы, которых в новой версии больше нет. Без него распаковка
# поверх оставляет мусор от прошлых раскладок, и сборка падает на конфликте.
set -euo pipefail
cd "$(dirname "$0")/.."

{
  find src scripts public deploy interface-kb web -type f \
    -not -path 'web/dist/*' -not -path 'web/node_modules/*' 2>/dev/null
  printf '%s\n' tsconfig.web.json
  printf '%s\n' kb/00-подключение.md kb/00-прокси-telegram.md kb/10-подписка.md kb/20-устройства.md kb/30-скорость.md
} | sed 's|^\./||' | LC_ALL=C sort > MANIFEST
echo "MANIFEST: $(wc -l < MANIFEST) файлов"

project="$(basename "$PWD")"
artifact_dir="${ARTIFACT_DIR:-$PWD/release}"
mkdir -p "$artifact_dir"
archive="$artifact_dir/ai-support.tar.gz"
files=(
  .dockerignore .env.example .gitignore
  ARCHITECTURE.md DEPLOY.md Dockerfile MANIFEST PROVIDERS.md README.md SECURITY.md
  docker-compose.yml install.sh package.json package-lock.json
  tsconfig.json tsconfig.build.json tsconfig.web.json
  deploy public scripts src web
  interface-kb
  kb/00-подключение.md kb/00-прокси-telegram.md kb/10-подписка.md kb/20-устройства.md kb/30-скорость.md
)
for optional in LICENSE CHANGELOG.md CONTRIBUTING.md .github .gitattributes; do
  [[ -e "$optional" ]] && files+=("$optional")
done
prefixed=()
for file in "${files[@]}"; do prefixed+=("$project/$file"); done

# Явный allowlist вместо архивации всего каталога: рабочий .env, база,
# вложения, локальные настройки агентов и прочие секреты сюда не попадут.
# Собранная новая панель (web/dist) в архив не входит: образ собирает её сам.
tar -czf "$archive" --exclude="$project/web/dist" --exclude="$project/web/node_modules" -C .. "${prefixed[@]}"
echo "Готово: $archive"
(
  cd "$artifact_dir"
  sha256sum ai-support.tar.gz > ai-support.tar.gz.sha256
)
echo "SHA-256: $artifact_dir/ai-support.tar.gz.sha256"
