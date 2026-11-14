import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Checkbox, Descriptions, Form, Input, Space, Table, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'

type Scope = 'PROFILE' | 'ANSWERS'
type FormValues = { scope: Scope[]; reason: string; code?: string }
type Grant = { grantId: string; expiresAt: string }
type Csrf = { headerName: string; token: string }
type Raw = {
  profile: { email: string; attributes: Record<string, unknown> } | null
  answers: { questionNo: number; response: number }[]
  expiresAt: string
}
type OpenGrant = { grant: Grant; csrf: Csrf; root: string }
type ExportJob = { id: string; status: string; errorCode?: string }
type Action = 'read' | 'export'
const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
})

function revoke(active: OpenGrant) {
  void adminFetch(active.root + '/pii-grants/' + active.grant.grantId, {
    method: 'DELETE',
    headers: { [active.csrf.headerName]: active.csrf.token },
    keepalive: true,
  }).catch(() => { /* The grant still expires on the server. */ })
}

function message(status: number) {
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.',
    403: '열람 권한이 없거나 권한이 만료되었습니다.',
    404: '사용자 또는 진단 회차를 찾을 수 없습니다.',
    409: '같은 범위의 작업이 대기 중입니다. 작업 모니터에서 확인해주세요.',
    422: '입력한 사유와 인증 코드를 확인해주세요. 이미 사용한 코드는 갱신 후 입력해주세요.',
    428: '최근 MFA 인증이 필요합니다.',
    429: '인증 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
    503: '개인정보 열람 사유를 암호화하는 서버 키가 설정되어 있지 않습니다.',
  }
  return messages[status] ?? '개인정보 열람을 완료하지 못했습니다.'
}

async function checked(response: Response) {
  if (!response.ok) throw new Error(message(response.status))
  return response
}

export default function AdminPiiPanel({ userId, diagnosisId }: {
  userId: string; diagnosisId?: string
}) {
  const [form] = Form.useForm<FormValues>()
  const [raw, setRaw] = useState<Raw>()
  const [exportJob, setExportJob] = useState<ExportJob>()
  const [mfa, setMfa] = useState(false)
  const [pendingAction, setPendingAction] = useState<Action>('read')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const active = useRef<OpenGrant | undefined>(undefined)
  const generation = useRef(0)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const root = '/api/v1/admin/users/' + userId

  useEffect(() => {
    function release() {
      generation.current++
      clearTimeout(timeout.current)
      if (active.current) revoke(active.current)
      active.current = undefined
    }
    function leavePage() {
      release()
      setRaw(undefined)
      setExportJob(undefined)
      setBusy(false)
      setMfa(false)
      form.resetFields()
    }
    function restorePage(event: PageTransitionEvent) {
      if (event.persisted) leavePage()
    }
    window.addEventListener('pagehide', leavePage)
    window.addEventListener('pageshow', restorePage)
    return () => {
      window.removeEventListener('pagehide', leavePage)
      window.removeEventListener('pageshow', restorePage)
      release()
    }
  }, [form])

  const queuedId = exportJob?.status === 'QUEUED' ? exportJob.id : undefined
  useEffect(() => {
    if (!queuedId) return
    const abort = new AbortController()
    const current = generation.current
    let poll: ReturnType<typeof setTimeout>
    async function check() {
      try {
        const job = await adminFetch('/api/v1/admin/jobs/' + queuedId, {
          cache: 'no-store', signal: abort.signal,
        }).then(checked).then((reply) => reply.json() as Promise<ExportJob>)
        if (!abort.signal.aborted && generation.current === current) {
          setError(undefined)
          setExportJob(job)
          if (job.status === 'QUEUED') poll = setTimeout(() => void check(), 3000)
        }
      } catch (failure) {
        if (!abort.signal.aborted && generation.current === current) {
          setError(failure instanceof Error ? failure.message : '작업을 조회하지 못했습니다.')
          poll = setTimeout(() => void check(), 3000)
        }
      }
    }
    poll = setTimeout(() => void check(), 3000)
    return () => { abort.abort(); clearTimeout(poll) }
  }, [queuedId])

  function clear() {
    generation.current++
    clearTimeout(timeout.current)
    if (active.current) revoke(active.current)
    active.current = undefined
    setRaw(undefined)
    setExportJob(undefined)
    setBusy(false)
  }

  async function show({ scope, reason, code }: FormValues, action: Action) {
    if (busy) return
    if (action === 'export' && scope.length !== 1) {
      setError('CSV로 내보낼 범위를 한 가지 선택해주세요.')
      return
    }
    clear()
    const current = generation.current
    setBusy(true)
    setError(undefined)
    try {
      const csrf = await adminFetch('/api/v1/admin/auth/csrf').then(checked)
        .then((response) => response.json() as Promise<Csrf>)
      if (generation.current !== current) return
      const headers = { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' }
      if (mfa) {
        await adminFetch('/api/v1/admin/auth/reauth', {
          method: 'POST', headers, body: JSON.stringify({ code }),
        }).then(checked)
        if (generation.current !== current) return
        form.setFieldValue('code', undefined)
        setMfa(false)
      }
      const response = await adminFetch(root + '/pii-grants', {
        method: 'POST', headers, body: JSON.stringify({ scope: action === 'export' ? [...scope, 'EXPORT'] : scope, reason }),
      })
      if (response.status === 428 && generation.current === current) {
        setPendingAction(action)
        setMfa(true)
        return
      }
      const grant = await checked(response).then((reply) => reply.json() as Promise<Grant>)
      const issued = { grant, csrf, root }
      if (generation.current !== current) {
        revoke(issued)
        return
      }
      active.current = issued
      const duration = Math.min(600_000, Date.parse(grant.expiresAt) - Date.now())
      if (duration <= 0) throw new Error('열람 권한이 만료되었습니다.')
      if (action === 'export') {
        const job = await adminFetch('/api/v1/admin/exports', {
          method: 'POST', headers, body: JSON.stringify({
            kind: 'PII_RAW', format: 'CSV', grantId: grant.grantId, reason,
            filter: { userId, scope: scope[0], diagnosisId: scope[0] === 'ANSWERS' ? diagnosisId : undefined },
          }),
        }).then(checked).then((reply) => reply.json() as Promise<ExportJob>)
        if (generation.current !== current) return
        form.resetFields()
        setExportJob(job)
        timeout.current = setTimeout(clear, Math.max(0, Date.parse(grant.expiresAt) - Date.now()))
        return
      }
      const params = new URLSearchParams({ grantId: grant.grantId })
      if (diagnosisId && scope.includes('ANSWERS')) params.set('diagnosisId', diagnosisId)
      const data = await adminFetch(root + '/pii?' + params, { cache: 'no-store' }).then(checked)
        .then((reply) => reply.json() as Promise<Raw>)
      if (generation.current !== current) return
      const remaining = Math.min(600_000, Date.parse(grant.expiresAt) - Date.now())
      if (remaining <= 0) throw new Error('열람 권한이 만료되었습니다.')
      form.resetFields()
      setRaw(data)
      timeout.current = setTimeout(clear, remaining)
    } catch (failure) {
      if (generation.current !== current) return
      clear()
      setBusy(false)
      setError(failure instanceof Error ? failure.message : '개인정보를 열람하지 못했습니다.')
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }

  async function download() {
    const issued = active.current
    if (!issued || !exportJob || busy) return
    const current = generation.current
    setBusy(true)
    setError(undefined)
    try {
      const link = await adminFetch('/api/v1/admin/exports/' + exportJob.id + '/download', {
        method: 'POST',
        headers: { [issued.csrf.headerName]: issued.csrf.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantId: issued.grant.grantId }),
      }).then(checked).then((reply) => reply.json() as Promise<{ url: string }>)
      if (generation.current !== current) return
      const anchor = document.createElement('a')
      anchor.href = link.url
      anchor.download = ''
      anchor.rel = 'noreferrer'
      anchor.click()
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : 'CSV를 받을 수 없습니다.')
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }

  return <Card size="small" title="개인정보 열람">
    {error && <Alert type="error" title={error} showIcon />}
    {exportJob ? <Space orientation="vertical" style={{ display: 'flex' }}>
      <Typography.Text role="status">{exportJob.status === 'QUEUED' ? '원문 CSV 생성 대기 중'
        : exportJob.status === 'COMPLETED' && !exportJob.errorCode ? '원문 CSV 다운로드 가능'
          : '원문 CSV 작업이 종료되었습니다.'}</Typography.Text>
      <Typography.Text>작업 ID {exportJob.id}</Typography.Text>
      <Space wrap>
        {exportJob.status === 'COMPLETED' && !exportJob.errorCode
          && <Button type="primary" loading={busy} onClick={() => void download()}>원문 CSV 다운로드</Button>}
        <Button onClick={() => { clear(); setBusy(false) }}>개인정보 권한 종료</Button>
      </Space>
    </Space> : raw ? <Space orientation="vertical" style={{ display: 'flex' }}>
      <Space wrap>
        <Typography.Text>열람 만료 {time.format(new Date(raw.expiresAt))} (KST)</Typography.Text>
        <Button onClick={clear}>열람 종료</Button>
      </Space>
      {raw.profile && <Descriptions bordered size="small" column={1} items={[
        { key: 'email', label: '이메일', children: raw.profile.email },
        ...Object.entries(raw.profile.attributes).map(([key, value]) => ({
          key, label: key, children: <span style={{ overflowWrap: 'anywhere' }}>{String(value)}</span>,
        })),
      ]} />}
      {raw.answers.length > 0 && <Table rowKey="questionNo" dataSource={raw.answers} pagination={false}
        title={() => '선택한 회차의 설문 원응답'} columns={[
          { title: '문항 번호', dataIndex: 'questionNo' },
          { title: '응답값', dataIndex: 'response' },
        ]} />}
    </Space> : <Form form={form} layout="vertical" onFinish={(values) => void show(values, mfa ? pendingAction : 'read')}
      disabled={busy} initialValues={{ scope: [] }}>
      <Form.Item name="scope" label="열람 범위" rules={[{ required: true, type: 'array', min: 1 }]}>
        <Checkbox.Group options={[
          { value: 'PROFILE', label: '이메일·가입 프로필' },
          { value: 'ANSWERS', label: '선택한 진단 회차의 원응답', disabled: !diagnosisId },
        ]} />
      </Form.Item>
      <Form.Item name="reason" label="열람 사유" rules={[{ required: true, min: 10, max: 500, whitespace: true }]}>
        <Input.TextArea maxLength={500} showCount />
      </Form.Item>
      {mfa && <Form.Item name="code" label="인증 앱의 새 6자리 코드"
        rules={[{ required: true, pattern: /^[0-9]{6}$/ }]}>
        <Input inputMode="numeric" maxLength={6} autoComplete="one-time-code" />
      </Form.Item>}
      <Space wrap>
        <Button type="primary" htmlType="submit" loading={busy}>{mfa
          ? pendingAction === 'export' ? '재인증 후 CSV 요청' : '재인증 후 열람'
          : '10분간 열람'}</Button>
        {!mfa && <Button loading={busy} onClick={() => void form.validateFields()
          .then((values) => show(values, 'export')).catch(() => undefined)}>원문 CSV 요청</Button>}
      </Space>
    </Form>}
  </Card>
}
