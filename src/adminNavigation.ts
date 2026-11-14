import { createContext, useContext, useEffect, useRef } from 'react'

export const AdminDirtyContext = createContext<Set<symbol> | null>(null)

export type CampaignTargetPreview = { previewId: string; total: number; eligible: number; excluded: number; expiresAt: string }
export type CampaignDraftTarget = string[] | CampaignTargetPreview

export const userIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const dateFilter = /^\d{4}-\d{2}-\d{2}$/
const userFilterPatterns = {
  userId: userIdPattern, diagnosisId: userIdPattern, tagId: userIdPattern,
  type: /^(DEBT|INCOME|EMERGENCY_FUND|FIXED_COST|FUTURE|FAMILY)$/,
  age: /^(19_22|23_25|26_29|30_PLUS)$/,
  status: /^(ACTIVE|WITHDRAWAL_PENDING)$/,
  from: dateFilter, to: dateFilter,
}
export type UserFilters = Partial<Record<keyof typeof userFilterPatterns, string>> & { includeNoDiagnosis?: boolean }

export function userListQuery(search: string) {
  const source = new URLSearchParams(search)
  const query = new URLSearchParams()
  for (const [key, pattern] of Object.entries(userFilterPatterns)) {
    const value = source.get(key)?.trim()
    if (value && pattern.test(value)) query.set(key, value)
  }
  if (source.get('includeNoDiagnosis') === 'true') query.set('includeNoDiagnosis', 'true')
  const page = Number(source.get('page'))
  if (Number.isInteger(page) && page > 1 && page <= 2147483647) query.set('page', String(page))
  return query
}

export function useAdminUnsaved(active: boolean) {
  const changes = useContext(AdminDirtyContext)
  const key = useRef(Symbol('unsaved'))
  useEffect(() => {
    const current = key.current
    if (!active) changes?.delete(current)
    return () => { changes?.delete(current) }
  }, [active, changes])
  return {
    mark: () => { if (active) changes?.add(key.current) },
    clear: () => changes?.delete(key.current),
  }
}
