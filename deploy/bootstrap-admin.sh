#!/usr/bin/env bash
set -euo pipefail
umask 077

environment=${1:-}
email=${2:-}
case "$environment" in
    staging) database=finsight_staging; memory=448m ;;
    production) database=finsight; memory=640m ;;
    *) printf '사용법: %s <staging|production> <이메일>\n' "$0" >&2; exit 2 ;;
esac
[[ "$email" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$ ]]

cd "/opt/finsight/$environment"
exec 9>.release/deploy.lock
flock -w 120 9
grep -Eq '^FINSIGHT_ADMIN_MFA_KEY=[a-f0-9]{64}$' runtime.env
db=(docker exec -i finsight-data-postgres-1 psql -X -U postgres -d "$database" -v ON_ERROR_STOP=1)
if [[ $("${db[@]}" -Atc 'SELECT count(*) FROM admin_account' </dev/null) != 0 ]]; then
    printf '관리자 계정이 이미 있습니다. 초기화를 중단합니다.\n' >&2
    exit 1
fi

if [[ -t 0 ]]; then
    read -rsp '새 관리자 비밀번호 (12~128자, 줄바꿈 제외): ' password
    printf '\n'
    read -rsp '새 비밀번호 확인: ' confirmation
    printf '\n'
    if [[ "$password" != "$confirmation" ]]; then
        printf '두 비밀번호가 다릅니다. 다시 실행해 주세요.\n' >&2
        exit 1
    fi
    seed=$(openssl rand 20 | base32 | tr -d '\n')
elif [[ "$environment" == staging ]]; then
    read -r password
    read -r seed
else
    printf '운영 최초 계정은 대화형 터미널에서 설정해야 합니다.\n' >&2
    exit 1
fi
if [[ ${#password} -lt 12 || ${#password} -gt 128 || ! "$seed" =~ ^[A-Z2-7]{32}$ ]]; then
    printf '비밀번호 길이 또는 인증 앱 키 형식을 확인해 주세요.\n' >&2
    exit 1
fi

credentials=$(mktemp /dev/shm/finsight-admin.XXXXXXXX)
trap 'unlink "$credentials"' EXIT
printf 'FINSIGHT_BOOTSTRAP_ADMIN_EMAIL=%s\nFINSIGHT_BOOTSTRAP_ADMIN_PASSWORD=%s\nFINSIGHT_BOOTSTRAP_ADMIN_TOTP=%s\n' \
    "$email" "$password" "$seed" >"$credentials"
unset password confirmation
read -r image <.release/current-image
container="finsight-$environment-admin-bootstrap"
trap 'docker stop "$container" >/dev/null 2>&1 || true; unlink "$credentials"' EXIT

# Wait until the web application's bootstrap transaction commits, then stop this instance.
docker run --detach --rm --name "$container" --network finsight-data \
    --memory "$memory" --env-file runtime.env --env-file "$credentials" \
    -e SPRING_PROFILES_ACTIVE=local -e FINSIGHT_POLICY_PREVIEW=false \
    -e FINSIGHT_ADMIN_BOOTSTRAP=true -e FINSIGHT_FCM_ENABLED=false -e FINSIGHT_DISCORD_ENABLED=false \
    "$image" >/dev/null
for attempt in {1..60}; do
    if [[ $("${db[@]}" -Atc 'SELECT count(*) FROM admin_account' </dev/null) == 1 ]]; then
        break
    fi
    # The image uses docker run --rm, so an early exit removes the container.
    if ! docker inspect "$container" >/dev/null 2>&1; then
        printf '관리자 초기화 컨테이너가 중단됐습니다.\n' >&2
        exit 1
    fi
    sleep 2
done
docker stop "$container" >/dev/null

"${db[@]}" --set="admin_email=$email" <<'SQL'
BEGIN;
SELECT id AS admin_id FROM admin_account WHERE email=:'admin_email' AND status='ACTIVE' \gset
WITH roles AS (
    INSERT INTO admin_role (admin_id, role)
    VALUES (:'admin_id', 'OPERATOR'), (:'admin_id', 'ANALYST')
    RETURNING role
)
INSERT INTO audit_log (id, actor_id, roles, action, target_type, target_id, result, changes_safe, trace_id)
SELECT gen_random_uuid(), :'admin_id', ARRAY['SUPER_ADMIN','OPERATOR','ANALYST'],
    'ADMIN_BOOTSTRAPPED', 'ADMIN_ACCOUNT', :'admin_id', 'SUCCESS',
    jsonb_build_object('source', 'SERVER_CONSOLE', 'roles', array_agg(role ORDER BY role)), gen_random_uuid()
FROM roles;
COMMIT;
SQL

if [[ -t 0 ]]; then
    printf '인증 앱에 FINSIGHT 항목을 추가하세요 (시간 기반, 30초, SHA-1, 6자리).\nTOTP 키: %s\n' "$seed"
fi
