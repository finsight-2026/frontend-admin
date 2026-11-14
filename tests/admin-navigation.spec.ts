import { expect, test, type Page } from '@playwright/test'

const adminId = '7f85fdc9-0dce-48ec-9fee-98ff37e52e2b'
const targetUser = 'a05e15d5-dad5-4636-ac38-a849118663f7'
const capability = { screenId: 'B_006', variants: ['SUMMARY_FIRST', 'RESTART_FIRST'], enabled: true }

async function fixture(page: Page, permissions: string[], name = '테스트 관리자') {
  const paths: string[] = []
  await page.route('**/api/v1/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1/admin', '')
    paths.push(path)
    switch (path) {
      case '/auth/me':
        await route.fulfill({ json: { admin: { id: adminId, name }, permissions } })
        break
      case '/auth/csrf':
        await route.fulfill({ json: { token: 'fixture', headerName: 'X-XSRF-TOKEN' } })
        break
      case '/auth/activity':
        await route.fulfill({ status: 204 })
        break
      case '/dashboard':
        await route.fulfill({ json: {} })
        break
      case '/experiments':
        await route.fulfill({ json: { items: [], capability } })
        break
      case '/users':
      case '/news/page':
      case '/contents/page':
        await route.fulfill({ json: { items: [], page: 1, size: 20, total: 0 } })
        break
      case '/users/' + targetUser:
        await route.fulfill({ json: {
          user: { id: targetUser, maskedEmail: 't***', status: 'ACTIVE', diagnosisCount: 0, tags: [] },
          profile: {}, consents: [], recentDiagnoses: [],
        } })
        break
      default:
        await route.fulfill({ json: [] })
    }
  })
  return paths
}

test('filtered user export previews the applied filters before opening its job', async ({ page }) => {
  await fixture(page, ['OPERATOR'])
  await page.route('**/api/v1/admin/users?*', (route) => route.fulfill({ json: {
    items: [], page: 1, size: 20, total: 25,
  } }))
  const submissions: unknown[] = []
  await page.route('**/api/v1/admin/exports/masked-users/preview', (route) => {
    expect(route.request().postDataJSON()).toEqual({ includeNoDiagnosis: true })
    return route.fulfill({ json: {
      previewId: targetUser, total: 25, eligible: 24, excluded: 1, expiresAt: '2026-11-14T01:00:00Z',
    } })
  })
  await page.route('**/api/v1/admin/exports/masked-users', (route) => {
    submissions.push(route.request().postDataJSON())
    return route.fulfill({
    status: 202, json: { id: adminId, status: 'QUEUED', format: 'CSV' },
    })
  })
  await page.route('**/api/v1/admin/jobs/' + adminId, (route) => route.fulfill({ json: {
    id: adminId, kind: 'MASKED_USERS', status: 'COMPLETED', scope: 'MASKED_USERS',
    processed: 1, total: 1, retryCount: 0, overdue: false,
  } }))
  await page.goto('/admin/users?includeNoDiagnosis=true')
  await page.getByRole('button', { name: '필터 전체 사용자 CSV' }).click()
  await expect(page.getByText('CSV 내보내기 24명 · 제외 1명')).toBeVisible()
  expect(submissions).toEqual([])
  const pending = page.waitForRequest((request) => request.url().endsWith('/exports/masked-users'))
  await page.getByRole('button', { name: '확정된 대상으로 CSV 요청' }).click()
  const request = await pending
  expect(request.postDataJSON()).toEqual({ previewId: targetUser })
  expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
  await expect(page).toHaveURL(new RegExp('/admin/jobs\\?id=' + adminId + '$'))
  await expect(page.getByRole('button', { name: '사용자 목록 CSV 다운로드' })).toBeVisible()
})

test('filtered CRM drafts use a server preview rather than user IDs', async ({ page }) => {
  await fixture(page, ['OPERATOR'])
  await page.route('**/api/v1/admin/users?*', (route) => route.fulfill({ json: { items: [], page: 1, size: 20, total: 25 } }))
  await page.route('**/api/v1/admin/campaigns/target-preview', (route) => route.fulfill({ json: {
    previewId: targetUser, total: 25, eligible: 24, excluded: 1, expiresAt: '2026-11-14T23:59:00+09:00',
  } }))
  await page.route('**/api/v1/admin/contents?*', (route) => route.fulfill({ json: [
    { revisionId: adminId, title: '점검 안내', revisionNo: 1 },
  ] }))
  await page.route('**/api/v1/admin/campaigns/from-target-preview', (route) => route.fulfill({
    status: 201, json: { id: adminId },
  }))
  await page.goto('/admin/users?includeNoDiagnosis=true')
  const preview = page.waitForRequest((request) => request.url().endsWith('/target-preview'))
  await page.getByRole('button', { name: '필터 전체 CRM 대상 확인' }).click()
  expect((await preview).postDataJSON()).toEqual({ includeNoDiagnosis: true })
  await expect(page.getByText('검색 결과 25명 · 활성 계정 24명 · 제외 1명')).toBeVisible()
  await page.getByRole('button', { name: '확정된 대상으로 CRM 초안 작성' }).click()
  await expect(page).toHaveURL(/\/admin\/campaigns$/)
  await expect(page.getByText('필터에서 확정한 활성 계정 24명')).toBeVisible()
  await page.getByLabel('캠페인명').fill('필터 대상 CRM')
  await page.getByRole('combobox', { name: '게시된 공지 버전' }).click()
  await page.getByText('점검 안내 · v1', { exact: true }).click()
  const save = page.waitForRequest((request) => request.url().endsWith('/from-target-preview'))
  await page.getByRole('button', { name: '초안 저장' }).click()
  const request = await save
  expect(request.postDataJSON()).toEqual({ previewId: targetUser, name: '필터 대상 CRM', noticeRevisionId: adminId })
  expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
  await expect(page.getByRole('button', { name: '초안 저장' })).toHaveCount(0)
})

test('selected users prefill a CRM draft without sending or saving', async ({ page }) => {
  const paths = await fixture(page, ['OPERATOR'])
  await page.route('**/api/v1/admin/users?*', (route) => route.fulfill({ json: {
    items: [targetUser, adminId].map((id) => ({
      id, maskedEmail: 't***', createdAt: '2026-11-11T00:00:00Z', status: 'ACTIVE', diagnosisCount: 0, tags: [],
    })),
    page: 1, size: 20, total: 2,
  } }))
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/admin/campaigns')) writes.push(request.url())
  })
  await page.goto('/admin/users')
  const action = page.getByRole('button', { name: /으로 CRM 초안 작성/ })
  await expect(action).toBeDisabled()
  await page.getByRole('row').filter({ hasText: targetUser }).getByRole('checkbox').check()
  await expect(action).toHaveText('선택한 사용자 1명으로 CRM 초안 작성')
  await action.click()
  await expect(page).toHaveURL(/\/admin\/campaigns$/)
  const userIds = page.getByLabel('사용자 ID (쉼표 또는 줄바꿈)')
  await expect(userIds).toHaveValue(targetUser)
  expect(writes).toEqual([])
  expect(paths).toContain('/campaigns')
  await page.reload()
  await expect(userIds).toHaveCount(0)
})

test('comparison review shows the live sample and confirms publication before submitting', async ({ page }) => {
  await fixture(page, ['SUPER_ADMIN'])
  const root = '**/api/v1/admin/comparison-snapshots'
  const live = {
    id: adminId, type: 'DEBT', from: '2026-10-01', to: '2026-10-30', formulaVersion: 'yfsi-v1',
    datasetVersion: 1, sampleSize: 35, excludedSize: 0, status: 'APPROVED', version: 2, metrics: {},
  }
  const draft = { ...live, id: targetUser, from: '2026-11-01', to: '2026-11-13', sampleSize: 29, status: 'IN_REVIEW' }
  const writes: object[] = []
  await page.route(root, (route) => route.fulfill({ json: [draft, live] }))
  await page.route(root + '/settings', (route) => route.fulfill({ json: [{ type: 'DEBT', minimum: 30, version: 1 }] }))
  await page.route(root + '/*/preview', (route) => route.fulfill({ json: {
    version: 2,
    metrics: route.request().url().includes(live.id) ? { YFSI_MEAN: 51 } : {},
    startsAt: null, endsAt: null,
  } }))
  await page.route(root + '/publications', (route) => route.fulfill({ json: [{
    id: adminId, snapshotId: live.id, type: 'DEBT', status: 'ACTIVE',
    startsAt: '2026-11-11T00:00:00Z', endsAt: '2026-11-30T00:00:00Z',
  }] }))
  await page.route(root + '/*/transitions', async (route) => {
    writes.push(route.request().postDataJSON())
    await route.fulfill({ json: live })
  })
  await page.goto('/admin/comparison')
  await page.getByRole('row').filter({ hasText: '검토 중' }).getByRole('button', { name: '부채부담형' }).click()
  await expect(page.getByText('표본이 공개 최소 기준에 미달해요.')).toBeVisible()
  await expect(page.getByText('2026-10-01 ~ 2026-10-30 · 35명 · yfsi-v1')).toBeVisible()
  await expect(page.getByRole('button', { name: '승인', exact: true })).toBeDisabled()
  await expect(page.getByRole('region', { name: '앱 공개 지표 미리보기' })).toHaveText(/공개 가능한 지표가 없어요/)
  await page.getByRole('button', { name: '집계 보기' }).click()
  await expect(page.getByRole('region', { name: '앱 공개 지표 미리보기' })).toHaveText(/YFSI 평균 · 51점/)
  await page.getByRole('combobox', { name: '공개 작업' }).click()
  await page.getByText('비공개', { exact: true }).click()
  await page.getByLabel('비공개 사유').fill('공개 기간과 공지 정합성을 재검토합니다.')
  await page.getByRole('button', { name: '공개 작업 적용' }).click()
  const confirmation = page.getByRole('dialog', { name: '비공개 확인' })
  await expect(confirmation).toBeVisible()
  expect(writes).toHaveLength(0)
  await confirmation.getByRole('button', { name: '비공개', exact: true }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toMatchObject({ action: 'UNPUBLISH', expectedVersion: 2 })
})

test('keyboard focus stays visible and the workspace fits enlarged text on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await fixture(page, ['OPERATOR', 'ANALYST'], '운영관리자'.repeat(10))
  await page.goto('/admin/experiments')
  await page.addStyleTag({ content: 'html { font-size: 200% }' })
  const main = page.getByRole('main', { name: '실험 관리' })
  await expect(main).toBeVisible()
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: '본문으로 바로가기' })
  await expect(skip).toBeFocused()
  await expect(skip).toHaveCSS('outline-color', 'rgb(200, 255, 0)')
  await page.keyboard.press('Enter')
  await expect(main).toBeFocused()
  const menu = page.getByRole('button', { name: '관리 메뉴' })
  await menu.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '대시보드' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeFocused()
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  await expect(page.locator('.admin-header')).toHaveCSS('border-bottom-color', 'rgb(60, 61, 65)')
})

test('operating settings offer a fresh read after service failure and a save conflict', async ({ page }) => {
  await fixture(page, ['SUPER_ADMIN'])
  let unavailable = true
  let version = 1
  const saves: number[] = []
  await page.route('**/api/v1/admin/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      saves.push(route.request().postDataJSON().expectedVersion)
      version = 2
      await route.fulfill({ status: 409 })
      return
    }
    if (unavailable) {
      await route.fulfill({ status: 503 })
      return
    }
    await route.fulfill({ json: {
      policy: {
        version, comparisonMetrics: [], crmPaused: version === 2, automaticPushPaused: false,
        reminderCap: 1, totalCap: 2, funnelCheck: 1.8, funnelPriority: 2.5, operatorId: null,
      },
      comparisonMinimums: [{ type: 'DEBT', minimum: null }], operators: [],
    } })
  })
  await page.goto('/admin/settings')
  await expect(page.getByRole('alert')).toContainText('일시적으로 연결할 수 없어요')
  unavailable = false
  const reload = page.getByRole('button', { name: '새로고침' })
  await reload.focus()
  await page.keyboard.press('Enter')
  const crm = page.getByRole('switch', { name: 'CRM 발송 일시정지' })
  await expect(crm).toHaveAttribute('aria-checked', 'false')
  await crm.focus()
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: '변경 검토' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('변경 사유').fill('운영 설정 동시 저장 검증을 위한 사유입니다.')
  await dialog.getByRole('button', { name: '설정 저장' }).click()
  await expect(dialog.getByRole('alert')).toContainText('다른 관리자가 수정했어요.')
  await expect(dialog.getByRole('button', { name: '설정 저장' })).toBeDisabled()
  await dialog.getByRole('button', { name: '최신 설정 불러오기' }).click()
  await expect(dialog).toBeHidden()
  await expect(crm).toHaveAttribute('aria-checked', 'true')
  expect(saves).toEqual([1])
})

test('a failed screen import leaves navigation available', async ({ page }) => {
  await fixture(page, ['ANALYST'])
  await page.route('**/src/AdminDashboard.tsx', (route) => route.fulfill({ status: 404 }))
  await page.goto('/admin/dashboard')
  await expect(page.getByText('화면을 열지 못했어요.')).toBeVisible()
  await expect(page.getByRole('button', { name: '새로고침' })).toBeVisible()
  await page.getByRole('link', { name: '실험 관리' }).click()
  await expect(page.getByText('조건에 맞는 항목이 없어요.')).toBeVisible()
})

test('analyst sees permitted sections and a forbidden URL does not load user data', async ({ page }) => {
  const paths = await fixture(page, ['ANALYST'])
  await page.goto('/admin/users/' + targetUser)
  await expect(page.getByText('이 화면에 접근할 권한이 없어요.')).toBeVisible()
  await expect(page.getByRole('link', { name: '사용자 목록' })).toHaveCount(0)
  expect(paths.some((path) => path.startsWith('/users'))).toBe(false)
  await page.getByRole('link', { name: '실험 관리' }).click()
  await expect(page).toHaveURL(/\/admin\/experiments$/)
  await expect(page.getByRole('link', { name: '실험 관리' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('조건에 맞는 항목이 없어요.')).toBeVisible()
  await expect(page.getByRole('button', { name: '실험 초안 만들기' })).toHaveCount(0)
  await page.goBack()
  await expect(page.getByText('이 화면에 접근할 권한이 없어요.')).toBeVisible()
})

test('an operator can open user detail directly and the mobile menu fits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const paths = await fixture(page, ['OPERATOR'])
  await page.goto('/admin/users/' + targetUser)
  await expect(page.getByText('t***', { exact: true })).toBeVisible()
  expect(paths).not.toContain('/users')
  const toggle = page.getByRole('button', { name: '관리 메뉴' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await page.getByRole('link', { name: '실험 관리' }).click()
  await expect(page.getByRole('button', { name: '실험 초안 만들기' })).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.goBack()
  await expect(page.getByText('t***', { exact: true })).toBeVisible()
})

test('user list restores applied filters and pagination after detail and back navigation', async ({ page }) => {
  await fixture(page, ['OPERATOR'])
  const filters: URLSearchParams[] = []
  await page.route('**/api/v1/admin/users?*', async (route) => {
    const params = new URL(route.request().url()).searchParams
    filters.push(params)
    await route.fulfill({ json: {
      items: [{ id: targetUser, maskedEmail: 't***', createdAt: '2026-11-11T00:00:00Z', status: 'ACTIVE', diagnosisCount: 0, tags: [] }],
      page: Number(params.get('page')), size: 20, total: 40,
    } })
  })
  await page.goto('/admin/users?email=private%40example.invalid')
  await expect(page).toHaveURL(/\/admin\/users$/)
  await page.getByLabel('사용자 ID').fill(targetUser)
  await page.getByRole('button', { name: '조회', exact: true }).click()
  await expect(page).toHaveURL(new RegExp('userId=' + targetUser + '$'))
  await page.getByTitle('2', { exact: true }).click()
  await expect(page).toHaveURL(/page=2$/)
  await page.getByRole('button', { name: targetUser }).click()
  await expect(page.getByRole('button', { name: '목록으로' })).toBeVisible()
  await page.getByRole('button', { name: '목록으로' }).click()
  await expect(page.getByLabel('사용자 ID')).toHaveValue(targetUser)
  await expect.poll(() => filters.at(-1)?.get('page')).toBe('2')
  expect(filters.at(-1)?.get('userId')).toBe(targetUser)
  await page.goBack()
  await expect(page.getByRole('button', { name: '목록으로' })).toBeVisible()
  await page.goBack()
  await expect(page.getByLabel('사용자 ID')).toHaveValue(targetUser)
  await expect(page).toHaveURL(/page=2$/)
})

test('cancelling back navigation preserves an unsaved experiment', async ({ page }) => {
  await fixture(page, ['OPERATOR'])
  await page.goto('/')
  await expect(page).toHaveURL(/\/admin\/dashboard$/)
  await page.getByRole('link', { name: '실험 관리' }).click()
  await page.getByRole('button', { name: '실험 초안 만들기' }).click()
  await page.getByLabel('실험명').fill('저장하지 않은 실험')
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.evaluate(() => history.back())
  await expect(page).toHaveURL(/\/admin\/experiments$/)
  await expect(page.getByLabel('실험명')).toHaveValue('저장하지 않은 실험')
  page.once('dialog', (dialog) => dialog.accept())
  await page.evaluate(() => history.back())
  await expect(page).toHaveURL(/\/admin\/dashboard$/)
  await expect(page.getByRole('button', { name: '진단 여정 퍼널 보기' })).toBeVisible()
})

test('retry is offered for delayed reads and a 401 returns to login', async ({ page }) => {
  await page.clock.install()
  await fixture(page, ['OPERATOR'])
  let reads = 0
  let retryAllowed = false
  let release!: () => void
  const delayed = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/v1/admin/experiments', async (route) => {
    reads++
    if (!retryAllowed) {
      await delayed
      await route.fulfill({ json: { items: [], capability } }).catch(() => undefined)
    } else {
      await route.fulfill({ status: 401 })
    }
  })
  try {
    await page.goto('/admin/experiments')
    await expect.poll(() => reads).toBeGreaterThan(0)
    await page.clock.fastForward(10_100)
    const retry = page.getByRole('button', { name: '조회 재시도' })
    await expect(retry).toBeVisible()
    const initialReads = reads
    retryAllowed = true
    await retry.click()
    await expect(page.getByText('세션이 만료되었습니다. 다시 로그인해주세요.')).toBeVisible()
    await expect(page.getByRole('button', { name: '계속' })).toBeVisible()
    expect(reads).toBe(initialReads + 1)
  } finally {
    release()
  }
})

test('guide editing submits the selected types and action fields', async ({ page }) => {
  await fixture(page, ['OPERATOR'])
  await page.route('**/api/v1/admin/contents*', async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 201, json: {} })
    else await route.fulfill({ json: [] })
  })
  await page.goto('/admin/guides')
  await page.getByRole('button', { name: '가이드 작성' }).click()
  await page.getByLabel('제목', { exact: true }).last().fill('가이드 테스트')
  await page.getByLabel('요약', { exact: true }).fill('요약 문구')
  await page.getByLabel('본문', { exact: true }).fill('본문 문구')
  await page.getByLabel('대상 유형', { exact: true }).last().click()
  await page.getByText('부채부담형', { exact: true }).click()
  await page.getByLabel('오늘의 행동', { exact: true }).fill('오늘 할 행동')
  await page.getByLabel('다음 행동', { exact: true }).fill('다음에 할 행동')
  const posted = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/contents'))
  await page.getByRole('button', { name: '초안 저장' }).click()
  expect((await posted).postDataJSON()).toMatchObject({
    kind: 'GUIDE',
    fields: { title: '가이드 테스트', types: ['DEBT'], guideCategory: 'START', todayAction: '오늘 할 행동', nextAction: '다음에 할 행동' },
  })
})

test('insight drafts derive their type and metric from the approved source', async ({ page }) => {
  await fixture(page, ['OPERATOR'])
  const snapshotId = 'fb2cf20a-2245-437b-b00b-47be46642905'
  await page.route('**/api/v1/admin/contents*', async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 201, json: {} })
    else await route.fulfill({ json: [] })
  })
  await page.route('**/api/v1/admin/contents/insight-sources', (route) => route.fulfill({ json: [{
    snapshotId, type: 'DEBT', metricKey: 'EXTERNAL_AREA_MEAN', from: '2026-10-01', to: '2026-10-31',
  }] }))
  await page.goto('/admin/insights')
  await page.getByRole('button', { name: '인사이트 작성' }).click()
  await page.getByLabel('제목', { exact: true }).last().fill('공개 행동 인사이트')
  await page.getByLabel('요약', { exact: true }).fill('요약 문구')
  await page.getByLabel('본문', { exact: true }).fill('본문 문구')
  await page.getByLabel('승인 스냅샷과 지표').click()
  await page.getByText('부채부담형 · 외부 부담 평균', { exact: false }).click()
  await page.getByLabel('집계 설명').fill('공개 집계의 해석')
  const posted = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/contents'))
  await page.getByRole('button', { name: '초안 저장' }).click()
  expect((await posted).postDataJSON()).toMatchObject({
    kind: 'INSIGHT',
    fields: { snapshotId, metricKey: 'EXTERNAL_AREA_MEAN', types: ['DEBT'], insightExplanation: '공개 집계의 해석' },
  })
})

test('content performance exports the applied filter and opens the job monitor', async ({ page }) => {
  await fixture(page, ['ANALYST'])
  const id = '96471470-5037-41a0-9d08-9abcfb5a1889'
  await page.route('**/api/v1/admin/analytics/content-performance?**', (route) => route.fulfill({
    json: { from: '2026-11-01', to: '2026-11-10', completionMonth: '2026-11-01',
      asOf: '2026-11-11T01:00:00Z', observedAt: '2026-10-31T01:00:00Z', provisional: false, items: [] },
  }))
  await page.route('**/api/v1/admin/exports', (route) => route.fulfill({ status: 202, json: { id } }))
  await page.route('**/api/v1/admin/jobs?**', (route) => route.fulfill({ json: { items: [], total: 0, page: 1, size: 20 } }))
  await page.route('**/api/v1/admin/jobs/' + id, (route) => route.fulfill({
    json: { id, kind: 'CONTENT_PERFORMANCE', status: 'QUEUED', scope: 'CONTENT_FILTER',
      processed: 0, total: 1, retryCount: 0 },
  }))
  await page.goto('/admin/content-performance')
  await page.getByLabel('콘텐츠 ID').fill('DEBT-1')
  await page.getByRole('button', { name: '조회', exact: true }).click()
  await page.getByLabel('콘텐츠 ID').fill('DEBT-2')
  const posted = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/exports'))
  await page.getByRole('button', { name: 'PDF 내보내기' }).click()
  const request = await posted
  expect(await request.headerValue('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
  expect(request.postDataJSON()).toMatchObject({ kind: 'CONTENT_PERFORMANCE', format: 'PDF',
    filter: { contentId: 'DEBT-1', from: '2026-11-01', to: '2026-11-10' } })
  await expect(page.getByText('성과 파일 요청을 접수했어요.')).toBeVisible()
  await page.getByRole('button', { name: '작업 모니터' }).click()
  await expect(page).toHaveURL('/admin/jobs?id=' + id)
  await expect(page.getByRole('dialog', { name: '작업 상세' })).toBeVisible()
})

test('operators open the exact guide version from performance and can filter server pages', async ({ page }) => {
  await fixture(page, ['OPERATOR'])
  const id = 'ae071037-42e2-4b60-b522-e2e2406f720e'
  const revisionId = '96471470-5037-41a0-9d08-9abcfb5a1889'
  const updatedAt = '2026-11-11T01:00:00Z'
  const guide = { id, revisionId, revisionNo: 1, publishedRevisionId: revisionId, publishedRevisionNo: 1,
    title: '원래 가이드', status: 'PUBLISHED', updatedAt, types: ['DEBT'], authorId: adminId }
  const requests: URLSearchParams[] = []
  await page.route('**/api/v1/admin/analytics/content-performance?**', (route) => route.fulfill({ json: {
    from: '2026-11-01', to: '2026-11-10', completionMonth: '2026-11-01', asOf: updatedAt, observedAt: updatedAt,
    provisional: false, items: [{ kind: 'GUIDE', contentId: 'DEBT-1', revision: 1, title: '가이드 성과',
      impressions: 10, views: 3, ctrNumerator: 3, ctr: 30, helpful: null, completions: 2 }],
  } }))
  await page.route('**/api/v1/admin/contents/lookup?**', async (route) => {
    const params = new URL(route.request().url()).searchParams
    expect(Object.fromEntries(params)).toEqual({ kind: 'GUIDE', key: 'DEBT-1', revision: '1' })
    await route.fulfill({ json: guide })
  })
  await page.route('**/api/v1/admin/contents/' + id + '/revisions', (route) => route.fulfill({ json: [guide] }))
  await page.route('**/api/v1/admin/contents/' + id + '/preview?**', (route) => route.fulfill({
    json: { title: '공개 당시 가이드', summary: '요약', body: '본문' },
  }))
  await page.route('**/api/v1/admin/contents/page?**', async (route) => {
    const params = new URL(route.request().url()).searchParams
    requests.push(params)
    await route.fulfill({ json: { items: [guide], total: 24, page: Number(params.get('page')), size: 20 } })
  })
  await page.goto('/admin/content-performance')
  await page.getByRole('button', { name: '가이드 성과' }).click()
  await page.getByRole('button', { name: '가이드 운영에서 열기' }).click()
  await expect(page).toHaveURL('/admin/guides?id=DEBT-1&revision=1')
  await expect(page.getByRole('heading', { name: '공개 당시 가이드' })).toBeVisible()
  await page.getByTitle('2', { exact: true }).click()
  await expect.poll(() => requests.at(-1)?.get('page')).toBe('2')
  await page.getByLabel('제목', { exact: true }).fill('월말')
  await page.getByRole('button', { name: '검색', exact: true }).click()
  await expect.poll(() => [requests.at(-1)?.get('page'), requests.at(-1)?.get('q')]).toEqual(['1', '월말'])
})

test('news drafts attach only the validated upload id', async ({ page }) => {
  await fixture(page, ['OPERATOR'])
  const id = 'ae071037-42e2-4b60-b522-e2e2406f720e'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOM2qfDwMDAxAAGAA+IAUiQgQ3tAAAAAElFTkSuQmCC', 'base64')
  await page.route('**/api/v1/admin/news', async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 201, json: { id, revision: 1 } })
    else await route.fulfill({ json: [] })
  })
  await page.route('**/api/v1/admin/media', (route) => route.fulfill({ status: 201, json: { mediaId: id, status: 'READY' } }))
  await page.route('**/api/v1/admin/media/' + id + '/file', (route) => route.fulfill({ contentType: 'image/png', body: png }))
  await page.goto('/admin/news')
  await page.getByRole('button', { name: '새 기사 초안' }).click()
  await page.getByLabel('한국경제 원문 URL').fill('https://www.hankyung.com/article/100')
  await page.getByLabel('기사 제목').fill('이미지가 있는 기사')
  await page.getByLabel('기사 발행 (KST)').fill('2026-11-11T10:00')
  await page.getByLabel('대상 유형', { exact: true }).click()
  await page.getByText('부채부담형', { exact: true }).click()
  await page.getByLabel('핵심 요약').fill('기사 요약')
  await page.getByLabel('한눈에 보기').fill('기사 본문')
  await page.getByLabel('관련 이유').fill('가계에 관련된 이유')
  await page.getByLabel('작은 행동').fill('기록을 확인하세요')
  const uploaded = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/media'))
  await page.getByLabel('기사 이미지').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png })
  expect(await (await uploaded).headerValue('content-type')).toContain('multipart/form-data')
  await expect(page.getByRole('img', { name: '기사 이미지 미리보기' })).toBeVisible()
  const saved = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/news'))
  await page.getByRole('button', { name: '초안 저장' }).click()
  expect((await saved).postDataJSON()).toMatchObject({ fields: { mediaId: id } })
})

test('job monitor retries only eligible failures and reuses the key after an uncertain response', async ({ page }, testInfo) => {
  await fixture(page, ['ANALYST'])
  const id = '2f671c72-e054-4221-8fd2-5a70dc090671'
  let status = 'FAILED'
  const job = () => ({ id, kind: 'DASHBOARD_AGGREGATE', status, scope: 'DASHBOARD_FILTER',
    processed: 0, total: 1, retryCount: status === 'FAILED' ? 3 : 4,
    retryable: status === 'FAILED', errorCode: status === 'FAILED' ? 'EXPORT_BUILD_FAILED' : null })
  await page.route('**/api/v1/admin/jobs?**', (route) => route.fulfill({ json: { items: [job()], total: 1, page: 1, size: 20 } }))
  await page.route('**/api/v1/admin/jobs/' + id, (route) => route.fulfill({ json: job() }))
  const keys: Array<string | null> = []
  await page.route('**/api/v1/admin/jobs/' + id + '/retry', async (route) => {
    keys.push(await route.request().headerValue('Idempotency-Key'))
    expect(route.request().postDataJSON()).toEqual({ reason: '파일 생성 장애 복구' })
    if (keys.length === 1) {
      await route.abort()
    } else {
      status = 'QUEUED'
      await route.fulfill({ status: 202, json: { id, status, format: 'CSV' } })
    }
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/jobs?id=' + id)
  const modal = page.getByRole('dialog', { name: '작업 상세' })
  await modal.getByRole('button', { name: '작업 재시도' }).click()
  await modal.getByLabel('재시도 사유').fill('파일 생성 장애 복구')
  await expect(modal.getByRole('button', { name: '재시도 확인' })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('BO-07-retry-confirmation.png') })
  await modal.getByRole('button', { name: '재시도 확인' }).click()
  await expect(modal.getByRole('alert')).toBeVisible()
  await modal.getByRole('button', { name: '재시도 확인' }).click()
  await expect(modal.getByRole('button', { name: '내보내기 취소' })).toBeVisible()
  await expect(modal.getByRole('button', { name: '작업 재시도' })).toHaveCount(0)
  expect(keys).toHaveLength(2)
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
  expect(keys[1]).toBe(keys[0])
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('CRM reports device outcomes and retries confirmed failures once', async ({ page }, testInfo) => {
  await fixture(page, ['OPERATOR'])
  const id = '2f671c72-e054-4221-8fd2-5a70dc090672'
  let retried = false
  const keys: Array<string | null> = []
  await page.route('**/api/v1/admin/campaigns', (route) => route.fulfill({ json: [{
    id, name: '서비스 점검', status: 'COMPLETED', version: 2, userIds: [targetUser],
    noticeRevisionId: id, title: '안내', body: '서비스 점검을 안내합니다.',
  }] }))
  await page.route('**/api/v1/admin/campaigns/' + id + '/deliveries', (route) => route.fulfill({ json: {
    counts: { waiting: 0, localInbox: 1, excluded: 0, canceled: 0, failed: 0 },
    reasons: {},
    deviceCounts: { ACCEPTED: 1, UNKNOWN: 1, [retried ? 'WAITING' : 'FAILED']: 1 },
    retryableDevices: retried ? 0 : 1,
    items: [{ id, recipient: 't***@***', status: 'LOCAL_INBOX', updatedAt: '2026-11-11T10:00:00+09:00', devices: { ACCEPTED: 1 } }],
  } }))
  await page.route('**/api/v1/admin/campaigns/' + id + '/deliveries/retry', async (route) => {
    keys.push(await route.request().headerValue('Idempotency-Key'))
    expect(route.request().postDataJSON()).toEqual({ reason: '일시 장애 복구 확인' })
    retried = true
    if (keys.length === 1) await route.abort()
    else await route.fulfill({ status: 202, json: { requeued: 1 } })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/campaigns')
  await page.getByRole('button', { name: '처리 결과' }).click()
  const modal = page.getByRole('dialog', { name: '서비스 점검 처리 결과' })
  await expect(modal.getByText('접수 여부 불명', { exact: true })).toBeVisible()
  await modal.getByRole('button', { name: '실패 기기 1개 재시도' }).click()
  await modal.getByLabel('재시도 사유').fill('일시 장애 복구 확인')
  await expect(modal.getByRole('button', { name: '재시도 접수' })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('BO-06-device-retry.png'), animations: 'disabled' })
  await modal.getByRole('button', { name: '재시도 접수' }).click()
  await expect(modal.getByRole('alert')).toBeVisible()
  await modal.getByRole('button', { name: '재시도 접수' }).click()
  await expect(modal.getByText('1개 기기 재시도 접수')).toBeVisible()
  await expect(modal.getByRole('button', { name: '실패 기기 1개 재시도' })).toHaveCount(0)
  expect(keys).toHaveLength(2)
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
  expect(keys[1]).toBe(keys[0])
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('CRM preview distinguishes inbox and push estimates before confirmation', async ({ page }, testInfo) => {
  await fixture(page, ['OPERATOR'])
  const id = '2f671c72-e054-4221-8fd2-5a70dc090673'
  await page.route('**/api/v1/admin/campaigns', (route) => route.fulfill({ json: [{
    id, name: '정기 점검', status: 'DRAFT', version: 0, userIds: [targetUser, adminId],
    noticeRevisionId: id, title: 'FINSIGHT 이용 안내가 있어요', body: '서비스 이용에 관한 안내를 확인해주세요.',
  }] }))
  await page.route('**/api/v1/admin/campaigns/' + id + '/preview', (route) => route.fulfill({ json: {
    previewId: id, executionAt: '2026-11-12T09:00:00+09:00', expiresAt: '2026-11-11T21:50:00+09:00',
    counts: { total: 2, eligible: 1, localEligible: 2, excludedByReason: { NO_DEVICE: 1 } },
  } }))
  await page.route('**/api/v1/admin/campaigns/' + id + '/send', (route) => route.fulfill({
    status: 202, json: { id, status: 'SCHEDULED' },
  }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/campaigns')
  await page.getByRole('button', { name: '발송 미리보기' }).click()
  await expect(page.getByText('푸시 수신 예상', { exact: true })).toBeVisible()
  await expect(page.getByText('유효한 푸시 기기 없음', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '총 2명 발송 요청' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('BO-06-preview.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '총 2명 발송 요청' }).click()
  const modal = page.getByRole('dialog', { name: '캠페인 작업을 접수할까요?' })
  await expect(modal.getByText(/앱 알림함 등록 예상 2명,\s*푸시 수신 예상 1명입니다/)).toBeVisible()
  await expect.poll(() => modal.evaluate((element) => {
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).opacity !== '1' || ancestor.getAnimations().some((animation) => animation.playState === 'running')) {
        return false
      }
    }
    return true
  })).toBe(true)
  await modal.screenshot({ path: testInfo.outputPath('BO-06-preview-confirmation.png') })
  const request = page.waitForRequest((candidate) => candidate.method() === 'POST' && candidate.url().endsWith('/send'))
  await modal.getByRole('button', { name: '접수 확인' }).click()
  expect((await request).postDataJSON()).toEqual({ previewId: id, expectedVersion: 0 })
  await expect(page.getByText('예약 접수 · 작업 ' + id)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('privacy monitor shows withdrawal retry and deadline without a manual purge action', async ({ page }, testInfo) => {
  await fixture(page, ['PRIVACY'])
  const id = '2f671c72-e054-4221-8fd2-5a70dc090674'
  const job = {
    id, kind: 'ACCOUNT_WITHDRAWAL', status: 'SCHEDULED', stage: 'PURGE_RETRY_WAIT', scope: 'ACCOUNT',
    dueAt: '2026-11-12T09:30:00+09:00', nextRunAt: '2026-11-12T09:05:00+09:00',
    processed: 0, total: 1, retryCount: 2, retryable: false, errorCode: 'WITHDRAWAL_PURGE_FAILED',
    overdue: false, deadlineWarning: true,
  }
  await page.route('**/api/v1/admin/jobs?**', (route) => route.fulfill({ json: { items: [job], total: 1 } }))
  await page.route('**/api/v1/admin/jobs/' + id, (route) => route.fulfill({ json: job }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/jobs?id=' + id)
  const modal = page.getByRole('dialog', { name: '작업 상세' })
  await expect(modal.getByText('영구 삭제 재시도 대기')).toBeVisible()
  await expect(modal.getByText('처리 기한 1시간 이내')).toBeVisible()
  await expect(modal.getByText('다음 시도 (KST)')).toBeVisible()
  await expect(modal.getByRole('button', { name: '작업 재시도' })).toHaveCount(0)
  await expect(modal.getByText('WITHDRAWAL_PURGE_FAILED')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('BO-07-withdrawal-retry.png'), animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('privacy can requeue an exhausted deletion using the same key after a lost response', async ({ page }, testInfo) => {
  await fixture(page, ['PRIVACY'])
  const id = 'fa7e67e9-fd94-4d7f-ad8c-f91dc3138187'
  const failed = {
    id, kind: 'DATA_DELETION', status: 'FAILED', stage: 'PURGE_REVIEW_REQUIRED', scope: 'SERVICE_DATA',
    processed: 0, total: 1, retryCount: 3, requeueCount: 0, retryable: true,
    errorCode: 'SERVICE_DATA_PURGE_FAILED', overdue: true,
  }
  const accepted = { ...failed, status: 'SCHEDULED', stage: 'AWAITING_PURGE', retryCount: 0, requeueCount: 1, retryable: false }
  let current = failed
  const keys: string[] = []
  await page.route('**/api/v1/admin/jobs?**', (route) => route.fulfill({ json: { items: [current], total: 1 } }))
  await page.route('**/api/v1/admin/jobs/' + id, (route) => route.fulfill({ json: current }))
  await page.route('**/api/v1/admin/deletion-requests/' + id + '/retry', async (route) => {
    const request = route.request()
    keys.push(request.headers()['idempotency-key'])
    expect(request.postDataJSON()).toEqual({ reason: '오류 원인 확인', expectedRequeueCount: 0 })
    current = accepted
    if (keys.length === 1) await route.abort('connectionreset')
    else await route.fulfill({ status: 202, json: accepted })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/jobs?id=' + id)
  const modal = page.getByRole('dialog', { name: '작업 상세' })
  await modal.getByRole('button', { name: '삭제 작업 재접수' }).click()
  const confirm = modal.getByRole('button', { name: '재접수 확인' })
  await expect(confirm).toBeDisabled()
  await modal.getByRole('textbox', { name: '재시도 사유' }).fill('오류 원인 확인')
  await expect(confirm).toBeEnabled()
  await confirm.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('BO-07-deletion-requeue.png'), animations: 'disabled' })
  await confirm.click()
  await expect(confirm).toBeEnabled()
  await expect(modal.getByRole('alert')).toBeVisible()
  await confirm.click()
  await expect(modal.getByText('영구 삭제 대기', { exact: true })).toBeVisible()
  await expect(modal.getByRole('button', { name: '삭제 작업 재접수' })).toHaveCount(0)
  expect(keys).toHaveLength(2)
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
  expect(keys[1]).toBe(keys[0])
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('audit finds denied downloads while keeping the selected target', async ({ page }) => {
  await fixture(page, ['SUPER_ADMIN'])
  await page.route('**/api/v1/admin/audit-logs?**', (route) => {
    const query = new URL(route.request().url()).searchParams
    return route.fulfill({ json: { total: 1, items: [{
      id: adminId, actorId: adminId, roles: ['OPERATOR'], targetType: 'JOB', targetId: targetUser,
      action: query.has('action') ? 'EXPORT_DOWNLOAD_DENIED' : 'MASKED_USERS_EXPORT_DOWNLOADED',
      result: query.get('result') ?? 'SUCCESS',
      changes: query.has('action') ? { httpStatus: 404 } : { format: 'CSV' },
      traceId: targetUser, createdAt: '2026-11-14T00:00:00Z',
    }] } })
  })
  await page.goto('/admin/audit')
  await expect(page.getByRole('cell', { name: '마스킹 사용자 CSV 다운로드' })).toBeVisible()
  await page.getByLabel('대상 ID').fill(targetUser)
  const request = page.waitForRequest((request) => new URL(request.url()).searchParams.get('action') === 'EXPORT_DOWNLOAD_DENIED')
  await page.getByRole('button', { name: '다운로드 거부 조회' }).click()
  const params = new URL((await request).url()).searchParams
  expect(params.get('result')).toBe('FAILURE')
  expect(params.get('targetId')).toBe(targetUser)
  await expect(page.getByRole('cell', { name: '파일 다운로드 거부' })).toBeVisible()
  await expect(page.getByRole('cell', { name: '실패' })).toBeVisible()
})

test('audit identifies administrator MFA recovery as a server console action', async ({ page }, testInfo) => {
  await fixture(page, ['SUPER_ADMIN'])
  await page.route('**/api/v1/admin/audit-logs?**', (route) => route.fulfill({ json: { total: 1, items: [{
    id: '2f671c72-e054-4221-8fd2-5a70dc090675', actorId: adminId, roles: [],
    action: 'ADMIN_SERVER_MFA_RECOVERY', targetType: 'ADMIN_ACCOUNT', targetId: adminId, result: 'SUCCESS',
    changes: { source: 'SERVER_CONSOLE', reason: '마지막 최고관리자 인증 기기 분실' },
    traceId: '2f671c72-e054-4221-8fd2-5a70dc090676', createdAt: '2026-11-11T22:00:00+09:00',
  }] } }))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/admin/audit')
  const row = page.getByRole('row').filter({ hasText: 'ADMIN_SERVER_MFA_RECOVERY' })
  await expect(row.getByRole('cell', { name: '서버 콘솔' })).toBeVisible()
  await expect(row.getByRole('cell', { name: adminId, exact: true })).toHaveCount(0)
  await row.getByRole('button').click()
  await expect(page.getByText(/마지막 최고관리자 인증 기기 분실/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('BO-09-server-mfa-recovery-audit.png'), animations: 'disabled' })
})

test('news candidates prefill a draft and leave editorial fields for the operator', async ({ page }, testInfo) => {
  await fixture(page, ['OPERATOR'])
  const candidate = {
    sourceUrl: 'https://www.hankyung.com/article/930001', title: '가계 지출 점검 기사',
    articlePublishedAt: '2026-11-11T06:30:14+09:00', collectedAt: '2026-11-11T07:00:00+09:00',
  }
  let created = false
  await page.route('**/api/v1/admin/news/candidates', (route) => route.fulfill({ json: {
    items: created ? [] : [candidate], collection: { status: 'COMPLETED', attempts: 1, acceptedCount: 1 },
  } }))
  await page.route('**/api/v1/admin/news', async (route) => {
    created = true
    await route.fulfill({ status: 201, json: {
      ...route.request().postDataJSON().fields, id: targetUser, revision: 1, status: 'DRAFT',
    } })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/news')
  await page.getByRole('button', { name: '수집 후보' }).click()
  await expect(page.getByRole('link', { name: candidate.title })).toHaveAttribute('href', candidate.sourceUrl)
  await page.screenshot({ path: testInfo.outputPath('BO-03-news-candidates.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '후보로 초안 작성' }).click()
  await expect(page.getByLabel('한국경제 원문 URL')).toHaveValue(candidate.sourceUrl)
  await expect(page.getByLabel('기사 제목')).toHaveValue(candidate.title)
  await expect(page.getByLabel('핵심 요약')).toHaveValue('')
  await expect(page.getByLabel('기사 발행 (KST)')).toHaveValue('2026-11-11T06:30')
  expect(created).toBe(false)
  await page.getByLabel('대상 유형', { exact: true }).click()
  await page.getByText('부채부담형', { exact: true }).click()
  await page.getByLabel('핵심 요약').fill('편집한 요약')
  await page.getByLabel('한눈에 보기').fill('편집한 본문')
  await page.getByLabel('관련 이유').fill('지출과 관련이 있어요.')
  await page.getByLabel('작은 행동').fill('지출 내역을 확인해요.')
  const saved = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/news'))
  await page.getByRole('button', { name: '초안 저장' }).click()
  expect((await saved).postDataJSON()).toMatchObject({ fields: {
    sourceUrl: candidate.sourceUrl, articlePublishedAt: candidate.articlePublishedAt, summary: '편집한 요약',
  } })
  await expect(page.getByText('최근 72시간에 작성할 수 있는 후보가 없어요.')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('an archived news draft is hidden until filtered and can seed a new draft', async ({ page }, testInfo) => {
  await fixture(page, ['OPERATOR'])
  let archived = false
  const article = {
    id: targetUser, revision: 1, version: 0, authorId: adminId, publishedRevision: null,
    sourceUrl: 'https://www.hankyung.com/article/930001', title: '보관할 테스트 초안', summary: '편집한 요약',
    body: '편집한 본문', reason: '관련 이유', action: '작은 행동', articlePublishedAt: '2026-11-11T06:30:14+09:00',
    types: ['DEBT'],
  }
  const row = () => ({ ...article, status: archived ? 'ARCHIVED' : 'DRAFT', version: archived ? 1 : 0 })
  await page.route('**/api/v1/admin/news/page?**', (route) => {
    const filter = new URL(route.request().url()).searchParams.get('status')
    const items = archived === (filter === 'ARCHIVED') ? [row()] : []
    return route.fulfill({ json: { items, page: 1, size: 20, total: items.length } })
  })
  await page.route('**/api/v1/admin/news/' + targetUser + '/revisions', (route) => route.fulfill({ json: [row()] }))
  await page.route('**/api/v1/admin/news/' + targetUser + '/1/transitions', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ action: 'ARCHIVE', expectedVersion: 0 })
    expect(await route.request().headerValue('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    archived = true
    await route.fulfill({ json: row() })
  })
  await page.route('**/api/v1/admin/news', (route) => route.fulfill({ status: 201, json: {
    ...row(), status: 'DRAFT', revision: 2, version: 0,
  } }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/news')
  await page.getByRole('button', { name: article.title }).click()
  await page.getByLabel('작업', { exact: true }).click()
  await page.getByText('보관', { exact: true }).click()
  await page.getByRole('button', { name: '작업 적용' }).click()
  await expect(page.getByRole('button', { name: article.title })).toHaveCount(0)
  await page.getByLabel('상태', { exact: true }).click()
  await page.getByText('보관', { exact: true }).last().click()
  await page.getByRole('button', { name: '검색', exact: true }).click()
  await page.getByRole('button', { name: article.title }).click()
  const restore = page.getByRole('button', { name: '보관본에서 새 초안' })
  await restore.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('BO-03-archived-news.png'), animations: 'disabled' })
  await restore.click()
  await expect(page.getByLabel('기사 제목')).toHaveValue(article.title)
  await expect(page.getByLabel('핵심 요약')).toHaveValue(article.summary)
  const saved = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/news'))
  await page.getByRole('button', { name: '초안 저장' }).click()
  expect((await saved).postDataJSON()).toMatchObject({ articleId: targetUser,
    fields: { title: article.title, articlePublishedAt: article.articlePublishedAt },
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('news scheduling requires preview confirmation and submits Korean time', async ({ page }, testInfo) => {
  await fixture(page, ['SUPER_ADMIN'])
  const article = {
    id: targetUser, revision: 2, version: 4, authorId: '2f671c72-e054-4221-8fd2-5a70dc090675', publishedRevision: 1,
    status: 'APPROVED', sourceUrl: 'https://www.hankyung.com/article/930001', title: '예약할 뉴스',
    summary: '기사 요약', body: '기사 본문', reason: '관련 이유', action: '작은 행동',
    articlePublishedAt: '2026-11-11T06:30:14+09:00', types: ['DEBT'],
  }
  let scheduled = false
  const row = () => scheduled ? { ...article, version: 5, status: 'SCHEDULED',
    startsAt: '2026-11-12T07:30:00+09:00', endsAt: '2026-11-12T20:00:00+09:00' } : article
  await page.route('**/api/v1/admin/news/page?**', (route) => route.fulfill({ json: {
    items: [row()], page: 1, size: 20, total: 1,
  } }))
  await page.route('**/api/v1/admin/news/' + targetUser + '/revisions', (route) => route.fulfill({ json: [row()] }))
  await page.route('**/api/v1/admin/news/' + targetUser + '/2/transitions', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      action: 'SCHEDULE', expectedVersion: 4, startsAt: '2026-11-12T07:30:00+09:00',
      endsAt: '2026-11-12T20:00:00+09:00', previewConfirmed: true,
    })
    scheduled = true
    await route.fulfill({ json: row() })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/news')
  await page.getByRole('button', { name: article.title }).click()
  await page.getByLabel('작업', { exact: true }).click()
  await page.getByText('예약 게시', { exact: true }).click()
  await page.getByLabel('공개 시작 (KST)', { exact: true }).fill('2026-11-12T07:30')
  await page.getByLabel('공개 종료 (KST, 선택)', { exact: true }).fill('2026-11-12T20:00')
  await page.getByRole('button', { name: '작업 적용' }).click()
  await expect(page.getByText('미리보기를 확인해 주세요.')).toBeVisible()
  expect(scheduled).toBe(false)
  await page.getByRole('checkbox', { name: '기사 미리보기와 대상 유형을 확인했습니다.' }).check()
  await page.getByRole('button', { name: '작업 적용' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('BO-03-news-schedule.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '작업 적용' }).click()
  await expect(page.getByText('예약', { exact: true }).first()).toBeVisible()
  expect(scheduled).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('news edition selects an exact article revision and submits its expected edition version', async ({ page }, testInfo) => {
  await fixture(page, ['SUPER_ADMIN'])
  const date = '2026-11-12'
  const old = { slot: 1, contentId: targetUser, revisionId: 1 }
  const updated = { ...old, revisionId: 2 }
  const options = [
    { ...old, title: '일간 뉴스', status: 'PUBLISHED' },
    { ...updated, title: '일간 뉴스', status: 'SCHEDULED' },
  ]
  await page.route('**/api/v1/admin/news-editions?**', (route) => route.fulfill({ json: {
    options, slots: [old], version: 3,
  } }))
  await page.route('**/api/v1/admin/news-editions/' + date + '/DEBT', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ slots: [updated], expectedVersion: 3 })
    await route.fulfill({ json: { date, type: 'DEBT', slots: [updated], version: 4 } })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/news')
  await page.getByLabel('편성 날짜 (KST)').fill(date)
  await page.getByLabel('유형', { exact: true }).click()
  await page.getByText('부채부담형', { exact: true }).click()
  await expect(page.getByText('일간 뉴스 · 버전 1 · 게시', { exact: true })).toBeVisible()
  const selection = page.getByLabel('기사 버전 (선택 순서가 슬롯)')
  await selection.click()
  await page.getByText('일간 뉴스 · 버전 1 · 게시', { exact: true }).last().click()
  await page.getByText('일간 뉴스 · 버전 2 · 예약', { exact: true }).click()
  await selection.press('Escape')
  await page.getByRole('button', { name: '편성 저장' }).click()
  await expect(page.getByText('선택한 순서대로 편성을 저장했습니다.')).toBeVisible()
  await page.getByRole('button', { name: '편성 저장' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('BO-03-news-edition-version.png'), animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})
