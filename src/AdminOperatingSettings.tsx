import { useAdminUnsaved } from './adminNavigation'
import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Checkbox, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Switch, Typography } from 'antd'
import { useEffect, useState } from 'react'

type Policy = {
  version: number; comparisonMetrics: string[]; crmPaused: boolean; automaticPushPaused: boolean
  reminderCap: number; totalCap: number; funnelCheck: number; funnelPriority: number; operatorId: string | null
}
type Minimum = { type: string; minimum: number | null }
type Settings = { policy: Policy; comparisonMinimums: Minimum[]; operators: { id: string; name: string }[] }
type Fields = Omit<Policy, 'version'> & { minimums: Record<string, number | null> }
type Change = { key: string; label: string; before: string; after: string }
type Proposal = { values: Partial<Fields> & { comparisonMinimums?: Minimum[] }; review: Change[] }
const root = '/api/v1/admin/settings'
const metrics: Record<string, string> = {
  YFSI_MEAN: 'YFSI 평균', EXTERNAL_AREA_MEAN: '외부 압박 영역 평균',
  RESOURCE_DOMAIN_MEAN: '대응자원 영역 평균', PERCEIVED_STRESS_MEAN: '체감 스트레스 평균',
}
const types: Record<string, string> = {
  DEBT: '부채부담형', INCOME: '소득불안형', EMERGENCY_FUND: '비상자금취약형',
  FIXED_COST: '고정비압박형', FUTURE: '미래불안형', FAMILY: '부양부담형',
}
const impacts = [
  '공개 지표에서 제외되거나 최소 표본을 다시 설정한 유형의 비교 게시본은 재승인이 필요할 수 있습니다.',
  '알림을 재개해도 일시정지 동안 지난 예약은 발송되지 않습니다. 상한은 이후 처리부터 적용됩니다.',
  '퍼널 점검 임계값은 다음 조회에 적용됩니다.',
]
const pauseLabel = (paused: boolean) => paused ? '일시정지' : '실행'
const minimumLabel = (minimum: number | null) => minimum == null ? '미설정 · 공개 불가' : minimum + '명'

async function decode<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.',
    403: '운영 설정을 관리할 권한이 없습니다.',
    409: '다른 관리자가 수정했어요. 최신 내용을 확인해 주세요.',
    422: '설정값, 변경 사유 또는 인증 코드를 확인해주세요.',
    429: '인증 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
    503: '운영 설정 서비스에 일시적으로 연결할 수 없어요. 잠시 후 다시 시도해 주세요.',
  }
  throw new Error(messages[response.status] ?? '운영 설정 요청에 실패했습니다.')
}

export default function AdminOperatingSettings() {
  const [form] = Form.useForm<Fields>()
  const [state, setState] = useState<Settings>()
  const { mark: markUnsaved, clear: clearUnsaved } = useAdminUnsaved(state != null)
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [proposal, setProposal] = useState<Proposal>()
  const [reason, setReason] = useState('')
  const [code, setCode] = useState('')
  const [reauth, setReauth] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)

  function refresh() {
    setProposal(undefined)
    setConflict(false)
    setState(undefined)
    setError(undefined)
    setResult(undefined)
    setRevision((value) => value + 1)
  }

  function display(data: Settings) {
    setState(data)
    form.setFieldsValue({
      ...data.policy,
      minimums: Object.fromEntries(data.comparisonMinimums.map((item) => [item.type, item.minimum])),
    })
  }

  useEffect(() => {
    const abort = new AbortController()
    void adminFetch(root, { signal: abort.signal, cache: 'no-store' }).then(decode<Settings>).then((data) => {
      if (abort.signal.aborted) return
      setState(data)
      form.setFieldsValue({
        ...data.policy,
        minimums: Object.fromEntries(data.comparisonMinimums.map((item) => [item.type, item.minimum])),
      })
    }).catch((failure: Error) => {
      if (!abort.signal.aborted) setError(failure.message)
    })
    return () => abort.abort()
  }, [form, revision])

  function propose(fields: Fields) {
    if (!state) return
    setError(undefined)
    setResult(undefined)
    if (fields.reminderCap > fields.totalCap || fields.funnelCheck > fields.funnelPriority) {
      setError('전체 상한은 리마인더 상한 이상, 우선 점검률은 점검률 이상이어야 합니다.')
      return
    }
    const { policy, comparisonMinimums, operators } = state
    const name = (id: string | null) => id == null ? '미지정' : operators.find((entry) => entry.id === id)?.name ?? id
    const values: Proposal['values'] = {}
    const review: Change[] = []
    function changed<K extends keyof Omit<Fields, 'minimums'>>(key: K, label: string, before: Fields[K], after: Fields[K],
      format: (value: Fields[K]) => string) {
      if (JSON.stringify(before) === JSON.stringify(after)) return
      values[key] = after
      review.push({ key, label, before: format(before), after: format(after) })
    }
    changed('comparisonMetrics', '비교 허용 지표', [...policy.comparisonMetrics].sort(), [...fields.comparisonMetrics].sort(),
      (items) => items.map((item) => metrics[item]).join(', ') || '없음')
    changed('crmPaused', 'CRM 발송', policy.crmPaused, fields.crmPaused, pauseLabel)
    changed('automaticPushPaused', '자동 알림', policy.automaticPushPaused, fields.automaticPushPaused, pauseLabel)
    changed('reminderCap', '비경제 리마인더 상한', policy.reminderCap, fields.reminderCap, String)
    changed('totalCap', '전체 상한', policy.totalCap, fields.totalCap, String)
    changed('funnelCheck', '퍼널 점검률', policy.funnelCheck, fields.funnelCheck, (n) => n + '%')
    changed('funnelPriority', '퍼널 우선 점검률', policy.funnelPriority, fields.funnelPriority, (n) => n + '%')
    changed('operatorId', '운영 담당자', policy.operatorId, fields.operatorId ?? null, name)
    const minimumChanges: Minimum[] = []
    for (const item of comparisonMinimums) {
      const minimum = fields.minimums[item.type] ?? null
      if (item.minimum === minimum) continue
      minimumChanges.push({ type: item.type, minimum })
      review.push({ key: item.type, label: types[item.type] + ' 최소 표본',
        before: minimumLabel(item.minimum), after: minimumLabel(minimum) })
    }
    if (minimumChanges.length) values.comparisonMinimums = minimumChanges
    if (!review.length) { clearUnsaved(); setResult('변경된 설정이 없습니다.'); return }
    setReason('')
    setCode('')
    setReauth(false)
    setConflict(false)
    setProposal({ values, review })
  }

  async function save() {
    if (!proposal || !state) return
    setBusy(true)
    setError(undefined)
    try {
      const csrf = await adminFetch('/api/v1/admin/auth/csrf', { cache: 'no-store' })
        .then(decode<{ headerName: string; token: string }>)
      const headers = { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' }
      if (reauth) {
        const verified = await adminFetch('/api/v1/admin/auth/reauth', { method: 'POST', headers, body: JSON.stringify({ code }) })
        if (!verified.ok) await decode(verified)
        setReauth(false)
        setCode('')
      }
      const response = await adminFetch(root, {
        method: 'PATCH', headers, body: JSON.stringify({
          changes: proposal.values, expectedVersion: state.policy.version, reason,
        }),
      })
      if (response.status === 428) { setReauth(true); return }
      if (response.status === 409) setConflict(true)
      display(await decode<Settings>(response))
      clearUnsaved()
      setProposal(undefined)
      setResult('운영 설정을 저장했습니다.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '저장에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const numberRules = [{ required: true, type: 'number' as const }]
  const operators = state?.operators.map(({ id, name }) => ({ value: id, label: name })) ?? []
  if (state?.policy.operatorId && !operators.some((item) => item.value === state.policy.operatorId)) {
    operators.push({ value: state.policy.operatorId, label: state.policy.operatorId + ' · 비활성' })
  }
  return <Card title="운영 설정" extra={<Button disabled={busy || !!proposal} onClick={refresh}>새로고침</Button>}>
    <Space orientation="vertical" style={{ display: 'flex' }}>
      {error && !proposal && <Alert type="error" title={error} showIcon />}
      {result && <Alert type="success" title={result} />}
      <Form form={form} layout="vertical" onValuesChange={markUnsaved} onFinish={propose} disabled={busy} hidden={!state}>
        <Typography.Title level={4}>비공개 비교</Typography.Title>
        <Form.Item name="comparisonMetrics" label="공개 허용 지표">
          <Checkbox.Group options={Object.entries(metrics).map(([value, label]) => ({ value, label }))} />
        </Form.Item>
        <div className="admin-user-filters">
          {state?.comparisonMinimums.map(({ type }) => <Form.Item key={type} name={['minimums', type]}
            label={types[type] + ' 최소 표본'} rules={[{ type: 'integer', min: 30, message: '30명 이상을 입력해주세요.' }]}>
            <InputNumber min={30} precision={0} placeholder="미설정" />
          </Form.Item>)}
        </div>
        <Typography.Title level={4}>알림과 분석</Typography.Title>
        <div className="admin-user-filters">
          <Form.Item name="crmPaused" label="CRM 발송 일시정지" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="automaticPushPaused" label="자동 알림 일시정지" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="reminderCap" label="비경제 리마인더 일일 상한" rules={numberRules}><InputNumber min={0} max={1} precision={0} /></Form.Item>
          <Form.Item name="totalCap" label="전체 일일 상한" rules={numberRules}><InputNumber min={0} max={2} precision={0} /></Form.Item>
          <Form.Item name="funnelCheck" label="퍼널 점검률 (%)" rules={numberRules}><InputNumber min={0} max={100} step={0.1} /></Form.Item>
          <Form.Item name="funnelPriority" label="퍼널 우선 점검률 (%)" rules={numberRules}><InputNumber min={0} max={100} step={0.1} /></Form.Item>
          <Form.Item name="operatorId" label="운영 담당자"><Select allowClear options={operators} placeholder="미지정" /></Form.Item>
        </div>
        <Button type="primary" htmlType="submit">변경 검토</Button>
      </Form>
    </Space>
    <Modal open={!!proposal} title="운영 설정 변경 확인" onCancel={() => setProposal(undefined)} onOk={() => void save()}
      okText={reauth ? '재인증 후 저장' : '설정 저장'} cancelText="돌아가기" confirmLoading={busy}
      okButtonProps={{ disabled: conflict || Array.from(reason.trim()).length < 10 || (reauth && !/^\d{6}$/.test(code)) }}>
      <Space orientation="vertical" style={{ display: 'flex' }}>
        {error && <Alert type="error" title={error} />}
        {conflict && <Button onClick={refresh}>최신 설정 불러오기</Button>}
        <Descriptions bordered size="small" column={1} items={proposal?.review.map((row) => ({
          key: row.key, label: row.label, children: row.before + ' → ' + row.after,
        }))} />
        <ul>{impacts.map((impact) => <li key={impact}>{impact}</li>)}</ul>
        <Input.TextArea aria-label="변경 사유" placeholder="변경 사유 (10~500자)" value={reason} maxLength={500}
          onChange={(event) => setReason(event.target.value)} />
        {reauth && <Input aria-label="인증 앱의 6자리 코드" placeholder="인증 앱의 새 6자리 코드" inputMode="numeric"
          autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} />}
      </Space>
    </Modal>
  </Card>
}
