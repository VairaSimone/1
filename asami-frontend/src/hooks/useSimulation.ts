import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { ChatMessage, Dashboard, Development, DevelopmentHistoryItem, EventItem, Memory, Simulation, TimelineItem, WsMessage } from '../types'

const ACTIVE_SIM_KEY = 'asami.activeSimulationId'
const ASAMI_ENTITY_KEY = 'asami.entityId'
const CHAT_SENDER_KEY = 'asami.chatSenderId'

export function useSimulation() {
  const [simulations, setSimulations] = useState<Simulation[]>([])
  const [simulationId, setSimulationIdState] = useState(() => localStorage.getItem(ACTIVE_SIM_KEY) || '')
  const [asamiId, setAsamiIdState] = useState(() => localStorage.getItem(ASAMI_ENTITY_KEY) || '')
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [events, setEvents] = useState<EventItem[]>([])
  const [memories, setMemories] = useState<Memory[]>([])
  const [development, setDevelopment] = useState<{ current: Development | null; history: DevelopmentHistoryItem[] }>({ current: null, history: [] })
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [clockSpeed, setClockSpeed] = useState(1)
  const [conversationId, setConversationId] = useState(() => localStorage.getItem('asami.conversationId') || '')
  const [chatSenderId, setChatSenderIdState] = useState(() => localStorage.getItem(CHAT_SENDER_KEY) || '')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const refreshTimer = useRef<number | null>(null)

  const simulation = useMemo(() => simulations.find((s) => s.id === simulationId) || null, [simulations, simulationId])

  const setSimulationId = useCallback((id: string) => {
    setSimulationIdState(id)
    localStorage.setItem(ACTIVE_SIM_KEY, id)
    setDashboard(null)
    setTimeline([])
    setEvents([])
    setMemories([])
    setDevelopment({ current: null, history: [] })
    setMessages([])
    setConversationId('')
    localStorage.removeItem('asami.conversationId')
  }, [])

  const loadSimulations = useCallback(async () => {
    const list = await api.simulations()
    setSimulations(list)
    if (!simulationId && list[0]) setSimulationId(list[0].id)
    if (simulationId && !list.some((s) => s.id === simulationId) && list[0]) setSimulationId(list[0].id)
    return list
  }, [simulationId, setSimulationId])

  const refresh = useCallback(async (soft = false) => {
    if (!simulationId) return
    if (soft) setRefreshing(true); else setLoading(true)
    setError(null)
    try {
      const simPromise = api.simulation(simulationId)
      const clockPromise = api.clock(simulationId)
      const asamiPromise = api.asami(simulationId)
      const [sim, clockData, entity, nextDashboard] = await Promise.all([
        simPromise,
        clockPromise,
        asamiPromise,
        asamiPromise.then((e) => api.dashboard(simulationId, e.id)),
      ])
      if (clockData.clock) setClockSpeed(Number(clockData.clock.speed))
      setSimulations((prev) => {
        const existing = prev.some((x) => x.id === sim.id)
        return existing ? prev.map((x) => x.id === sim.id ? sim : x) : [sim, ...prev]
      })
      const observer = await api.observer(simulationId)

setChatSenderIdState(observer.id)
localStorage.setItem(CHAT_SENDER_KEY, observer.id)
      setAsamiIdState(entity.id)
      localStorage.setItem(ASAMI_ENTITY_KEY, entity.id)
      setDashboard(nextDashboard)
      const [nextTimeline, nextEvents, nextMemories, nextDevelopment] = await Promise.all([
        api.timeline(simulationId, entity.id, 200),
        api.events(simulationId, 100),
        api.memories(simulationId, entity.id, 100),
        api.development(simulationId, entity.id),
      ])
      setTimeline(nextTimeline)
      setEvents(nextEvents)
      setMemories(nextMemories)
      setDevelopment(nextDevelopment)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Errore durante il caricamento della simulazione.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [simulationId])

  useEffect(() => {
    loadSimulations().catch((e) => {
      setError(e instanceof Error ? e.message : 'Backend non raggiungibile.')
    }).finally(() => setLoading(false))
  }, [loadSimulations])

  useEffect(() => {
    if (simulationId) refresh().catch(() => undefined)
  }, [simulationId, refresh])

  useEffect(() => {
    if (!simulationId) return
    const base = (import.meta.env.VITE_WS_BASE_URL || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/realtime`).replace(/\/$/, '')
    const url = `${base}?simulationId=${encodeURIComponent(simulationId)}`
    let retry = 0
    let disposed = false
    let retryTimer: number | null = null

    const connect = () => {
      if (disposed) return
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onopen = () => { setWsConnected(true); retry = 0 }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsMessage
          if (msg.type === 'simulation.status' || msg.type === 'simulation.speed' || msg.type === 'simulation.tick' || msg.type === 'world.event' || msg.type === 'entity.state' || msg.type === 'action.created' || msg.type === 'action.completed') {
            if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
            refreshTimer.current = window.setTimeout(() => refresh(true).catch(() => undefined), msg.type === 'simulation.tick' ? 350 : 80)
          }
          if (msg.type === 'message.created') {
            const p = msg.payload
            const incoming: ChatMessage = {
              id: String(p.id), senderEntityId: String(p.senderEntityId), messageType: String(p.type), content: String(p.content),
              simulationAt: msg.occurredAt, status: 'DELIVERED', metadata: {},
            }
            setMessages((prev) => prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming])
          }
        } catch { /* malformed realtime messages are ignored */ }
      }
      ws.onclose = () => {
        setWsConnected(false)
        if (disposed) return
        retry += 1
        const delay = Math.min(5000, 500 * 2 ** Math.min(retry, 4))
        retryTimer = window.setTimeout(connect, delay)
      }
      ws.onerror = () => setWsConnected(false)
    }
    connect()
    return () => {
      disposed = true
      if (retryTimer) window.clearTimeout(retryTimer)
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      wsRef.current?.close()
      wsRef.current = null
      setWsConnected(false)
    }
  }, [simulationId, refresh])
useEffect(() => {
  if (!simulationId) return

  const timer = window.setInterval(() => {
    refresh(true).catch(() => undefined)
  }, 1500)

  return () => window.clearInterval(timer)
}, [simulationId, refresh])
  const createSimulation = useCallback(async (payload: Record<string, unknown>) => {
    const created = await api.createSimulation(payload)
    setSimulationIdState(created.simulation.id)
    localStorage.setItem(ACTIVE_SIM_KEY, created.simulation.id)
    setAsamiIdState(created.asamiEntityId)
    localStorage.setItem(ASAMI_ENTITY_KEY, created.asamiEntityId)
    await loadSimulations()
    return created
  }, [loadSimulations])

  const control = useCallback(async (action: 'pause' | 'resume' | 'stop') => {
    if (!simulationId) return
    const result = await api[action](simulationId)
    setSimulations((prev) => prev.map((s) => s.id === result.id ? result : s))
    await refresh(true)
  }, [simulationId, refresh])

  const changeSpeed = useCallback(async (speed: number) => {
    if (!simulationId) return
    const result = await api.speed(simulationId, speed)
    setSimulations((prev) => prev.map((s) => s.id === result.id ? result : s))
    await refresh(true)
  }, [simulationId, refresh])

  const sendMessage = useCallback(async (content: string) => {
    if (!simulationId || !chatSenderId || !asamiId) throw new Error('Serve un interlocutore valido oltre ad Asami per inviare messaggi.')
    const result = await api.sendMessage(simulationId, { senderEntityId: chatSenderId, asamiEntityId: asamiId, conversationId: conversationId || undefined, content })
    setConversationId(result.conversationId)
    localStorage.setItem('asami.conversationId', result.conversationId)
    const history = await api.conversationMessages(simulationId, result.conversationId)
    setMessages(history)
    return result
  }, [simulationId, chatSenderId, asamiId, conversationId])

  useEffect(() => {
    if (!simulationId || !conversationId) return
    api.conversationMessages(simulationId, conversationId).then(setMessages).catch(() => undefined)
  }, [simulationId, conversationId])

  const setChatSenderId = useCallback((id: string) => {
    setChatSenderIdState(id)
    localStorage.setItem(CHAT_SENDER_KEY, id)
  }, [])

  return {
    simulations, simulation, simulationId, asamiId, dashboard, timeline, events, memories, development, messages,
    clockSpeed, chatSenderId, loading, refreshing, error, wsConnected, setSimulationId, setChatSenderId, createSimulation,
    refresh, control, changeSpeed, sendMessage,
  }
}
