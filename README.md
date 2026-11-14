# FINSIGHT 백오피스

React, Ant Design, Vite로 구성한 관리자 웹이다. Spring의 `/api/v1/admin`을 같은 출처에서 호출한다.

## 개발과 검증

```sh
npm ci
npm run lint
npm run build
FINSIGHT_PLAYWRIGHT_CHANNEL=chrome npm run test:browser
```

Chrome을 쓰지 않는 환경에서는 `npx playwright install chromium` 후 `npm run test:browser`를 실행한다. Vite 개발 서버의 기본 포트는 `18443`이다. 실제 관리자 로그인에는 신뢰된 로컬 HTTPS 인증서가 필요하다. `FINSIGHT_ADMIN_TLS_CERT`와 `FINSIGHT_ADMIN_TLS_KEY`에 인증서와 키 경로를 넣고, 필요하면 `FINSIGHT_ADMIN_API_TARGET`으로 Spring 주소를 지정한다.

## Vultr 배포

운영은 `https://admin.finsight.life`에서 공개 TLS를 사용하고, 관리자 조회와 작업은 비밀번호 및 TOTP 인증이 필요하다. 스테이징은 기존 서버의 `127.0.0.1:18443`에만 바인딩되어 SSH 터널로 접속한다. 운영·스테이징 앱 API 호스트는 관리자 경로에 404를 반환한다.

1. 검증한 `dist`에서 `tar -C dist -czf dist.tar.gz .`로 아카이브를 생성한다. 관리자 환경에는 검증한 아카이브만 올린다.
2. 필요 시 Vultr 서버에서 `bash configure-backend.sh staging` 또는 `production`을 실행한다. 환경별 `FINSIGHT_ADMIN_ORIGIN`을 지정하고 최초 한 번만 MFA 암호화 키를 만든다. 각 키는 DB 백업과 함께 별도로 보호한다. 기존 키 변경 시 해당 환경의 TOTP 암호문을 읽을 수 없다.
3. 서버에서 `bash publish.sh staging dist.tar.gz`를 실행하고 SSH 터널로 MFA와 주요 화면을 검증한다. 동일 아카이브로 `bash publish.sh production dist.tar.gz`를 실행한다. 아카이브 SHA-256으로 릴리스를 고정하고 `current` 심볼릭 링크를 원자적으로 갱신한다. 배포 전에 열린 탭은 이전 릴리스 두 개의 해시 자산을 요청할 수 있다. 화면 파일을 불러오지 못하면 새로고침 버튼을 표시한다.
4. Caddy 최초 설정 또는 변경 시 기존 API 설정에 `deploy/Caddyfile`을 추가한다. 기존 Caddy 컨테이너의 `/data` 볼륨이 아카이브를 푼 경로를 제공한다. 후보 설정을 `caddy validate --adapter caddyfile --config`로 검사하고, 기존 파일을 백업한 뒤 `caddy reload --config /etc/caddy/Caddyfile`을 실행한다.
5. HTTPS 로그인 화면, SPA 직접 링크, `/api/v1/admin/auth/csrf`의 200, 세션 없는 `/api/v1/admin/auth/me`의 401을 확인한다. `api.finsight.life`와 `staging.finsight.life`의 `/actuator/health`는 200을, 관리자 경로는 404를 반환해야 한다.

정적 번들을 되돌리려면 Caddy 데이터 볼륨의 `finsight-admin/<환경>`에서 `previous`가 가리키는 릴리스를 확인한다. 그 대상을 새 심볼릭 링크로 만든 뒤 `mv -Tf`로 `current`를 교체한다. 프록시 설정은 저장한 Caddyfile을 복원하고 검증 후 다시 로드한다.

### V70 이전 백엔드로 복구

V72에서 CSV 미리보기를 전용 테이블로 옮기고 V71에 생성한 미확정 CSV 미리보기를 만료시킨다. 해당 미리보기는 다시 생성한다. V71까지만 적용한 상태에서 V70 이하의 백엔드로 되돌릴 때는 백엔드를 중지한 뒤 `DELETE FROM campaign_target_preview WHERE purpose='MASKED_EXPORT';`를 실행한다. 기존 CRM 미리보기와 이미 접수된 CSV 작업은 유지된다.

V70의 스키마는 이전 운영 이미지에서도 읽을 수 있다. 이전 이미지의 작업 처리기는 `MASKED_USERS`를 지원하지 않으므로, 해당 버전으로 복구할 때는 새 백엔드가 작업을 받거나 처리하지 않도록 중지한 뒤 같은 환경의 DB에서 아래 트랜잭션을 실행한다. 대기 중인 마스킹 CSV 작업과 발급된 다운로드 링크는 사용할 수 없게 된다. 다른 종류의 내보내기 데이터는 이 트랜잭션의 적용 범위에 들어가지 않는다.

```sql
BEGIN;
UPDATE admin_dashboard_export
SET status='CANCELED', completed_at=clock_timestamp(), next_run_at=NULL,
    retryable=false, error_code=NULL
WHERE kind='MASKED_USERS' AND (status='QUEUED' OR (status='FAILED' AND retryable));

DELETE FROM admin_dashboard_export_link l USING admin_dashboard_export e
WHERE l.export_id=e.id AND e.kind='MASKED_USERS';

UPDATE admin_dashboard_export SET archive=NULL, error_code='FILE_EXPIRED'
WHERE kind='MASKED_USERS' AND archive IS NOT NULL;

DELETE FROM admin_masked_export_user u USING admin_dashboard_export e
WHERE u.export_id=e.id AND e.kind='MASKED_USERS';
COMMIT;
```

이전 웹 번들과 백엔드를 시작하고 공개 API 상태, 설문 조회, 관리자 로그인 화면과 세션 응답을 확인한다. Flyway 이력은 V70을 유지한다. 새 버전 재배포 후 마스킹 CSV가 필요하면 작업을 다시 접수한다.

## 최초 관리자

서버의 대화형 SSH 터미널에서 `bash bootstrap-admin.sh production <이메일>`을 실행한다. 계정이 비어 있는 환경에서만 동작한다. 초기 계정에는 최고관리자·운영자·분석자 역할을 부여하고 감사 기록을 남긴다. 비밀번호는 숨겨진 프롬프트에 입력하고 출력된 TOTP 키는 인증 앱에만 등록한다.

인증 정보를 노출한 계정은 접근을 차단하고 세션을 폐기한 뒤에만 `python3 rotate-admin-credentials.py production <이메일>`로 비밀번호와 TOTP를 교체한다. 이 명령은 서버의 `python3-cryptography`를 사용하고 기존 계정 ID·역할·감사 기록을 보존한다. 새 정보는 사용자 본인이 대화형 터미널에서 설정한다.

현재 운영 메일 발송은 비활성이다. 관리자 초대·재설정 메일에는 승인된 발신자와 관리자용 발송 연동이 필요하다.
