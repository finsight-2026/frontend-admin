import { Alert, Button, Card, Checkbox, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { accountRead, accountWrite, AdminAccountError } from './adminAccountApi'

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED'
type Role = 'SUPER_ADMIN' | 'OPERATOR' | 'PRIVACY' | 'ANALYST'
type Account = { id: string; email: string; name: string; roles: Role[]; status: Status; version: number; enrolled: boolean }
type Action = { kind: 'invite' } | { kind: 'edit' | 'resend' | 'reset'; row: Account }
type Fields = { email?: string; name?: string; roles?: Role[]; status?: Status; reason: string; code?: string }

const statuses: Record<Status, string> = { INVITED: '초대 대기', ACTIVE: '활성', SUSPENDED: '정지' }
const roles: Record<Role, string> = { SUPER_ADMIN: '최고관리자', OPERATOR: '운영자', PRIVACY: '개인정보 담당자', ANALYST: '분석 담당자' }
const titles = { invite: '관리자 초대', edit: '관리자 역할·상태 변경', resend: '초대 다시 보내기', reset: 'MFA 초기화' }
const receipts = {
  invite: '관리자 초대 요청을 접수했습니다.',
  edit: '관리자 정보를 저장했습니다.',
  resend: '초대 메일 재발송 요청을 접수했습니다.',
  reset: 'MFA 초기화와 재등록 초대 요청을 접수했습니다.',
}
const root = '/admins'

export default function AdminAccounts({ self, onSelfChanged }: { self: string; onSelfChanged: () => void }) {
  const [form] = Form.useForm<Fields>()
  const [rows, setRows] = useState<Account[]>()
  const [revision, setRevision] = useState(0)
  const [action, setAction] = useState<Action>()
  const [reauth, setReauth] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    const abort = new AbortController()
    void accountRead<Account[]>(root, abort.signal).then((list) => {
      if (!abort.signal.aborted) setRows(list)
    }).catch((failure: Error) => {
      if (!abort.signal.aborted) setError(failure.message)
    })
    return () => abort.abort()
  }, [revision])

  function open(next: Action) {
    setError(undefined)
    setMessage(undefined)
    setReauth(false)
    setAction(next)
    form.resetFields()
    if (next.kind === 'edit') form.setFieldsValue({ roles: next.row.roles, status: next.row.status })
  }

  async function save(values: Fields) {
    if (!action) return
    setBusy(true)
    setError(undefined)
    try {
      if (reauth) {
        await accountWrite('/auth/reauth', 'POST', { code: values.code })
        setReauth(false)
        form.setFieldValue('code', undefined)
      }
      if (action.kind === 'invite') {
        await accountWrite(root + '/invitations', 'POST', { email: values.email, name: values.name, roles: values.roles, reason: values.reason })
      } else if (action.kind === 'edit') {
        const updated = await accountWrite<Account>(root + '/' + action.row.id, 'PATCH',
          { roles: values.roles, status: values.status, reason: values.reason, expectedVersion: action.row.version })
        if (updated.id === self && updated.version !== action.row.version) { onSelfChanged(); return }
      } else {
        const endpoint = action.kind === 'resend' ? 'resend-invitation' : 'mfa-reset'
        await accountWrite(root + '/' + action.row.id + '/' + endpoint, 'POST', { reason: values.reason })
      }
      setMessage(receipts[action.kind])
      setAction(undefined)
      setRevision((value) => value + 1)
    } catch (failure) {
      if (failure instanceof AdminAccountError && failure.status === 428) setReauth(true)
      else setError(failure instanceof Error ? failure.message : '관리자 변경에 실패했습니다.')
    } finally { setBusy(false) }
  }

  return <Card title="관리자 계정" extra={<Space wrap>
    <Button disabled={busy} onClick={() => { setError(undefined); setRevision((value) => value + 1) }}>새로고침</Button>
    <Button type="primary" onClick={() => open({ kind: 'invite' })}>관리자 초대</Button>
  </Space>}>
    {error && !action && <Alert type="error" title={error} />}
    {message && <Alert type="success" title={message} />}
    <Table<Account> rowKey="id" dataSource={rows ?? []} loading={!rows && !error} scroll={{ x: 820 }} columns={[
      { title: '이름', dataIndex: 'name' },
      { title: '이메일', dataIndex: 'email' },
      { title: '역할', render: (_, row) => <Space wrap>{row.roles.map((role) => <Tag key={role}>{roles[role]}</Tag>)}</Space> },
      { title: '상태', render: (_, row) => <Tag>{statuses[row.status]}</Tag> },
      { title: '관리', render: (_, row) => <Space wrap>
        <Button onClick={() => open({ kind: 'edit', row })}>편집</Button>
        {row.status === 'INVITED' && <Button onClick={() => open({ kind: 'resend', row })}>초대 재발송</Button>}
        {row.status === 'ACTIVE' && row.id !== self && <Button onClick={() => open({ kind: 'reset', row })}>MFA 초기화</Button>}
      </Space> },
    ]} />
    <Modal title={action && titles[action.kind]} open={!!action} forceRender confirmLoading={busy}
      okText={reauth ? '재인증 후 확인' : '확인'} cancelText="돌아가기"
      onCancel={() => { if (!busy) { setAction(undefined); setError(undefined) } }} onOk={() => form.submit()}>
      <Form<Fields> form={form} layout="vertical" disabled={busy} onFinish={(values) => void save(values)}>
        {error && <Alert type="error" title={error} />}
        {action && action.kind !== 'invite' && <Typography.Paragraph>{action.row.name} · {action.row.email}</Typography.Paragraph>}
        {action?.kind === 'invite' && <>
          <Form.Item name="email" label="이메일" rules={[{ required: true, type: 'email' }]}><Input maxLength={254} /></Form.Item>
          <Form.Item name="name" label="표시 이름" rules={[{ required: true, whitespace: true, max: 50 }]}><Input maxLength={50} /></Form.Item>
        </>}
        {(action?.kind === 'invite' || action?.kind === 'edit') && <Form.Item name="roles" label="역할"
          rules={[{ required: true, type: 'array', min: 1 }]}>
          <Checkbox.Group options={Object.entries(roles).map(([value, label]) => ({ value, label }))} />
        </Form.Item>}
        {action?.kind === 'edit' && <Form.Item name="status" label="상태" rules={[{ required: true }]}>
          <Select options={(action.row.enrolled ? ['ACTIVE', 'SUSPENDED'] as const : ['INVITED', 'SUSPENDED'] as const)
            .map((value) => ({ value, label: statuses[value] }))} />
        </Form.Item>}
        {action?.kind === 'reset' && <Alert type="warning" title="기존 세션과 복구 코드를 폐기하고 새 등록 초대를 발급합니다." />}
        <Form.Item name="reason" label="변경 사유" rules={[{ required: true, whitespace: true, min: 10, max: 500 }]}>
          <Input.TextArea maxLength={500} />
        </Form.Item>
        {reauth && <Form.Item name="code" label="인증 앱의 새 6자리 코드" rules={[{ required: true, pattern: /^\d{6}$/ }]}>
          <Input inputMode="numeric" maxLength={6} autoComplete="one-time-code" />
        </Form.Item>}
      </Form>
    </Modal>
  </Card>
}
