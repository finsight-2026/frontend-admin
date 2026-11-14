import { Alert, Button, Result, Space, Spin, Tag } from 'antd'
import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from 'react'
import { AdminDirtyContext, userListQuery, type CampaignDraftTarget } from './adminNavigation'
import { adminRequestDelay } from './adminFetch'
import AdminScreenErrorBoundary from './AdminScreenErrorBoundary'

const AdminNotices = lazy(() => import('./AdminNotices'))
const AdminNews = lazy(() => import('./AdminNews'))
const AdminAudit = lazy(() => import('./AdminAudit'))
const AdminEvents = lazy(() => import('./AdminEvents'))
const AdminContentPerformance = lazy(() => import('./AdminContentPerformance'))
const AdminExperiments = lazy(() => import('./AdminExperiments'))
const AdminComparison = lazy(() => import('./AdminComparison'))
const AdminDiagnosisFunnel = lazy(() => import('./AdminDiagnosisFunnel'))
const AdminDashboard = lazy(() => import('./AdminDashboard'))
const AdminCampaigns = lazy(() => import('./AdminCampaigns'))
const AdminJobs = lazy(() => import('./AdminJobs'))
const AdminOperatingSettings = lazy(() => import('./AdminOperatingSettings'))
const AdminAccounts = lazy(() => import('./AdminAccounts'))
const AdminSegments = lazy(() => import('./AdminSegments'))
const AdminUsers = lazy(() => import('./AdminUsers'))

type Role = 'ANALYST' | 'OPERATOR' | 'PRIVACY' | 'SUPER_ADMIN'
type Entry = { key: string; title: string; roles: Role[] }

const allRoles: Role[] = ['ANALYST', 'OPERATOR', 'PRIVACY', 'SUPER_ADMIN']
const groups: { label: string; entries: Entry[] }[] = [
  { label: '분석', entries: [
    { key: 'dashboard', title: '대시보드', roles: allRoles },
    { key: 'funnel', title: '진단 퍼널', roles: allRoles },
    { key: 'content-performance', title: '콘텐츠 성과', roles: ['ANALYST', 'OPERATOR'] },
  ] },
  { label: '사용자', entries: [
    { key: 'users', title: '사용자 목록', roles: ['OPERATOR', 'PRIVACY'] },
  ] },
  { label: '운영', entries: [
    { key: 'news', title: '경제 뉴스', roles: ['OPERATOR', 'SUPER_ADMIN'] },
    { key: 'insights', title: '행동 인사이트', roles: ['ANALYST', 'OPERATOR', 'SUPER_ADMIN'] },
    { key: 'guides', title: '맞춤 가이드', roles: ['ANALYST', 'OPERATOR', 'SUPER_ADMIN'] },
    { key: 'notices', title: '서비스 공지', roles: ['ANALYST', 'OPERATOR', 'SUPER_ADMIN'] },
    { key: 'comparison', title: '비교 공개', roles: ['OPERATOR', 'SUPER_ADMIN'] },
    { key: 'segments', title: '세그먼트', roles: ['OPERATOR'] },
    { key: 'campaigns', title: 'CRM 캠페인', roles: ['OPERATOR'] },
    { key: 'jobs', title: '작업 모니터', roles: ['ANALYST', 'OPERATOR', 'PRIVACY'] },
  ] },
  { label: '설정', entries: [
    { key: 'accounts', title: '관리자 계정', roles: ['SUPER_ADMIN'] },
    { key: 'settings', title: '운영 설정', roles: ['SUPER_ADMIN'] },
    { key: 'audit', title: '감사 기록', roles: ['PRIVACY', 'SUPER_ADMIN'] },
    { key: 'events', title: '앱 이벤트', roles: ['OPERATOR'] },
    { key: 'experiments', title: '실험 관리', roles: ['ANALYST', 'OPERATOR', 'SUPER_ADMIN'] },
  ] },
]
const entries = groups.flatMap((group) => group.entries)
const pathFor = (key: string) => '/admin/' + key
const defaultPath = pathFor('dashboard')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const guideKey = /^[A-Za-z0-9_-]{1,80}$/
const editorialRoutes = { NEWS: 'news', GUIDE: 'guides', INSIGHT: 'insights' } as const

function editorialSelection(key: string, params: URLSearchParams) {
  const id = params.get('id')
  if (!id || !(key === 'guides' ? guideKey : uuid).test(id)) return undefined
  const raw = params.get('revision')
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : null
  const revision = value !== null && value > 0 && value <= 2147483647 ? value : null
  return { id, revision }
}

function editorialPath(key: string, id: string, revision: number | null) {
  const params = new URLSearchParams({ id })
  if (revision !== null) params.set('revision', String(revision))
  return pathFor(key) + '?' + params
}

function initialPath() {
  const { pathname, search } = window.location
  if (pathname === '/' || pathname === '/admin' || pathname === '/admin/') return defaultPath
  if (pathname === pathFor('users') || pathname.startsWith(pathFor('users') + '/')) {
    const query = userListQuery(search).toString()
    return pathname + (query ? '?' + query : '')
  }
  if (pathname === pathFor('jobs')) {
    const id = new URLSearchParams(search).get('id')
    return id && uuid.test(id) ? pathname + '?id=' + id : pathname
  }
  const key = Object.values(editorialRoutes).find((entry) => pathFor(entry) === pathname)
  const selection = key ? editorialSelection(key, new URLSearchParams(search)) : undefined
  return key && selection ? editorialPath(key, selection.id, selection.revision) : pathname
}

type Props = {
  identity: { admin: { id: string; name: string }; permissions: string[] }
  busy: boolean
  error?: string
  logout: () => void
  onSelfChanged: () => void
}

export default function AdminWorkspace({ identity, busy, error, logout, onSelfChanged }: Props) {
  const [path, setPath] = useState(initialPath)
  const [campaignTarget, setCampaignTarget] = useState<CampaignDraftTarget>()
  const [menuOpen, setMenuOpen] = useState(false)
  const [delays, setDelays] = useState<Map<symbol, (() => void) | undefined>>(() => new Map())
  const [dirty] = useState(() => new Set<symbol>())
  const index = useRef(0)
  const restoring = useRef(false)
  const main = useRef<HTMLElement>(null)
  const menuToggle = useRef<HTMLButtonElement>(null)
  const route = new URL(path, window.location.origin)
  const userId = route.pathname.startsWith('/admin/users/') ? route.pathname.slice('/admin/users/'.length) : undefined
  const current = entries.find((entry) => pathFor(entry.key) === route.pathname)
    ?? (userId && uuid.test(userId) ? entries.find((entry) => entry.key === 'users') : undefined)
  const canAccess = (entry: Entry) => entry.roles.some((role) => identity.permissions.includes(role))
  const operator = identity.permissions.includes('OPERATOR')
  const supervisor = identity.permissions.includes('SUPER_ADMIN')
  const privacy = identity.permissions.includes('PRIVACY')
  const analyst = identity.permissions.includes('ANALYST')
  const actorId = identity.admin.id

  useEffect(() => {
    index.current = history.state?.finsightAdminIndex ?? 0
    history.replaceState({ finsightAdminIndex: index.current }, '', initialPath())

    function onPop(event: PopStateEvent) {
      const next = event.state?.finsightAdminIndex
      if (restoring.current) {
        restoring.current = false
        return
      }
      if (dirty.size && !window.confirm('저장하지 않은 변경사항이 있어요. 이 화면을 나갈까요?')) {
        const delta = typeof next === 'number' ? index.current - next : 1
        if (delta) {
          restoring.current = true
          history.go(delta)
        }
        return
      }
      dirty.clear()
      index.current = typeof next === 'number' ? next : 0
      const destination = initialPath()
      history.replaceState({ finsightAdminIndex: index.current }, '', destination)
      setPath(destination)
      setCampaignTarget(undefined)
      setMenuOpen(false)
    }

    function onUnload(event: BeforeUnloadEvent) {
      if (!dirty.size) return
      event.preventDefault()
      event.returnValue = ''
    }

    function onDelay(event: Event) {
      const { id, pending, retry } = (event as CustomEvent<{ id: symbol; pending: boolean; retry?: () => void }>).detail
      setDelays((previous) => {
        const next = new Map(previous)
        if (pending) next.set(id, retry)
        else next.delete(id)
        return next
      })
    }

    window.addEventListener('popstate', onPop)
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener(adminRequestDelay, onDelay)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener(adminRequestDelay, onDelay)
    }
  }, [dirty])

  function mayLeave() {
    return dirty.size === 0 || window.confirm('저장하지 않은 변경사항이 있어요. 이 화면을 나갈까요?')
  }

  function navigate(destination: string, target?: CampaignDraftTarget) {
    if (destination === path) {
      setMenuOpen(false)
      return
    }
    if (!mayLeave()) return
    dirty.clear()
    history.pushState({ finsightAdminIndex: ++index.current }, '', destination)
    setPath(destination)
    setCampaignTarget(target)
    setMenuOpen(false)
    window.scrollTo(0, 0)
    main.current?.focus({ preventScroll: true })
  }

  function link(event: MouseEvent<HTMLAnchorElement>, destination: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(destination)
  }

  function page(key: string) {
    switch (key) {
      case 'dashboard': return <AdminDashboard analyst={analyst} navigate={navigate} />
      case 'funnel': return <AdminDiagnosisFunnel />
      case 'content-performance': return <AdminContentPerformance openJobs={analyst ? (id) => {
        if (uuid.test(id)) navigate(pathFor('jobs') + '?id=' + id)
      } : undefined}
        openEditorial={operator ? (kind, id, revision) => {
        const target = editorialRoutes[kind]
        if ((kind === 'GUIDE' ? guideKey : uuid).test(id)) navigate(editorialPath(target, id, revision))
      } : undefined} />
      case 'users': return <AdminUsers actorId={actorId} operator={operator} supervisor={supervisor} privacy={privacy}
        userId={userId} search={route.search} onStartCampaign={(ids) => navigate(pathFor('campaigns'), ids)}
        onOpenJob={(id) => { if (uuid.test(id)) navigate(pathFor('jobs') + '?id=' + id) }}
        onSelect={(id, query = route.searchParams) => {
          const search = userListQuery(query.toString()).toString()
          navigate(pathFor('users') + (id && uuid.test(id) ? '/' + id : '') + (search ? '?' + search : ''))
        }} />
      case 'news': return <AdminNews key={key + route.search} actorId={actorId} operator={operator} supervisor={supervisor}
        selection={editorialSelection(key, route.searchParams)} />
      case 'insights':
      case 'guides': return <AdminNotices key={key + route.search} kind={key === 'guides' ? 'GUIDE' : 'INSIGHT'}
        actorId={actorId} operator={operator} supervisor={supervisor} selection={editorialSelection(key, route.searchParams)} />
      case 'notices': return <AdminNotices key="notices" actorId={actorId} operator={operator} supervisor={supervisor} />
      case 'comparison': return <AdminComparison operator={operator} supervisor={supervisor} />
      case 'segments': return <AdminSegments />
      case 'campaigns': return <AdminCampaigns initialTarget={campaignTarget} />
      case 'jobs': return <AdminJobs key={route.search} jobId={route.searchParams.get('id') ?? undefined}
        operator={operator} privacy={privacy} analyst={analyst} />
      case 'accounts': return <AdminAccounts self={actorId} onSelfChanged={onSelfChanged} />
      case 'settings': return <AdminOperatingSettings />
      case 'audit': return <AdminAudit />
      case 'events': return <AdminEvents />
      case 'experiments': return <AdminExperiments operator={operator} supervisor={supervisor} />
      default: return null
    }
  }

  const readRetries = [...delays.values()].filter((retry) => retry !== undefined)
  return <AdminDirtyContext.Provider value={dirty}>
    <a className="admin-skip-link" href="#admin-page" onClick={(event) => {
      event.preventDefault()
      main.current?.focus()
    }}>본문으로 바로가기</a>
    <header className="admin-header">
      <a className="admin-brand" href={defaultPath} onClick={(event) => link(event, defaultPath)}>FINSIGHT 관리자</a>
      <Space wrap size="small">
        <span className="admin-identity">{identity.admin.name}</span>
        {identity.permissions.map((role) => <Tag key={role}>{role}</Tag>)}
        <Button size="small" loading={busy} onClick={() => { if (mayLeave()) logout() }}>로그아웃</Button>
      </Space>
    </header>
    <div className="admin-workspace">
      <aside className="admin-sidebar" onKeyDown={(event) => {
        if (event.key !== 'Escape' || !menuOpen || !menuToggle.current?.getClientRects().length) return
        event.preventDefault()
        setMenuOpen(false)
        menuToggle.current.focus()
      }}>
        <Button ref={menuToggle} className="admin-menu-toggle" aria-controls="admin-menu" aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}>관리 메뉴</Button>
        <nav id="admin-menu" aria-label="관리 메뉴" className={menuOpen ? 'admin-menu is-open' : 'admin-menu'}>
          {groups.map(({ label, entries }) => {
            const visible = entries.filter(canAccess)
            return visible.length > 0 && <section key={label} aria-label={label}>
              <h2>{label}</h2>
              <ul>{visible.map((entry) => <li key={entry.key}>
                <a href={pathFor(entry.key)} aria-current={current?.key === entry.key ? 'page' : undefined}
                  onClick={(event) => link(event, pathFor(entry.key))}>{entry.title}</a>
              </li>)}</ul>
            </section>
          })}
        </nav>
      </aside>
      <main id="admin-page" className="admin-page" ref={main} tabIndex={-1} aria-label={userId ? '사용자 상세' : current?.title ?? '관리자 백오피스'}>
        {error && <Alert title={error} type="error" showIcon />}
        {delays.size > 0 && <Alert type="info" showIcon title="응답이 10초 이상 지연되고 있어요."
          action={readRetries.length > 0 && <Button size="small" onClick={() => readRetries.forEach((retry) => retry())}>조회 재시도</Button>} />}
        <AdminScreenErrorBoundary key={current?.key}>
          <Suspense fallback={<Spin aria-label="화면을 불러오는 중" />}>
            {!current ? <Result status="404" title="페이지를 찾을 수 없어요." />
              : !canAccess(current) ? <Result status="403" title="이 화면에 접근할 권한이 없어요." />
              : page(current.key)}
          </Suspense>
        </AdminScreenErrorBoundary>
      </main>
    </div>
  </AdminDirtyContext.Provider>
}
