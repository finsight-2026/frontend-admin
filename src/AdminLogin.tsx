import { Alert, Button, Form, Input, Space, Spin, Typography } from 'antd'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'

import AdminWorkspace from './AdminWorkspace'
import { adminSessionExpired } from './adminFetch'
import AdminScreenErrorBoundary from './AdminScreenErrorBoundary'

const AdminEnrollment = lazy(() => import('./AdminEnrollment'))
const AdminPasswordReset = lazy(() => import('./AdminPasswordReset'))

type Identity = { admin: { id: string; name: string }; permissions: string[] }
type Challenge = { challengeId: string; expiresAt: string }

const root = '/api/v1/admin/auth'

class ApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super('관리자 인증 요청 실패')
    this.status = status
  }
}

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(root + path, { signal, credentials: 'same-origin' })
  if (!response.ok) throw new ApiError(response.status)
  return response.json() as Promise<T>
}

async function write<T>(path: string, body?: object): Promise<T> {
  const csrf = await read<{ token: string; headerName: string }>('/csrf')
  const response = await fetch(root + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new ApiError(response.status)
  return (response.status === 204 ? undefined : await response.json()) as T
}

export default function AdminLogin() {
  const lastActivity = useRef(0)
  const [identity, setIdentity] = useState<Identity>()
  const [challenge, setChallenge] = useState<Challenge>()
  const [invitation, setInvitation] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('admin-invitation')
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
  })
  const [resetToken, setResetToken] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('admin-password-reset')
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
  })
  const [resetRequest, setResetRequest] = useState(false)
  const [recovery, setRecovery] = useState(false)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [credentials] = Form.useForm<{ email: string; password: string }>()
  const [mfa] = Form.useForm<{ code: string }>()

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    if (fragment.has('admin-invitation') || fragment.has('admin-password-reset')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    read<Identity>('/me', abort.signal).then(setIdentity).catch((error: unknown) => {
      if (!abort.signal.aborted && !(error instanceof ApiError && error.status === 401)) {
        setError('관리자 서버에 연결하지 못했습니다.')
      }
    }).finally(() => {
      if (!abort.signal.aborted) setChecking(false)
    })
    return () => abort.abort()
  }, [])

  async function submit(action: () => Promise<void>, invalid: string) {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        setError('요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.')
      } else if (error instanceof ApiError && error.status === 401) {
        setError(invalid)
      } else {
        setError('요청을 완료하지 못했습니다. 연결 상태를 확인해주세요.')
      }
    } finally {
      setBusy(false)
    }
  }

  function recordActivity() {
    if (!identity || Date.now() - lastActivity.current < 60_000) return
    lastActivity.current = Date.now()
    void write('/activity').catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        setIdentity(undefined)
        setError('세션이 만료되었습니다. 다시 로그인해주세요.')
      }
    })
  }

  function expireSession() {
    setIdentity(undefined)
    setError('세션이 만료되었습니다. 다시 로그인해주세요.')
  }

  useEffect(() => {
    window.addEventListener(adminSessionExpired, expireSession)
    return () => window.removeEventListener(adminSessionExpired, expireSession)
  }, [])

  if (identity && !invitation && !resetToken && !resetRequest && !checking) {
    return <div onPointerDown={recordActivity} onKeyDown={recordActivity}>
      <AdminWorkspace identity={identity} busy={busy} error={error} logout={() => {
        void submit(async () => { await write('/logout'); setIdentity(undefined) }, '세션이 만료되었습니다.')
      }} onSelfChanged={() => {
        setIdentity(undefined)
        setError('관리자 역할 또는 상태가 변경되었습니다. 다시 로그인해주세요.')
      }} />
    </div>
  }

  return (
    <main className="admin-entry">
      <Typography.Text>FINSIGHT</Typography.Text>
      <h1>관리자 백오피스</h1>
      <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
        {error && <Alert title={error} type="error" showIcon />}
        {invitation ? <AdminScreenErrorBoundary key="invitation" onClose={() => setInvitation(undefined)}>
          <Suspense fallback={<Spin aria-label="초대 불러오는 중" />}>
            <AdminEnrollment token={invitation} onClose={() => setInvitation(undefined)} />
          </Suspense>
        </AdminScreenErrorBoundary> : resetToken || resetRequest ? <AdminScreenErrorBoundary key="reset"
          onClose={resetToken ? () => setResetToken(undefined) : undefined}>
          <Suspense fallback={<Spin aria-label="재설정 화면 불러오는 중" />}>
            <AdminPasswordReset token={resetToken} onClose={(changed) => {
              setResetToken(undefined)
              setResetRequest(false)
              if (changed) setIdentity(undefined)
            }} />
          </Suspense>
        </AdminScreenErrorBoundary> : checking ? <Spin aria-label="세션 확인 중" /> : challenge ? (
          <Form form={mfa} layout="vertical" onFinish={({ code }) => submit(async () => {
            setIdentity(await write<Identity>('/mfa', recovery
              ? { challengeId: challenge.challengeId, recoveryCode: code.trim().toUpperCase() }
              : { challengeId: challenge.challengeId, code }))
            mfa.resetFields()
            setChallenge(undefined)
            setRecovery(false)
          }, '인증번호가 맞지 않거나 만료되었습니다. 필요하면 로그인을 다시 시작해주세요.')}>
            <Typography.Title level={2}>2단계 인증</Typography.Title>
            <Form.Item name="code" label={recovery ? '복구 코드' : '인증 앱의 6자리 코드'}
              rules={[{ required: true, pattern: recovery ? /^[A-Z2-7]{16}$/i : /^\d{6}$/,
                message: recovery ? '복구 코드 16자를 입력해주세요.' : '숫자 6자리를 입력해주세요.' }]}>
              <Input inputMode={recovery ? 'text' : 'numeric'} maxLength={recovery ? 16 : 6} autoComplete="one-time-code" autoFocus />
            </Form.Item>
            <Space wrap>
              <Button type="primary" htmlType="submit" loading={busy}>인증</Button>
              <Button disabled={busy} onClick={() => {
                mfa.resetFields()
                setError(undefined)
                setRecovery((value) => !value)
              }}>{recovery ? '인증 앱 코드 사용' : '복구 코드 사용'}</Button>
              <Button disabled={busy} onClick={() => {
                mfa.resetFields()
                setChallenge(undefined)
                setRecovery(false)
                setError(undefined)
              }}>로그인으로 돌아가기</Button>
            </Space>
          </Form>
        ) : (
          <Form form={credentials} layout="vertical" onFinish={(values) => submit(async () => {
            const result = await write<Challenge | Identity>('/login', {
              ...values, email: values.email.trim(), passwordSessionSupported: true,
            })
            if ('challengeId' in result) setChallenge(result)
            else setIdentity(result)
            credentials.resetFields(['password'])
          }, '이메일과 비밀번호를 확인해주세요.')}>
            <Form.Item name="email" label="이메일"
              rules={[{ type: 'email', required: true, message: '이메일을 확인해주세요.' }]}>
              <Input type="email" autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="비밀번호"
              rules={[{ required: true, message: '비밀번호를 입력해주세요.' }]}>
              <Input.Password autoComplete="current-password" maxLength={128} />
            </Form.Item>
            <Space wrap>
              <Button type="primary" htmlType="submit" loading={busy}>계속</Button>
              <Button disabled={busy} onClick={() => {
                setError(undefined)
                setResetRequest(true)
              }}>비밀번호 재설정</Button>
            </Space>
          </Form>
        )}
      </Space>
    </main>
  )
}
