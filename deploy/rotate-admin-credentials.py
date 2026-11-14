#!/usr/bin/env python3
"""Rotate a suspended administrator's credentials from the Vultr console."""

import base64
import getpass
import hashlib
from pathlib import Path
import re
import secrets
import subprocess
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


environment, email = sys.argv[1:]
database = {"staging": "finsight_staging", "production": "finsight"}[environment]
if not re.fullmatch(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", email):
    sys.exit("관리자 이메일을 확인해 주세요.")
if not sys.stdin.isatty():
    sys.exit("대화형 터미널에서 실행해 주세요.")

password = getpass.getpass("새 관리자 비밀번호 (20~128자): ")
confirmation = getpass.getpass("새 비밀번호 확인: ")
if password != confirmation or not 20 <= len(password) <= 128:
    sys.exit("두 비밀번호와 길이를 확인해 주세요.")

env = Path(f"/opt/finsight/{environment}/runtime.env").read_text()
match = re.search(r"^FINSIGHT_ADMIN_MFA_KEY=([a-f0-9]{64})$", env, re.M)
if not match:
    sys.exit("기존 관리자 MFA 암호화 키를 확인해 주세요.")

# Spring Security defaultsForSpringSecurity_v5_8 and backend AdminTotp.
salt = secrets.token_bytes(16)
derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000, dklen=32)
password_hash = (salt + derived).hex()
del password, confirmation
seed = secrets.token_bytes(20)
nonce = secrets.token_bytes(12)
encrypted = (nonce + AESGCM(bytes.fromhex(match[1])).encrypt(nonce, seed, None)).hex()

sql = r"""
BEGIN;
SELECT id AS admin_id FROM admin_account
WHERE email=:'email' AND status='SUSPENDED' FOR UPDATE \gset
UPDATE admin_account SET password_hash=:'password_hash', totp_secret_encrypted=decode(:'encrypted','hex'),
    status='ACTIVE', last_totp_step=-1, mfa_blocked_until=NULL, mfa_reauth_failures=0,
    session_version=session_version+1, version=version+1 WHERE id=:'admin_id';
DELETE FROM admin_session WHERE admin_id=:'admin_id';
DELETE FROM admin_auth_challenge WHERE admin_id=:'admin_id';
DELETE FROM admin_recovery_code WHERE admin_id=:'admin_id';
DELETE FROM admin_invitation WHERE admin_id=:'admin_id';
DELETE FROM admin_password_reset WHERE admin_id=:'admin_id';
DELETE FROM admin_login_failure WHERE email=:'email';
INSERT INTO audit_log (id,actor_id,roles,action,target_type,target_id,result,changes_safe,trace_id)
VALUES (gen_random_uuid(), :'admin_id', ARRAY[]::text[], 'ADMIN_CREDENTIALS_ROTATED', 'ADMIN_ACCOUNT', :'admin_id',
        'SUCCESS', '{"source":"SERVER_CONSOLE"}'::jsonb, gen_random_uuid());
COMMIT;
"""
# Send encoded credentials through stdin so they stay out of process arguments.
variables = f"\\set email '{email}'\n\\set password_hash '{password_hash}'\n\\set encrypted '{encrypted}'\n"
subprocess.run(
    ["docker", "exec", "-i", "finsight-data-postgres-1", "psql", "-X", "-q", "-U", "postgres", "-d", database,
     "-v", "ON_ERROR_STOP=1"],
    input=variables + sql, text=True, check=True,
)
print("인증 앱에 등록할 새 설정 키입니다. 이 값은 다른 사람에게 공유하지 마세요.")
print(base64.b32encode(seed).decode())
