#!/usr/bin/env bash
set -euo pipefail
umask 077

environment=${1:-}
case "$environment" in
    staging) port=18081; memory=448m; origin=https://localhost:18443 ;;
    production) port=18080; memory=640m; origin=https://admin.finsight.life ;;
    *) printf '사용법: %s <staging|production>\n' "$0" >&2; exit 2 ;;
esac

cd "/opt/finsight/$environment"
exec 9>.release/deploy.lock
flock -w 120 9

export FINSIGHT_LOCAL_PORT=$port FINSIGHT_BACKEND_MEMORY=$memory
read -r FINSIGHT_BACKEND_IMAGE <.release/current-image
export FINSIGHT_BACKEND_IMAGE
compose=(docker compose --project-name "finsight-$environment" -f compose.yaml)

pending=$(mktemp runtime.env.XXXXXXXX)
trap 'if [[ -f "$pending" ]]; then unlink "$pending"; fi' EXIT
sed '/^FINSIGHT_ADMIN_ORIGIN=/d; /^[[:space:]]*$/d' runtime.env >"$pending"
if ! grep -q '^FINSIGHT_ADMIN_MFA_KEY=' "$pending"; then
    printf 'FINSIGHT_ADMIN_MFA_KEY=%s\n' "$(openssl rand -hex 32)" >>"$pending"
fi
printf 'FINSIGHT_ADMIN_ORIGIN=%s\n' "$origin" >>"$pending"
if cmp -s runtime.env "$pending"; then
    exit 0
fi

cp -p runtime.env runtime.env.pre-admin
chown --reference=runtime.env "$pending"
chmod --reference=runtime.env "$pending"
mv -T "$pending" runtime.env
if ! "${compose[@]}" up -d --wait --wait-timeout 120 backend; then
    cp -p runtime.env.pre-admin runtime.env
    "${compose[@]}" up -d --wait --wait-timeout 120 backend
    exit 1
fi
