import { Alert, Button, Form, Input, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { accountRead, accountWrite, AdminAccountError } from './adminAccountApi'

type Preview = { maskedEmail: string; purpose: 'INVITATION' | 'MFA_RESET'; expiresAt: string }
type Enrollment = { enrollmentId: string; secret: string; expiresAt: string }
type FormValues = { password: string; totpCode: string }
const time = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' })

export default function AdminEnrollment({ token, onClose }: { token: string; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview>()
  const [enrollment, setEnrollment] = useState<Enrollment>()
  const [codes, setCodes] = useState<string[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const path = '/auth/invitations/' + token

  useEffect(() => {
    const abort = new AbortController()
    void accountRead<Preview>(path, abort.signal).then((data) => {
      if (!abort.signal.aborted) setPreview(data)
    }).catch((failure: Error) => {
      if (!abort.signal.aborted) setError(failure.message)
    })
    return () => abort.abort()
  }, [path])

  async function begin() {
    setBusy(true)
    setError(undefined)
    try {
      setEnrollment(await accountWrite<Enrollment>(path + '/enrollment', 'POST'))
    } catch (failure) {
      setError(failure instanceof AdminAccountError && failure.status === 409
        ? '이미 진행 중인 등록이 있습니다. 처음 연 화면에서 완료하거나 10분 뒤 다시 시작해주세요.'
        : failure instanceof Error ? failure.message : '등록을 시작하지 못했습니다.')
    } finally { setBusy(false) }
  }

  async function activate(values: FormValues) {
    if (!enrollment) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await accountWrite<{ recoveryCodes: string[] }>('/auth/activate', 'POST',
        { ...values, token, enrollmentId: enrollment.enrollmentId })
      setEnrollment(undefined)
      setCodes(result.recoveryCodes)
    } catch (failure) {
      if (failure instanceof AdminAccountError && [404, 429].includes(failure.status)) setEnrollment(undefined)
      setError(failure instanceof Error ? failure.message : '등록을 완료하지 못했습니다.')
    } finally { setBusy(false) }
  }

  return <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
    <Typography.Title level={2}>{preview?.purpose === 'MFA_RESET' ? '관리자 MFA 재등록' : '관리자 초대'}</Typography.Title>
    {error && <Alert type="error" title={error} showIcon />}
    {codes ? <>
      <Alert type="success" title="등록을 완료했습니다." description="복구 코드 10개는 지금 한 번만 표시됩니다. 각 코드는 한 번 사용할 수 있습니다." />
      <Space wrap>{codes.map((code) => <Typography.Text key={code} code>{code}</Typography.Text>)}</Space>
      <Button type="primary" onClick={onClose}>로그인으로 이동</Button>
    </> : <>
      {preview && <Typography.Text>{preview.maskedEmail} · 초대 만료 {time.format(new Date(preview.expiresAt))} (KST)</Typography.Text>}
      {enrollment ? <>
        <Typography.Text>인증 앱에 키를 등록하세요. TOTP 30초, SHA-1, 6자리를 사용합니다.</Typography.Text>
        <Typography.Text code copyable>{enrollment.secret}</Typography.Text>
        <Typography.Text type="secondary">등록 만료 {time.format(new Date(enrollment.expiresAt))} (KST)</Typography.Text>
        <Form<FormValues> layout="vertical" disabled={busy} onFinish={(values) => void activate(values)}>
          <Form.Item name="password" label={preview?.purpose === 'MFA_RESET' ? '기존 비밀번호' : '새 비밀번호'}
            rules={[{ required: true, min: 12, max: 128 }]}>
            <Input.Password autoComplete={preview?.purpose === 'MFA_RESET' ? 'current-password' : 'new-password'} maxLength={128} />
          </Form.Item>
          <Form.Item name="totpCode" label="인증 앱의 6자리 코드" rules={[{ required: true, pattern: /^\d{6}$/ }]}>
            <Input inputMode="numeric" maxLength={6} autoComplete="one-time-code" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>등록 완료</Button>
        </Form>
      </> : preview && <Button type="primary" onClick={() => void begin()} loading={busy}>MFA 등록 시작</Button>}
      <Button disabled={busy} onClick={onClose}>로그인으로 돌아가기</Button>
    </>}
  </Space>
}
