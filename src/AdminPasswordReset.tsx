import { Alert, Button, Form, Input, Space, Typography } from 'antd'
import { useState } from 'react'
import { accountWrite, AdminAccountError } from './adminAccountApi'

export default function AdminPasswordReset({ token, onClose }: {
  token?: string
  onClose: (changed: boolean) => void
}) {
  const [complete, setComplete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function submit(values: { email?: string; newPassword?: string }) {
    setBusy(true)
    setError(undefined)
    try {
      if (token) await accountWrite('/auth/reset', 'POST', { token, newPassword: values.newPassword })
      else await accountWrite('/auth/reset-request', 'POST', { email: values.email?.trim() })
      setComplete(true)
    } catch (failure) {
      if (failure instanceof AdminAccountError && failure.status === 404) {
        setError('재설정 링크가 만료되었거나 이미 사용되었습니다. 새 링크를 요청해주세요.')
      } else if (failure instanceof AdminAccountError && failure.status === 422 && token) {
        setError('다른 비밀번호를 선택해주세요.')
      } else {
        setError(failure instanceof Error ? failure.message : '비밀번호 재설정을 완료하지 못했습니다.')
      }
    } finally { setBusy(false) }
  }

  return <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
    <Typography.Title level={2}>관리자 비밀번호 재설정</Typography.Title>
    {error && <Alert type="error" showIcon title={error} />}
    {complete ? <Alert type="success" showIcon title={token
      ? '비밀번호를 변경했습니다. 새 비밀번호와 MFA로 로그인해주세요.'
      : '입력한 주소에 활성 계정이 있으면 재설정 안내가 제공됩니다.'} />
      : <Form layout="vertical" disabled={busy} onFinish={submit}>
        {token ? <>
          <Form.Item name="newPassword" label="새 비밀번호" rules={[{ required: true, min: 12, max: 128 }]}>
            <Input.Password autoComplete="new-password" maxLength={128} />
          </Form.Item>
          <Form.Item name="confirmation" label="새 비밀번호 확인" dependencies={['newPassword']} rules={[
            { required: true },
            ({ getFieldValue }) => ({
              validator: (_, value: string) => value === getFieldValue('newPassword')
                ? Promise.resolve() : Promise.reject(new Error('새 비밀번호와 같은 값을 입력해주세요.')),
            }),
          ]}>
            <Input.Password autoComplete="new-password" maxLength={128} />
          </Form.Item>
        </> : <Form.Item name="email" label="관리자 이메일" rules={[{ required: true, type: 'email' }]}>
          <Input type="email" autoComplete="email" maxLength={254} />
        </Form.Item>}
        <Button type="primary" htmlType="submit" loading={busy}>{token ? '비밀번호 변경' : '재설정 링크 요청'}</Button>
      </Form>}
    <Button disabled={busy} onClick={() => onClose(!!token && complete)}>로그인으로 돌아가기</Button>
  </Space>
}
