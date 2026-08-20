#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

before="$(sha256sum MANIFEST | cut -d' ' -f1)"
bash scripts/pack.sh >/dev/null
after="$(sha256sum MANIFEST | cut -d' ' -f1)"
archive="release/ai-support.tar.gz"
project="$(basename "$PWD")"

if [[ "$before" != "$after" ]]; then
  printf 'MANIFEST устарел: выполните npm run pack и добавьте изменения.\n' >&2
  exit 1
fi

listing="$(tar -tzf "$archive")"

if grep -Eq '/(\.env|data|node_modules|dist|\.git|\.agents|\.codex)(/|$)' <<<"$listing"; then
  printf 'В релизном архиве обнаружены приватные или генерируемые файлы.\n' >&2
  exit 1
fi

grep -Fxq "$project/.env.example" <<<"$listing"
grep -Fxq "$project/LICENSE" <<<"$listing"
grep -Fxq "$project/public/ui.css" <<<"$listing"

printf 'Release archive is safe: %s\n' "$archive"
