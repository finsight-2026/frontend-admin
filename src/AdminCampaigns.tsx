import { useAdminUnsaved } from './adminNavigation'
import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Radio, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

type Campaign = {
  id: string; name: string; status: string; version: number; segmentId?: string; segmentVersion?: number
  userIds: string[]; noticeRevisionId: string; title: string; body: string; requestedAt?: string; scheduledAt?: string
}
type Notice = { revisionId: string; revisionNo: number; title: string }
type Segment = { id: string; name: string; definitionVersion: number; status: string }
type Fields = { name: string; target: 'SEGMENT' | 'USERS'; segmentRef?: string; userIds?: string; noticeRevisionId: string; scheduledAt?: string }
type Counts = { total: number; localEligible: number; eligible: number; excludedByReason: Record<string, number> }
type Preview = { previewId: string; counts: Counts; executionAt: string; expiresAt: string }
type Job = { id: string; status: string }
type Delivery = { id: string; recipient: string; status: string; reason?: string; updatedAt: string; devices?: Record<string, number> }
type Deliveries = {
  counts: { waiting: number; localInbox: number; excluded: number; canceled: number; failed: number }
  reasons: Record<string, number>; items: Delivery[]; errorCode?: string
  deviceCounts?: Record<string, number>; retryableDevices?: number
}

const root = '/api/v1/admin/campaigns'
const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
})
const statuses: Record<string, string> = {
  DRAFT: '초안', SCHEDULED: '예약 접수', QUEUED: '대기 접수', SENDING: '처리 중',
  COMPLETED: '완료', PARTIAL_FAILED: '일부 실패', FAILED: '실패', CANCELED: '취소', CANCEL_REQUESTED: '취소 요청',
}
const excludedLabels: Record<string, string> = {
  WITHDRAWAL_PENDING: '탈퇴 대기', OPTED_OUT: '알림 미동의', DAILY_CAP: '일일 한도',
  NO_LONGER_MATCHES: '조건 변경', DUPLICATE_NOTICE: '이미 등록된 공지', REMINDER_PRIORITY: '자동 알림 우선',
  WINDOW_EXPIRED: '발송 시간 만료', OPERATOR_INACTIVE: '요청자 권한 만료',
  PAUSED_WINDOW_SKIPPED: '발송 일시정지 중 예약 시각 경과',
  NOTICE_UNAVAILABLE: '공지 비공개 또는 만료', CANCEL_REQUESTED: '운영자 취소', LOCAL_PROCESSING_ERROR: '로컬 처리 오류',
  NO_DEVICE: '유효한 푸시 기기 없음',
}
const deliveryLabels: Record<string, string> = {
  WAITING: '대기', LOCAL_INBOX: '앱 알림함 등록', EXCLUDED: '제외', CANCELED: '취소', FAILED: '실패',
}
const deviceLabels: Record<string, string> = {
  WAITING: '대기', SENDING: '처리 중', ACCEPTED: '공급자 접수', SIMULATED: '모의 접수', FAILED: '일시 오류',
  CANCELED: '제외 또는 취소', EXPIRED: '발송 만료', UNKNOWN: '접수 여부 불명', INVALID: '등록 해제', REJECTED: '영구 거절',
}
const toKst = (value?: string) => value ? new Date(new Date(value).valueOf() + 32_400_000).toISOString().slice(0, 16) : undefined

async function decode<T>(response: Response, retry = false) {
  if (response.ok) return response.json() as Promise<T>
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.', 403: '캠페인을 관리할 권한이 없습니다.',
    409: retry ? '재시도 가능한 기기가 없거나 처리 상태가 바뀌었습니다. 결과를 갱신해주세요.'
      : '버전, 공지 공개 상태 또는 미리보기가 변경되었습니다. 다시 조회해주세요.',
    422: retry ? '재시도 사유를 확인해주세요.'
      : '대상과 공지, 예약 시각을 확인해주세요. 예약은 30일 이내 한국시간 09:00~20:00입니다.',
  }
  throw new Error(messages[response.status] ?? '캠페인 요청을 완료하지 못했습니다.')
}

async function write<T>(path: string, method: string, body: object, key?: string) {
  const csrf = await adminFetch('/api/v1/admin/auth/csrf').then(decode<{ headerName: string; token: string }>)
  return adminFetch(root + path, {
    method, headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  }).then((response) => decode<T>(response, key != null))
}

export default function AdminCampaigns() {
  const [rows, setRows] = useState<Campaign[]>([])
  const [segments, setSegments] = useState<Segment[]>([])
  const [notices, setNotices] = useState<Notice[]>([])
  const [editor, setEditor] = useState<Campaign | 'NEW'>()
  const { mark: markUnsaved } = useAdminUnsaved(editor != null)
  const [selection, setSelection] = useState<{ campaign: Campaign; preview: Preview }>()
  const [canceling, setCanceling] = useState<Campaign>()
  const [confirmation, setConfirmation] = useState(false)
  const [reason, setReason] = useState('')
  const [receipt, setReceipt] = useState<Job>()
  const [deliveryCampaign, setDeliveryCampaign] = useState<Campaign>()
  const [deliveryFilter, setDeliveryFilter] = useState<string>()
  const [deliveries, setDeliveries] = useState<Deliveries>()
  const [deliveryError, setDeliveryError] = useState<string>()
  const [deliveryRetry, setDeliveryRetry] = useState<{ reason: string; key: string }>()
  const [retryReceipt, setRetryReceipt] = useState<number>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    const options = { signal: abort.signal }
    void Promise.all([
      adminFetch(root, options).then(decode<Campaign[]>),
      adminFetch('/api/v1/admin/segments', options).then(decode<Segment[]>),
      adminFetch('/api/v1/admin/contents?kind=NOTICE&status=PUBLISHED', options).then(decode<Notice[]>),
    ]).then(([campaigns, saved, published]) => {
      if (abort.signal.aborted) return
      setRows(campaigns)
      setSegments(saved.filter((item) => item.status === 'ACTIVE'))
      setNotices(published)
    }).catch((failure: unknown) => {
      if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '캠페인을 불러오지 못했습니다.')
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false)
    })
    return () => abort.abort()
  }, [revision])

  useEffect(() => {
    if (!deliveryCampaign) return
    const abort = new AbortController()
    const path = root + '/' + deliveryCampaign.id + '/deliveries' + (deliveryFilter ? '?status=' + deliveryFilter : '')
    void adminFetch(path, { signal: abort.signal }).then(decode<Deliveries>).then((value) => {
      if (!abort.signal.aborted) setDeliveries(value)
    }).catch((failure: unknown) => {
      if (!abort.signal.aborted) setDeliveryError(failure instanceof Error ? failure.message : '처리 결과를 불러오지 못했습니다.')
    })
    return () => abort.abort()
  }, [deliveryCampaign, deliveryFilter, revision])

  function openDeliveries(campaign: Campaign) {
    setDeliveries(undefined)
    setDeliveryError(undefined)
    setDeliveryFilter(undefined)
    setDeliveryRetry(undefined)
    setRetryReceipt(undefined)
    setDeliveryCampaign(campaign)
  }

  async function retryDeliveries() {
    if (!deliveryCampaign || !deliveryRetry?.reason.trim()) return
    setBusy(true)
    setDeliveryError(undefined)
    try {
      const receipt = await write<{ requeued: number }>('/' + deliveryCampaign.id + '/deliveries/retry', 'POST',
        { reason: deliveryRetry.reason }, deliveryRetry.key)
      setRetryReceipt(receipt.requeued)
      setDeliveryRetry(undefined)
      setDeliveries(undefined)
      reload()
    } catch (failure) {
      setDeliveryError(failure instanceof Error ? failure.message : '실패 기기를 다시 접수하지 못했습니다.')
    } finally { setBusy(false) }
  }

  function reload() {
    setLoading(true)
    setRevision((value) => value + 1)
  }

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    try { await action() } catch (failure) {
      setError(failure instanceof Error ? failure.message : '요청에 실패했습니다.')
    } finally { setBusy(false) }
  }

  function open(item: Campaign | 'NEW') {
    setSelection(undefined)
    setReceipt(undefined)
    setEditor(item)
    setError(undefined)
  }

  async function save(values: Fields) {
    if (!editor) return
    const [segmentId, segmentVersion] = (values.segmentRef ?? '').split('/')
    if (values.target === 'SEGMENT' && (!segmentId || !segmentVersion)) {
      setError('활성 세그먼트를 선택해주세요.')
      return
    }
    const fields = {
      name: values.name, templateId: 'NTF-06', noticeRevisionId: values.noticeRevisionId,
      segmentId: values.target === 'SEGMENT' ? segmentId : undefined,
      segmentVersion: values.target === 'SEGMENT' ? Number(segmentVersion) : undefined,
      userIds: values.target === 'USERS' ? values.userIds?.trim().split(/[\s,]+/).filter(Boolean) : undefined,
      scheduledAt: values.scheduledAt ? values.scheduledAt + ':00+09:00' : undefined,
    }
    await perform(async () => {
      if (editor === 'NEW') await write('', 'POST', fields)
      else await write('/' + editor.id, 'PATCH', { fields, expectedVersion: editor.version })
      setEditor(undefined)
      reload()
    })
  }

  function preview(campaign: Campaign) {
    setEditor(undefined)
    setReceipt(undefined)
    setSelection(undefined)
    void perform(async () => {
      const value = await write<Preview>('/' + campaign.id + '/preview', 'POST', { expectedVersion: campaign.version })
      setSelection({ campaign, preview: value })
    })
  }

  function confirm() {
    if (!selection) return
    void perform(async () => {
      const job = await write<Job>('/' + selection.campaign.id + '/send', 'POST', {
        previewId: selection.preview.previewId, expectedVersion: selection.campaign.version,
      })
      setReceipt(job)
      setConfirmation(false)
      setSelection(undefined)
      reload()
    })
  }

  function cancel() {
    if (!canceling || !reason.trim()) return
    void perform(async () => {
      await write('/' + canceling.id + '/cancel', 'POST', { expectedVersion: canceling.version, reason })
      setCanceling(undefined)
      setReason('')
      reload()
    })
  }

  return <Card title="CRM 서비스 안내 캠페인">
    <Space orientation="vertical" style={{ display: 'flex' }}>
      <Space wrap>
        <Button loading={loading} disabled={busy} onClick={reload}>목록 갱신</Button>
        <Button type="primary" disabled={busy} onClick={() => open('NEW')}>캠페인 추가</Button>
      </Space>
      {error && <Alert type="error" showIcon title={error} />}
      {receipt && <Alert type="success" title={(statuses[receipt.status] ?? receipt.status) + ' · 작업 ' + receipt.id} />}
      <Table<Campaign> rowKey="id" dataSource={rows} loading={loading} scroll={{ x: 750 }} columns={[
        { title: '캠페인', dataIndex: 'name' },
        { title: '대상', render: (_, item) => item.segmentId ? '세그먼트 조건 버전 ' + item.segmentVersion : '지정 사용자 ' + item.userIds.length + '명' },
        { title: '상태', render: (_, item) => <Tag>{statuses[item.status] ?? item.status}</Tag> },
        { title: '실행 시각 (KST)', render: (_, item) => item.scheduledAt ? time.format(new Date(item.scheduledAt)) : '—' },
        { title: '작업', render: (_, item) => item.status === 'DRAFT' ? <Space wrap>
          <Button disabled={busy} onClick={() => open(item)}>수정</Button>
          <Button disabled={busy} onClick={() => preview(item)}>발송 미리보기</Button>
        </Space> : <Space wrap>
          <Button onClick={() => openDeliveries(item)}>처리 결과</Button>
          {['SCHEDULED', 'QUEUED', 'SENDING'].includes(item.status)
            && <Button disabled={busy} onClick={() => { setCanceling(item); setReason('') }}>취소 요청</Button>}
        </Space> },
      ]} />
      {editor && <Card size="small" title="캠페인 초안">
        <Form<Fields> onValuesChange={markUnsaved} key={editor === 'NEW' ? 'new' : editor.id + '/' + editor.version} layout="vertical" onFinish={save}
          disabled={busy} initialValues={editor === 'NEW' ? { target: 'SEGMENT' } : {
            name: editor.name, target: editor.segmentId ? 'SEGMENT' : 'USERS',
            segmentRef: editor.segmentId ? editor.segmentId + '/' + editor.segmentVersion : undefined,
            userIds: editor.userIds.join('\n'), noticeRevisionId: editor.noticeRevisionId, scheduledAt: toKst(editor.requestedAt),
          }}>
          <div className="admin-user-filters">
            <Form.Item name="name" label="캠페인명" rules={[{ required: true, whitespace: true }]}><Input maxLength={80} /></Form.Item>
            <Form.Item name="noticeRevisionId" label="게시된 공지 버전" rules={[{ required: true }]}>
              <Select options={notices.map((item) => ({ value: item.revisionId, label: item.title + ' · v' + item.revisionNo }))} />
            </Form.Item>
            <Form.Item name="scheduledAt" label="예약 시각 (KST)" extra="비워 두면 즉시 요청합니다. 운영 시간 밖 요청은 다음 09시에 예약됩니다.">
              <Input type="datetime-local" />
            </Form.Item>
            <Form.Item name="target" label="대상 종류">
              <Radio.Group options={[{ value: 'SEGMENT', label: '세그먼트' }, { value: 'USERS', label: '사용자 ID 목록' }]} />
            </Form.Item>
          </div>
          <Form.Item noStyle shouldUpdate={(before, after) => before.target !== after.target}>
            {({ getFieldValue }) => getFieldValue('target') === 'SEGMENT'
              ? <Form.Item name="segmentRef" label="세그먼트 조건 버전" rules={[{ required: true }]}><Select options={[
                  ...segments.map((item) => ({
                    value: item.id + '/' + item.definitionVersion, label: item.name + ' · 조건 버전 ' + item.definitionVersion,
                  })),
                  ...(editor !== 'NEW' && editor.segmentId && !segments.some((item) =>
                    item.id === editor.segmentId && item.definitionVersion === editor.segmentVersion)
                    ? [{ value: editor.segmentId + '/' + editor.segmentVersion, label: '저장한 조건 버전 ' + editor.segmentVersion }] : []),
                ]} /></Form.Item>
              : <Form.Item name="userIds" label="사용자 ID (쉼표 또는 줄바꿈)" rules={[{ required: true, whitespace: true }]}><Input.TextArea /></Form.Item>}
          </Form.Item>
          <Space><Button type="primary" htmlType="submit" loading={busy}>초안 저장</Button>
            <Button onClick={() => setEditor(undefined)}>취소</Button></Space>
        </Form>
      </Card>}
      {selection && <Card size="small" title="발송 미리보기">
        <Space orientation="vertical" style={{ display: 'flex' }}>
          <Typography.Text strong>{selection.campaign.title}</Typography.Text>
          <Typography.Text>{selection.campaign.body}</Typography.Text>
          <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={[
            { key: 'time', label: '실행 시각 (KST)', children: time.format(new Date(selection.preview.executionAt)) },
            { key: 'expires', label: '미리보기 만료 (KST)', children: time.format(new Date(selection.preview.expiresAt)) },
            { key: 'target', label: '대상 조건', span: 'filled', children: selection.campaign.segmentId
              ? (segments.find((item) => item.id === selection.campaign.segmentId)?.name ?? '저장한 세그먼트')
                + ' · 버전 ' + selection.campaign.segmentVersion
              : '지정 사용자 ' + selection.campaign.userIds.length + '명' },
            { key: 'total', label: '조건 일치', children: selection.preview.counts.total },
            { key: 'local', label: '앱 알림함 등록 예상', children: selection.preview.counts.localEligible },
            { key: 'eligible', label: '푸시 수신 예상', children: selection.preview.counts.eligible },
            ...Object.entries(selection.preview.counts.excludedByReason).map(([key, count]) =>
              ({ key, label: excludedLabels[key] ?? key, children: count })),
          ]} />
          <Typography.Text type="secondary">실행 시 대상 조건과 수신 상태를 다시 확인합니다.</Typography.Text>
          <Button type="primary" disabled={busy || selection.preview.counts.localEligible === 0}
            onClick={() => setConfirmation(true)}>총 {selection.preview.counts.localEligible}명 발송 요청</Button>
        </Space>
      </Card>}
    </Space>
    <Modal open={confirmation && selection != null} title="캠페인 작업을 접수할까요?" confirmLoading={busy}
      onOk={confirm} onCancel={() => setConfirmation(false)} okText="접수 확인" cancelText="돌아가기">
      <Typography.Text>앱 알림함 등록 예상 {selection?.preview.counts.localEligible ?? 0}명,
        푸시 수신 예상 {selection?.preview.counts.eligible ?? 0}명입니다.</Typography.Text>
      {error && <Alert type="error" title={error} />}
    </Modal>
    <Modal open={canceling != null} title="캠페인 취소 요청" confirmLoading={busy}
      okButtonProps={{ disabled: !reason.trim() }} onOk={cancel} onCancel={() => setCanceling(undefined)}
      okText="취소 요청" cancelText="돌아가기">
      <Input.TextArea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="취소 사유" />
      {error && <Alert type="error" title={error} />}
    </Modal>
    <Modal open={deliveryCampaign != null} title={(deliveryCampaign?.name ?? '') + ' 처리 결과'}
      onCancel={() => { if (!busy) setDeliveryCampaign(undefined) }} footer={null} width={760}>
      <Space orientation="vertical" style={{ display: 'flex' }}>
        {deliveryError && <Alert type="error" title={deliveryError} />}
        {deliveries?.errorCode && <Alert type="warning" title={excludedLabels[deliveries.errorCode] ?? deliveries.errorCode} />}
        {deliveries && <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }} items={[
          { key: 'waiting', label: '대기', children: deliveries.counts.waiting },
          { key: 'local', label: '앱 알림함 등록', children: deliveries.counts.localInbox },
          { key: 'excluded', label: '제외', children: deliveries.counts.excluded },
          { key: 'canceled', label: '취소', children: deliveries.counts.canceled },
          { key: 'failed', label: '실패', children: deliveries.counts.failed },
          ...Object.entries(deliveries.reasons).map(([key, count]) => ({ key, label: excludedLabels[key] ?? key, children: count })),
        ]} />}
        {deliveries?.deviceCounts && Object.keys(deliveries.deviceCounts).length > 0 && <>
          <Typography.Text strong>기기별 발송 결과</Typography.Text>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }} items={
            Object.entries(deliveries.deviceCounts).map(([key, count]) => ({ key, label: deviceLabels[key] ?? key, children: count }))
          } />
        </>}
        {retryReceipt != null && <Alert type="success" title={`${retryReceipt}개 기기 재시도 접수`} />}
        {!deliveryRetry && (deliveries?.retryableDevices ?? 0) > 0 && <Button
          onClick={() => { setRetryReceipt(undefined); setDeliveryRetry({ reason: '', key: crypto.randomUUID() }) }}>
          실패 기기 {deliveries?.retryableDevices}개 재시도
        </Button>}
        {deliveryRetry && <Space orientation="vertical" style={{ display: 'flex' }}>
          <Input.TextArea aria-label="재시도 사유" placeholder="재시도 사유" maxLength={500} disabled={busy}
            value={deliveryRetry.reason} onChange={(event) => setDeliveryRetry({
              reason: event.target.value, key: crypto.randomUUID(),
            })} />
          <Space wrap>
            <Button type="primary" loading={busy} disabled={!deliveryRetry.reason.trim()} onClick={() => void retryDeliveries()}>재시도 접수</Button>
            <Button disabled={busy} onClick={() => setDeliveryRetry(undefined)}>돌아가기</Button>
          </Space>
        </Space>}
        <Space wrap>
          <Select aria-label="처리 상태" style={{ minWidth: 180 }} value={deliveryFilter ?? 'ALL'}
            options={[{ value: 'ALL', label: '모든 상태' }, ...Object.entries(deliveryLabels).map(([value, label]) => ({ value, label }))]}
            onChange={(value) => {
              setDeliveries(undefined)
              setDeliveryError(undefined)
              setDeliveryFilter(value === 'ALL' ? undefined : value)
            }} />
          <Button onClick={() => { setDeliveryError(undefined); reload() }}>결과 갱신</Button>
          <Typography.Text type="secondary">최근 처리 기록 최대 100건</Typography.Text>
        </Space>
        <Table<Delivery> rowKey="id" dataSource={deliveries?.items ?? []} loading={!deliveries && !deliveryError}
          size="small" scroll={{ x: 620 }} pagination={{ pageSize: 10, showSizeChanger: false }} columns={[
            { title: '수신자', dataIndex: 'recipient' },
            { title: '상태', render: (_, row) => deliveryLabels[row.status] ?? row.status },
            { title: '사유', render: (_, row) => row.reason ? excludedLabels[row.reason] ?? row.reason : '—' },
            { title: '기기 결과', render: (_, row) => Object.entries(row.devices ?? {}).map(([key, count]) =>
              `${deviceLabels[key] ?? key} ${count}`).join(' · ') || '—' },
            { title: '갱신 시각 (KST)', render: (_, row) => time.format(new Date(row.updatedAt)) },
          ]} />
      </Space>
    </Modal>
  </Card>
}
