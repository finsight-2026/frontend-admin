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
if [[ ! -e .release/deploy.lock ]]; then
    # The root-run configuration and the CI deployment must share this lock.
    runuser -u finsight-deploy -- touch .release/deploy.lock
fi
exec 9<>.release/deploy.lock
flock -w 120 9

export FINSIGHT_LOCAL_PORT=$port FINSIGHT_BACKEND_MEMORY=$memory
read -r FINSIGHT_BACKEND_IMAGE <.release/current-image
export FINSIGHT_BACKEND_IMAGE
compose=(docker compose --project-name "finsight-$environment" -f compose.yaml)

pending=$(mktemp runtime.env.XXXXXXXX)
trap 'if [[ -f "$pending" ]]; then unlink "$pending"; fi' EXIT
sed '/^FINSIGHT_ADMIN_ORIGIN=/d; /^[[:space:]]*$/d' runtime.env >"$pending"
for name in FINSIGHT_ADMIN_MFA_KEY FINSIGHT_ADMIN_NOTE_KEY FINSIGHT_ADMIN_PII_KEY; do
    if grep -q "^${name}=" "$pending"; then
        if [[ $(grep -c "^${name}=" "$pending") != 1 ]] ||
            ! grep -Eq "^${name}=[0-9a-fA-F]{64}$" "$pending"; then
            printf '관리자 암호화 키 설정을 확인해 주세요 (%s).\n' "$name" >&2
            exit 1
        fi
    else
        key=$(openssl rand -hex 32)
        printf '%s=%s\n' "$name" "$key" >>"$pending"
        unset key
    fi
done
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
