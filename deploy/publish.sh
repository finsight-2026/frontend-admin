#!/usr/bin/env bash
set -euo pipefail

environment=${1:-}
archive=${2:-}
case "$environment" in
    staging|production) ;;
    *) printf '사용법: %s <staging|production> <dist.tar.gz>\n' "$0" >&2; exit 2 ;;
esac
test -f "$archive"

data=$(docker volume inspect --format '{{.Mountpoint}}' finsight-proxy_caddy-data)
root="$data/finsight-admin/$environment"
install -d -m 755 "$root/releases"
exec 9>"$root/.publish.lock"
flock 9

release=$(sha256sum "$archive" | cut -d ' ' -f 1)
pending=$(mktemp -d "$root/.pending.XXXXXXXX")
trap 'rm -rf -- "$pending"' EXIT

if [[ ! -d "$root/releases/$release" ]]; then
    mkdir -m 755 "$pending/dist"
    tar --extract --gzip --file "$archive" --directory "$pending/dist" --no-same-owner
    test -s "$pending/dist/index.html"
    test -d "$pending/dist/assets"
    mv "$pending/dist" "$root/releases/$release"
fi

install -d -m 755 "$root/shared/assets"
for asset in "$root/releases"/*/assets/*; do
    [[ -f "$asset" && ! -L "$asset" ]] || continue
    target="$root/shared/assets/${asset##*/}"
    if [[ -e "$target" && ! "$asset" -ef "$target" ]]; then
        if ! cmp -s "$asset" "$target"; then
            printf '해시 자산 이름이 충돌합니다: %s\n' "${asset##*/}" >&2
            exit 1
        fi
    elif [[ ! -e "$target" ]]; then
        ln -- "$asset" "$target"
    fi
done

previous=$(readlink "$root/current" || true)
if [[ -n "$previous" && "$previous" != "releases/$release" ]]; then
    ln -s "$previous" "$pending/previous"
    mv -Tf "$pending/previous" "$root/previous"
fi
ln -s "releases/$release" "$pending/current"
mv -Tf "$pending/current" "$root/current"
printf '%s %s\n' "$environment" "$release"
