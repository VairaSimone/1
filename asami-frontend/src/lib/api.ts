import type { AnalysisData, ChatMessage, ChatResponse, Clock, Dashboard, Development, DevelopmentHistoryItem, EventItem, Memory, Simulation, TimelineItem } from '../types'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
const REQUEST_TIMEOUT_MS = 15000

class ApiError extends Error {
  status: number
  details: unknown
  constructor(message: string, status: number, details?: unknown) { super(message); this.name = 'ApiError'; this.status = status; this.details = details }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abortFromCaller = () => controller.abort(); options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } })
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError'; throw new ApiError(aborted ? 'La richiesta al backend è scaduta.' : 'Impossibile raggiungere il backend.', 0)
  } finally { window.clearTimeout(timeout); options.signal?.removeEventListener('abort', abortFromCaller) }
  const text = await response.text(); let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!response.ok) {
    const serverMessage = typeof data === 'object' && data && 'error' in data ? String((data as { error?: unknown }).error) : `HTTP ${response.status}`
    throw new ApiError(serverMessage, response.status, data)
  }
  return data as T
}

export const api = {
  health: () => request<{ ok: boolean; service: string; engineVersion: string }>('/health'),
  simulations: () => request<Simulation[]>('/simulations'),
  simulation: (id: string) => request<Simulation>(`/simulations/${id}`),
  clock: (id: string) => request<{ simulation: Simulation; clock: Clock | null }>(`/simulations/${id}/clock`),
  createSimulation: (payload: Record<string, unknown>) => request<{ simulation: Simulation; asamiEntityId: string }>('/simulations', { method: 'POST', body: JSON.stringify(payload) }),
  pause: (id: string) => request<Simulation>(`/simulations/${id}/pause`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } }),
  resume: (id: string) => request<Simulation>(`/simulations/${id}/resume`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } }),
  stop: (id: string) => request<Simulation>(`/simulations/${id}/stop`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } }),
  speed: (id: string, speed: number) => request<Simulation>(`/simulations/${id}/speed`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ speed }) }),
  asami: (id: string) => request<Dashboard['entity']>(`/simulations/${id}/asami`),
  dashboard: (simulationId: string, entityId: string) => request<Dashboard>(`/simulations/${simulationId}/dashboard/${entityId}`),
  analysis: (simulationId: string, from?: string, to?: string, entityId?: string) => {
    const params = new URLSearchParams(); if (from) params.set('from', from); if (to) params.set('to', to); if (entityId) params.set('entityId', entityId)
    const query = params.toString(); return request<AnalysisData>(`/simulations/${simulationId}/analysis${query ? `?${query}` : ''}`)
  },
  timeline: (simulationId: string, entityId: string, limit = 200) => request<TimelineItem[]>(`/simulations/${simulationId}/timeline?entityId=${encodeURIComponent(entityId)}&limit=${limit}`),
  events: (simulationId: string, limit = 100) => request<EventItem[]>(`/simulations/${simulationId}/events?limit=${limit}`),
  actions: (simulationId: string, entityId?: string, limit = 100) => request<unknown[]>(`/simulations/${simulationId}/actions?${new URLSearchParams({ ...(entityId ? { entityId } : {}), limit: String(limit) })}`),
  memories: (simulationId: string, entityId: string, limit = 100) => request<Memory[]>(`/simulations/${simulationId}/memories/${entityId}?limit=${limit}`),
  relationships: (simulationId: string, entityId: string) => request<unknown[]>(`/simulations/${simulationId}/relationships/${entityId}`),
  development: (simulationId: string, entityId: string) => request<{ current: Development | null; history: DevelopmentHistoryItem[] }>(`/simulations/${simulationId}/development/${entityId}`),
  conversationMessages: (simulationId: string, conversationId: string) => request<ChatMessage[]>(`/simulations/${simulationId}/conversations/${conversationId}/messages`),
  observer: (simulationId: string) => request<{ id: string; displayName: string; status: string }>(`/simulations/${simulationId}/observer`, { method: 'POST' }),
  sendMessage: (simulationId: string, payload: { senderEntityId: string; asamiEntityId?: string; conversationId?: string; content: string }) => request<ChatResponse>(`/simulations/${simulationId}/conversations/messages`, { method: 'POST', body: JSON.stringify(payload) }),
}

export { ApiError }
