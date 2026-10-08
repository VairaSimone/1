import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { ChatMessage, ConversationState, Dashboard, Development, DevelopmentHistoryItem, EventItem, Memory, Simulation, TimelineItem, WorldActivity, WorldAction, WorldMovement, WorldSnapshot, WsMessage, SocietySnapshot } from '../types'

const ACTIVE_SIM_KEY = 'asami.activeSimulationId'
const ASAMI_ENTITY_KEY = 'asami.entityId'
const CHAT_SENDER_KEY = 'asami.chatSenderId'

function realtimeLabel(value: unknown) {
  return String(value || 'azione').toLowerCase().replaceAll('_', ' ')
}

function normalizeRealtimeAction(value: unknown, fallbackAt: string, status = 'ACTIVE'): WorldAction | null {
  if (!value || typeof value !== 'object') return null
  const action = value as Record<string, unknown>
  const startedAt = String(action.startedAt || action.startedSimulationAt || fallbackAt)
  return {
    id: String(action.id || action.actionId || ''),
    actionType: String(action.actionType || 'ACTION'),
    status: String(action.status || status),
    startedAt,
    completedAt: action.completedAt || action.completedSimulationAt ? String(action.completedAt || action.completedSimulationAt) : null,
    targetLocationId: action.targetLocationId ? String(action.targetLocationId) : null,
    targetEntityId: action.targetEntityId ? String(action.targetEntityId) : null,
  }
}

function normalizeRealtimeMovement(value: unknown, world: WorldSnapshot, atIso: string): WorldMovement | null {
  if (!value || typeof value !== 'object') return null
  const movement = value as Record<string, unknown>
  const originLocationId = String(movement.originLocationId || movement.origin || '')
  const destinationLocationId = String(movement.destinationLocationId || movement.destination || '')
  if (!originLocationId || !destinationLocationId) return null
  const startedSimulationAt = String(movement.startedSimulationAt || atIso)
  const expectedArrivalSimulationAt = String(movement.expectedArrivalSimulationAt || movement.expectedArrival || atIso)
  const startMs = new Date(startedSimulationAt).getTime()
  const arrivalMs = new Date(expectedArrivalSimulationAt).getTime()
  const atMs = new Date(atIso).getTime()
  const progress = Number.isFinite(startMs) && Number.isFinite(arrivalMs) && arrivalMs > startMs
    ? Math.max(0, Math.min(1, (atMs - startMs) / (arrivalMs - startMs)))
    : 0
  const origin = world.locations.find((location) => location.locationId === originLocationId)
  const destination = world.locations.find((location) => location.locationId === destinationLocationId)
  return {
    id: String(movement.id || movement.movementId || (originLocationId + ':' + destinationLocationId + ':' + startedSimulationAt)),
    originLocationId,
    destinationLocationId,
    startedSimulationAt,
    expectedArrivalSimulationAt,
    actualArrivalSimulationAt: movement.actualArrivalSimulationAt ? String(movement.actualArrivalSimulationAt) : null,
    arrivalSimulationAt: expectedArrivalSimulationAt,
    status: String(movement.status || 'ACTIVE'),
    reason: movement.reason ? String(movement.reason) : null,
    originName: origin?.name,
    destinationName: destination?.name,
    progress: Number(progress.toFixed(4)),
  }
}

function appendUnique<T extends { id: string }>(items: T[], item: T, limit: number) {
  return [item, ...items.filter((current) => current.id !== item.id)].slice(0, limit)
}

function chatSequence(message: ChatMessage) {
  const metadata = message.metadata && typeof message.metadata === 'object'
    ? message.metadata as Record<string, unknown>
    : {}
  const value = Number(metadata.turnSequence)
  return Number.isFinite(value) ? value : null
}

function chatOrder(message: ChatMessage) {
  const metadata = message.metadata && typeof message.metadata === 'object'
    ? message.metadata as Record<string, unknown>
    : {}
  const value = Number(metadata.messageOrder)
  return Number.isFinite(value) ? value : message.messageType === 'USER' ? 0 : 1
}

function sortChatMessages(items: ChatMessage[]) {
  return [...items].sort((a, b) => {
    const aTime = new Date(a.simulationAt).getTime()
    const bTime = new Date(b.simulationAt).getTime()
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime
    if (Number.isFinite(aTime) && !Number.isFinite(bTime)) return -1
    if (!Number.isFinite(aTime) && Number.isFinite(bTime)) return 1

    const aSequence = chatSequence(a)
    const bSequence = chatSequence(b)
    if (aSequence !== null && bSequence !== null && aSequence !== bSequence) return aSequence - bSequence
    if (aSequence === null && bSequence !== null) return -1
    if (aSequence !== null && bSequence === null) return 1

    const aOrder = chatOrder(a)
    const bOrder = chatOrder(b)
    if (aOrder !== bOrder) return aOrder - bOrder

    return a.id.localeCompare(b.id)
  })
}

export function useSimulation() {
  const [simulations, setSimulations] = useState<Simulation[]>([])
  const [simulationId, setSimulationIdState] = useState(() => localStorage.getItem(ACTIVE_SIM_KEY) || '')
  const [asamiId, setAsamiIdState] = useState(() => localStorage.getItem(ASAMI_ENTITY_KEY) || '')
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [events, setEvents] = useState<EventItem[]>([])
  const [memories, setMemories] = useState<Memory[]>([])
  const [development, setDevelopment] = useState<{ current: Development | null; history: DevelopmentHistoryItem[] }>({ current: null, history: [] })
  const [world, setWorld] = useState<WorldSnapshot | null>(null)
  const [worldActivities, setWorldActivities] = useState<WorldActivity[]>([])
  const [society, setSociety] = useState<SocietySnapshot | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [conversationState, setConversationState] = useState<ConversationState | null>(null)
  const [clockSpeed, setClockSpeed] = useState(1)
  const [conversationId, setConversationId] = useState(() => localStorage.getItem('asami.conversationId') || '')
  const [chatSenderId, setChatSenderIdState] = useState(() => localStorage.getItem(CHAT_SENDER_KEY) || '')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const worldLastFetchAt = useRef(0)
  const worldRequestInFlight = useRef<Promise<WorldSnapshot | null> | null>(null)
  const worldRef = useRef<WorldSnapshot | null>(null)
  const latestDashboardSimulationAt = useRef(0)
  const latestRealtimeSequence = useRef(0)
  const latestRealtimeSimulationVersion = useRef(0)
  const latestRealtimeWorldStateAt = useRef(new Map<string, number>())

  const simulation = useMemo(() => simulations.find((s) => s.id === simulationId) || null, [simulations, simulationId])

  useEffect(() => { worldRef.current = world }, [world])

  const setSimulationId = useCallback((id: string) => {
    latestDashboardSimulationAt.current = 0
    latestRealtimeSequence.current = 0
    latestRealtimeSimulationVersion.current = 0
    latestRealtimeWorldStateAt.current.clear()
    setSimulationIdState(id)
    localStorage.setItem(ACTIVE_SIM_KEY, id)
    setDashboard(null); setTimeline([]); setEvents([]); setMemories([]); setDevelopment({ current: null, history: [] }); setWorld(null); setWorldActivities([]); setSociety(null); setMessages([]); setConversationId(''); setConversationState(null)
    localStorage.removeItem('asami.conversationId')
  }, [])

  const loadSimulations = useCallback(async () => {
    const list = await api.simulations(); setSimulations(list)
    if (!simulationId && list[0]) setSimulationId(list[0].id)
    if (simulationId && !list.some((s) => s.id === simulationId) && list[0]) setSimulationId(list[0].id)
    return list
  }, [simulationId, setSimulationId])

  const refreshWorldOnly = useCallback(async () => {
    if (!simulationId || worldRequestInFlight.current) return null
    worldRequestInFlight.current = api.world(simulationId)
      .then((nextWorld) => {
        worldLastFetchAt.current = Date.now()
        setWorld(nextWorld)
        return nextWorld
      })
      .catch(() => null)
      .finally(() => { worldRequestInFlight.current = null })
    return worldRequestInFlight.current
  }, [simulationId])

  const refresh = useCallback(async (soft = false) => {
    if (!simulationId) return
    if (soft) setRefreshing(true); else setLoading(true)
    setError(null)
    try {
      const simPromise = api.simulation(simulationId); const clockPromise = api.clock(simulationId); const asamiPromise = api.asami(simulationId)
      const worldDue = Date.now() - worldLastFetchAt.current >= 750 && !worldRequestInFlight.current
      const worldPromise = worldDue
        ? refreshWorldOnly()
        : Promise.resolve(null)
      const [sim, clockData, entity, nextDashboard, nextWorld, nextSociety] = await Promise.all([simPromise, clockPromise, asamiPromise, asamiPromise.then((e) => api.dashboard(simulationId, e.id)), worldPromise, api.society(simulationId)])
      if (clockData.clock) setClockSpeed(Number(clockData.clock.speed))
      setSimulations((prev) => prev.some((x) => x.id === sim.id) ? prev.map((x) => x.id === sim.id ? sim : x) : [sim, ...prev])
      const observer = await api.observer(simulationId)
      setChatSenderIdState(observer.id); localStorage.setItem(CHAT_SENDER_KEY, observer.id)
      setAsamiIdState(entity.id); localStorage.setItem(ASAMI_ENTITY_KEY, entity.id)
      const dashboardAt = nextDashboard?.simulationAt ? new Date(String(nextDashboard.simulationAt)).getTime() : Number.NaN
      if (!Number.isFinite(latestDashboardSimulationAt.current) || latestDashboardSimulationAt.current <= 0 || !Number.isFinite(dashboardAt) || dashboardAt >= latestDashboardSimulationAt.current) {
        if (Number.isFinite(dashboardAt)) latestDashboardSimulationAt.current = dashboardAt
        setDashboard(nextDashboard)
      }
      if (nextWorld) setWorld(nextWorld); setSociety(nextSociety)
      const [nextTimeline, nextEvents, nextMemories, nextDevelopment] = await Promise.all([
        api.timeline(simulationId, entity.id, 200), api.events(simulationId, 100), api.memories(simulationId, entity.id, 100), api.development(simulationId, entity.id),
      ])
      setTimeline(nextTimeline); setEvents(nextEvents); setMemories(nextMemories); setDevelopment(nextDevelopment)
      return { simulation: sim, world: nextWorld || worldRef.current }
    } catch (e) { setError(e instanceof Error ? e.message : 'Errore durante il caricamento della simulazione.') }
    finally { setLoading(false); setRefreshing(false) }
  }, [simulationId, refreshWorldOnly])

  useEffect(() => { loadSimulations().catch((e) => setError(e instanceof Error ? e.message : 'Backend non raggiungibile.')).finally(() => setLoading(false)) }, [loadSimulations])
  useEffect(() => { if (simulationId) refresh().catch(() => undefined) }, [simulationId, refresh])

  useEffect(() => {
    if (!simulationId) return
    let cancelled = false
    const load = () => api.society(simulationId).then((next) => { if (!cancelled) setSociety(next) }).catch(() => undefined)
    load()
    const timer = window.setInterval(load, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [simulationId])

  useEffect(() => {
    if (!simulationId || !asamiId || !wsConnected) return
    let cancelled = false

    const loadDashboard = async () => {
      try {
        const nextDashboard = await api.dashboard(simulationId, asamiId)
        if (cancelled) return
        const nextMs = nextDashboard?.simulationAt ? new Date(String(nextDashboard.simulationAt)).getTime() : Number.NaN
        if (!Number.isFinite(nextMs) || latestDashboardSimulationAt.current <= 0 || nextMs >= latestDashboardSimulationAt.current) {
          if (Number.isFinite(nextMs)) latestDashboardSimulationAt.current = nextMs
          setDashboard(nextDashboard)
        }
      } catch {
        // The websocket remains the live source for fast state updates.
      }
    }

    void loadDashboard()
    const timer = window.setInterval(() => { void loadDashboard() }, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [simulationId, asamiId, wsConnected])

  useEffect(() => {
    if (!simulationId) return
    const base = (import.meta.env.VITE_WS_BASE_URL || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/realtime`).replace(/\/$/, '')
    const url = `${base}?simulationId=${encodeURIComponent(simulationId)}`
    let retry = 0
    let disposed = false
    let retryTimer: number | null = null

    const pushActivity = (activity: WorldActivity) => {
      setWorldActivities((prev) => appendUnique(prev, activity, 8))
    }

    const actorName = (entityId: unknown) => {
      const id = entityId ? String(entityId) : ''
      return worldRef.current?.actors.find((actor) => actor.id === id)?.displayName || 'abitante'
    }

    const locationName = (locationId: unknown) => {
      const id = locationId ? String(locationId) : ''
      return worldRef.current?.locations.find((location) => location.locationId === id)?.name || 'destinazione'
    }

    const updateDashboardFromState = (payload: Record<string, unknown>, fallbackAt: string) => {
      const entityId = String(payload.entityId || '')
      if (!entityId || entityId !== asamiId) return
      const eventAt = String(payload.simulationAt || fallbackAt)
      const eventMs = new Date(eventAt).getTime()
      const lastEntityStateAt = latestRealtimeWorldStateAt.current.get(entityId) || 0
      if (Number.isFinite(eventMs) && lastEntityStateAt > 0 && eventMs < lastEntityStateAt) return
      if (Number.isFinite(eventMs)) latestRealtimeWorldStateAt.current.set(entityId, Math.max(lastEntityStateAt, eventMs))
      const needChanges = Array.isArray(payload.needChanges) ? payload.needChanges : []
      const emotionChanges = Array.isArray(payload.emotionChanges) ? payload.emotionChanges : []
      const worldState = payload.worldState && typeof payload.worldState === 'object' ? payload.worldState as Record<string, unknown> : null
      setDashboard((prev) => {
        if (!prev) return prev
        if (Number.isFinite(eventMs) && latestDashboardSimulationAt.current > 0 && eventMs < latestDashboardSimulationAt.current) return prev
        if (Number.isFinite(eventMs)) latestDashboardSimulationAt.current = Math.max(latestDashboardSimulationAt.current, eventMs)
        const nextNeeds = needChanges.length
          ? prev.needs.map((need) => {
              const change = needChanges.find((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).code || '') === need.code) as Record<string, unknown> | undefined
              return change && Number.isFinite(Number(change.new)) ? { ...need, value: Number(change.new) } : need
            })
          : prev.needs
        const nextEmotions = emotionChanges.length
          ? prev.emotions.map((emotion) => {
              const change = emotionChanges.find((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).code || '') === emotion.code) as Record<string, unknown> | undefined
              return change && Number.isFinite(Number(change.new)) ? { ...emotion, intensity: Number(change.new) } : emotion
            })
          : prev.emotions
        const hasActionKey = Boolean(worldState && Object.prototype.hasOwnProperty.call(worldState, 'action'))
        const realtimeAction: WorldAction | null = hasActionKey
          ? normalizeRealtimeAction(worldState?.action, fallbackAt)
          : null
        const currentAction = realtimeAction ? {
          id: realtimeAction.id,
          actionType: realtimeAction.actionType,
          status: realtimeAction.status,
          startedAt: realtimeAction.startedAt,
          completedAt: realtimeAction.completedAt,
          target: realtimeAction.targetLocationId
            ? { locationId: realtimeAction.targetLocationId }
            : realtimeAction.targetEntityId
              ? { entityId: realtimeAction.targetEntityId }
              : null,
          parameters: null,
          result: null
        } : hasActionKey ? null : prev.currentAction
        return { ...prev, needs: nextNeeds, emotions: nextEmotions, currentAction }
      })
    }

    const applyWorldActor = (payload: Record<string, unknown>, occurredAt: string) => {
      const entityId = String(payload.entityId || '')
      const state = payload.worldState && typeof payload.worldState === 'object' ? payload.worldState as Record<string, unknown> : payload
      const atIso = String(payload.simulationAt || state.simulationAt || occurredAt)
      const atMs = new Date(atIso).getTime()
      const lastStateAt = latestRealtimeWorldStateAt.current.get(entityId) || 0
      if (Number.isFinite(atMs) && lastStateAt > 0 && atMs < lastStateAt) return

      setWorld((prev) => {
        if (!prev) return prev
        const index = prev.actors.findIndex((actor) => actor.id === entityId)
        if (index < 0) return prev
        const actor = prev.actors[index]
        const stateAtSnapshot = new Date(prev.simulationAt).getTime()
        if (Number.isFinite(atMs) && Number.isFinite(stateAtSnapshot) && atMs < stateAtSnapshot) return prev
        const hasLocationKey = Object.prototype.hasOwnProperty.call(state, 'locationId')
        const hasMovingKey = Object.prototype.hasOwnProperty.call(state, 'moving')
        const hasMovementKey = Object.prototype.hasOwnProperty.call(state, 'movement')
        const hasActionKey = Object.prototype.hasOwnProperty.call(state, 'action')
        const locationId = hasLocationKey ? (state.locationId ? String(state.locationId) : null) : actor.locationId
        const moving = hasMovingKey ? Boolean(state.moving) : actor.moving
        const movement = hasMovementKey ? normalizeRealtimeMovement(state.movement, prev, atIso) : actor.movement
        const action = hasActionKey ? normalizeRealtimeAction(state.action, atIso) : actor.action
        let latitude = actor.latitude
        let longitude = actor.longitude
        if (moving && movement) {
          const origin = prev.locations.find((location) => location.locationId === movement.originLocationId)
          const destination = prev.locations.find((location) => location.locationId === movement.destinationLocationId)
          const progress = movement.progress
          if (origin && destination) {
            latitude = Number(origin.latitude) + (Number(destination.latitude) - Number(origin.latitude)) * progress
            longitude = Number(origin.longitude) + (Number(destination.longitude) - Number(origin.longitude)) * progress
          }
        } else if (locationId) {
          const location = prev.locations.find((item) => item.locationId === locationId)
          if (location) {
            latitude = location.latitude
            longitude = location.longitude
          }
        }
        if (Number.isFinite(atMs)) latestRealtimeWorldStateAt.current.set(entityId, Math.max(lastStateAt, atMs))
        const nextActor = { ...actor, locationId, moving, movement, action, latitude, longitude }
        const actors = prev.actors.slice()
        actors[index] = nextActor
        return {
          ...prev,
          simulationAt: Number.isFinite(atMs) && (!Number.isFinite(stateAtSnapshot) || atMs >= stateAtSnapshot) ? atIso : prev.simulationAt,
          isLive: true,
          actors
        }
      })
    }

    const updateWorldClock = (payload: Record<string, unknown>, occurredAt: string) => {
      const simulationAt = String(payload.simulationTime || payload.simulationAt || occurredAt)
      const simulationMs = new Date(simulationAt).getTime()
      if (!Number.isFinite(simulationMs)) return
      setWorld((prev) => {
        if (!prev) return prev
        const currentMs = new Date(prev.simulationAt).getTime()
        if (Number.isFinite(currentMs) && simulationMs < currentMs) return prev
        const recentEvents = prev.recentEvents.map((event) => {
          if (!event.environmental || !event.locationId || !['RAIN', 'STORM'].includes(String(event.eventCode || '').toUpperCase())) return event
          const expiresAt = event.metadata?.weatherExpiresAt ? new Date(String(event.metadata.weatherExpiresAt)).getTime() : Number.NaN
          if (!Number.isFinite(expiresAt) || simulationMs < expiresAt) return event
          return event
        })
        const latestWeatherByLocation = new Map<string, { event: typeof prev.recentEvents[number]; expiresAt: number }>()
        for (const event of recentEvents) {
          if (!event.locationId || !event.environmental) continue
          const weatherCode = String(event.eventCode || '').toUpperCase()
          if (!['RAIN', 'STORM'].includes(weatherCode)) continue
          const eventMs = new Date(event.simulationAt).getTime()
          const expiresAt = event.metadata?.weatherExpiresAt ? new Date(String(event.metadata.weatherExpiresAt)).getTime() : Number.NaN
          if (!Number.isFinite(eventMs)) continue
          const existing = latestWeatherByLocation.get(event.locationId)
          if (!existing || eventMs > new Date(existing.event.simulationAt).getTime()) {
            latestWeatherByLocation.set(event.locationId, { event, expiresAt })
          }
        }
        const locations = prev.locations.map((location) => {
          const latest = latestWeatherByLocation.get(location.locationId)
          if (!latest) return location
          const latestCode = String(latest.event.eventCode || '').toUpperCase()
          const active = !Number.isFinite(latest.expiresAt) || simulationMs < latest.expiresAt
          if (!active) return { ...location, environment: { ...location.environment, weather: 'CLEAR' } }
          const preset = latestCode === 'STORM'
            ? { weather: 'STORM', temperature: 12, humidity: .95, visibility: .4 }
            : { weather: 'RAIN', temperature: 14, humidity: .9, visibility: .65 }
          return { ...location, environment: { ...location.environment, ...preset, updatedAt: simulationAt, replaySource: 'realtime-event-stream' } }
        })
        return {
          ...prev,
          simulationAt,
          phase: (payload.phase === 'night' || payload.phase === 'morning' || payload.phase === 'day' || payload.phase === 'evening') ? payload.phase : prev.phase,
          localHour: Number.isFinite(Number(payload.localHour)) ? Number(payload.localHour) : prev.localHour,
          timeZone: payload.timeZone ? String(payload.timeZone) : prev.timeZone,
          isLive: true,
          locations,
          recentEvents,
          simulation: { ...prev.simulation, currentSimulationAt: simulationAt }
        }
      })
      setSimulations((prev) => prev.map((item) => item.id === simulationId ? { ...item, currentSimulationAt: simulationAt } : item))
    }

    const connect = () => {
      if (disposed) return
      const ws = new WebSocket(url)
      wsRef.current = ws
      let realtimeReady = false
      ws.onopen = () => {
        realtimeReady = false
        setWsConnected(true)
        retry = 0
        void refresh(true).then((synced) => {
          if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return
          const syncedWorld = synced?.world || worldRef.current
          latestRealtimeSequence.current = Number(syncedWorld?.realtime?.eventSequence || 0)
          latestRealtimeSimulationVersion.current = Number(syncedWorld?.realtime?.simulationVersion || synced?.simulation?.version || 0)
          latestRealtimeWorldStateAt.current.clear()
          if (syncedWorld?.simulationAt) {
            const syncedAt = new Date(syncedWorld.simulationAt).getTime()
            if (Number.isFinite(syncedAt)) {
              for (const actor of syncedWorld.actors) latestRealtimeWorldStateAt.current.set(actor.id, syncedAt)
            }
          }
          realtimeReady = true
        }).catch(() => {
          if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) realtimeReady = true
        })
      }
      ws.onmessage = (event) => {
        try {
          if (!realtimeReady) return
          const msg = JSON.parse(event.data) as WsMessage
          const p = msg.payload || {}
          const sequence = Number(msg.eventSequence ?? msg.sequence)
          const simulationVersion = Number(msg.simulationVersion ?? p.simulationVersion)
          if (Number.isFinite(simulationVersion)) {
            if (latestRealtimeSimulationVersion.current > 0 && simulationVersion < latestRealtimeSimulationVersion.current) return
            latestRealtimeSimulationVersion.current = Math.max(latestRealtimeSimulationVersion.current, simulationVersion)
          }
          if (Number.isFinite(sequence)) {
            if (sequence <= latestRealtimeSequence.current) return
            latestRealtimeSequence.current = sequence
          }

          if (msg.type === 'simulation.tick') {
            updateWorldClock(p, msg.occurredAt)
            if (Date.now() - worldLastFetchAt.current > 30000) void refreshWorldOnly()
          }

          if (msg.type === 'simulation.status') {
            const status = String(p.status || '')
            if (status) {
              setSimulations((prev) => prev.map((item) => item.id === simulationId ? { ...item, status } : item))
              setWorld((prev) => prev ? { ...prev, simulation: { ...prev.simulation, status } } : prev)
            }
          }

          if (msg.type === 'simulation.speed') {
            const speed = Number(p.speed)
            if (Number.isFinite(speed)) setClockSpeed(speed)
          }

          if (msg.type === 'world.actor') {
            applyWorldActor(p, msg.occurredAt)
          }

          if (msg.type === 'entity.state') {
            applyWorldActor(p, msg.occurredAt)
            updateDashboardFromState(p, String(p.simulationAt || msg.occurredAt))
          }

          if (msg.type === 'action.created') {
            const action = p.action && typeof p.action === 'object' ? p.action as Record<string, unknown> : null
            const entityId = String(p.entityId || '')
            if (action) {
              const actionAt = String(action.startedAt || action.startedSimulationAt || msg.occurredAt)
              const actionId = String(action.id || action.actionId || '')
              const actionType = String(action.actionType || 'ACTION')
              const movement = action.movement && typeof action.movement === 'object' ? action.movement as Record<string, unknown> : null
              const targetEntityId = action.targetEntityId ? String(action.targetEntityId) : null
              const targetLocationId = action.targetLocationId ? String(action.targetLocationId) : null
              const targetName = targetEntityId ? actorName(targetEntityId) : targetLocationId ? locationName(targetLocationId) : null
              pushActivity({
                id: 'action:' + actionId + ':' + actionAt,
                kind: movement ? 'movement' : actionType === 'TALKING' ? 'social' : 'action',
                simulationAt: actionAt,
                title: actorName(entityId) + ' ha iniziato ' + realtimeLabel(actionType),
                detail: targetName ? ('Obiettivo · ' + targetName) : 'Una nuova decisione è diventata comportamento.',
                entityId,
                targetEntityId,
                steps: [
                  movement && targetLocationId ? ('Si sta dirigendo verso ' + locationName(targetLocationId)) : null,
                  actionType === 'TALKING' && targetEntityId ? ('Sta per interagire con ' + actorName(targetEntityId)) : null,
                  !movement && actionType !== 'TALKING' ? ('Azione ' + realtimeLabel(actionType) + ' in corso') : null
                ].filter((step): step is string => Boolean(step))
              })
            }
          }

          if (msg.type === 'action.completed') {
            const action = p.action && typeof p.action === 'object' ? p.action as Record<string, unknown> : null
            const entityId = String(p.entityId || '')
            const actionType = String(action?.actionType || p.actionType || 'ACTION')
            const targetEntityId = action?.targetEntityId || p.targetEntityId ? String(action?.targetEntityId || p.targetEntityId) : null
            const atIso = String(p.simulationAt || msg.occurredAt)
            const actionId = String(action?.id || p.actionId || '')
            const outcome = String(p.outcome || 'SUCCESS')
            setTimeline((prev) => appendUnique(prev, {
              at: atIso,
              kind: 'ACTION',
              id: actionId,
              type: actionType,
              summary: realtimeLabel(actionType) + ' [' + outcome + ']',
              metadata: p
            }, 200))
            pushActivity({
              id: 'complete:' + actionId + ':' + atIso,
              kind: actionType === 'TALKING' ? 'social' : 'action',
              simulationAt: atIso,
              title: actorName(entityId) + ' ha completato ' + realtimeLabel(actionType),
              detail: targetEntityId ? ('Interazione con ' + actorName(targetEntityId)) : ('Esito · ' + outcome),
              entityId,
              targetEntityId,
              steps: ['Esito: ' + outcome].concat(targetEntityId ? ['Conseguenza osservabile su ' + actorName(targetEntityId)] : [])
            })
          }

          if (msg.type === 'world.event') {
            const eventPayload = p.event && typeof p.event === 'object' ? p.event as Record<string, unknown> : null
            if (eventPayload?.id) {
              const eventAt = String(eventPayload.simulationAt || msg.occurredAt)
              const event = {
                id: String(eventPayload.id),
                type: String(eventPayload.type || 'WORLD'),
                category: String(eventPayload.category || 'WORLD'),
                title: String(eventPayload.title || 'Evento del mondo'),
                description: eventPayload.description ? String(eventPayload.description) : null,
                simulationAt: eventAt,
                importance: Number(eventPayload.importance || 0),
                status: String(eventPayload.status || 'RECORDED'),
                sourceActionId: eventPayload.sourceActionId ? String(eventPayload.sourceActionId) : null,
                metadata: eventPayload.metadata || {}
              }
              setEvents((prev) => appendUnique(prev, event, 100))
              setWorld((prev) => {
                if (!prev) return prev
                const locationId = eventPayload.locationId ? String(eventPayload.locationId) : null
                const eventCode = String(eventPayload.eventCode || '').toUpperCase()
                const worldEvent = {
                  id: String(eventPayload.id),
                  type: String(eventPayload.type || 'WORLD'),
                  category: String(eventPayload.category || 'WORLD'),
                  title: String(eventPayload.title || 'Evento del mondo'),
                  description: eventPayload.description ? String(eventPayload.description) : null,
                  simulationAt: eventAt,
                  importance: Number(eventPayload.importance || 0),
                  status: String(eventPayload.status || 'RECORDED'),
                  locationId,
                  eventCode: eventCode || null,
                  environmental: Boolean(eventPayload.environmental),
                  metadata: (eventPayload.metadata && typeof eventPayload.metadata === 'object' ? eventPayload.metadata : {}) as Record<string, unknown>
                }
                const locations = eventCode === 'RAIN' || eventCode === 'STORM'
                  ? prev.locations.map((location) => location.locationId === locationId
                    ? {
                        ...location,
                        environment: {
                          ...location.environment,
                          weather: eventCode,
                          temperature: eventCode === 'STORM' ? 12 : 14,
                          humidity: eventCode === 'STORM' ? .95 : .9,
                          visibility: eventCode === 'STORM' ? .4 : .65,
                          updatedAt: eventAt,
                          replaySource: 'realtime-event-stream'
                        }
                      }
                    : location)
                  : prev.locations
                return {
                  ...prev,
                  simulationAt: eventAt,
                  isLive: true,
                  locations,
                  recentEvents: appendUnique(prev.recentEvents, worldEvent, 50)
                }
              })
              const locationId = eventPayload.locationId ? String(eventPayload.locationId) : null
              pushActivity({
                id: 'event:' + String(eventPayload.id),
                kind: 'world',
                simulationAt: eventAt,
                title: String(eventPayload.title || 'Evento del mondo'),
                detail: eventPayload.description ? String(eventPayload.description) : 'Il mondo fisico è cambiato.',
                steps: [String(eventPayload.type || 'WORLD') + ' registrato', locationId ? ('Luogo · ' + locationName(locationId)) : 'Evento di quartiere']
              })
            }
          }

          if (msg.type === 'entity.consequence') {
            const entityId = String(p.entityId || '')
            const actionId = String(p.actionId || '')
            const actionType = String(p.actionType || 'ACTION')
            const atIso = String(p.simulationAt || msg.occurredAt)
            const targetEntityId = p.targetEntityId ? String(p.targetEntityId) : null
            const targetName = targetEntityId ? actorName(targetEntityId) : null
            const outcome = String(p.outcome || 'SUCCESS')
            const emotionChanges = Array.isArray(p.emotionChanges) ? p.emotionChanges : []
            const social = p.social && typeof p.social === 'object' ? p.social as Record<string, unknown> : null
            const memory = p.memory && typeof p.memory === 'object' ? p.memory as Record<string, unknown> : null
            const developmentData = p.development && typeof p.development === 'object' ? p.development as Development : null

            setTimeline((prev) => appendUnique(prev, {
              at: atIso,
              kind: 'ACTION',
              id: actionId,
              type: actionType,
              summary: realtimeLabel(actionType) + ' [' + outcome + ']',
              metadata: p
            }, 200))

            if (memory?.id && memory.content) {
              const memoryItem: Memory = {
                id: String(memory.id),
                memoryType: 'EPISODIC',
                content: String(memory.content),
                importance: Number(memory.importance || 0),
                strength: 1,
                confidence: .9,
                emotionalIntensity: Number(memory.emotionalIntensity || 0),
                simulationAt: atIso,
                metadata: { actionId, outcome }
              }
              setMemories((prev) => appendUnique(prev, memoryItem, 100))
            }

            if (developmentData) {
              setDevelopment((prev) => ({ current: developmentData, history: prev.history }))
              if (entityId === asamiId) {
                setDashboard((prev) => prev ? { ...prev } : prev)
              }
            }

            pushActivity({
              id: 'consequence:' + actionId + ':' + atIso,
              kind: actionType === 'TALKING' ? 'social' : 'consequence',
              simulationAt: atIso,
              title: actorName(entityId) + ' ha prodotto una conseguenza',
              detail: targetName ? (realtimeLabel(actionType) + ' con ' + targetName) : (realtimeLabel(actionType) + ' · ' + outcome),
              entityId,
              targetEntityId,
              steps: [
                'Esito: ' + outcome,
                emotionChanges.length
                  ? ('Emozioni · ' + emotionChanges.slice(0, 2).map((change) => {
                      const item = change && typeof change === 'object' ? change as Record<string, unknown> : {}
                      const delta = Number(item.delta || 0)
                      return String(item.code || 'EMOTION') + ' ' + (delta >= 0 ? '+' : '') + delta.toFixed(3)
                    }).join(' · '))
                  : null,
                social ? ('Relazione' + (targetName ? ' con ' + targetName : '') + ' aggiornata') : null,
                memory?.id ? 'Nuova memoria episodica registrata' : null,
                developmentData ? 'Sviluppo aggiornato' : null
              ].filter((step): step is string => Boolean(step))
            })

            updateDashboardFromState(p, atIso)
          }

          if (msg.type === 'message.created') {
            const metadata = (p.metadata && typeof p.metadata === 'object' ? p.metadata : {}) as Record<string, unknown>
            const incoming: ChatMessage = { id: String(p.id), senderEntityId: String(p.senderEntityId), messageType: String(p.type), content: String(p.content), simulationAt: String(p.simulationAt || msg.occurredAt), status: 'DELIVERED', metadata }
            if (p.conversationId && (metadata.proactive || String(p.senderEntityId) === asamiId)) {
              const cid = String(p.conversationId)
              setConversationId(cid)
              localStorage.setItem('asami.conversationId', cid)
              void api.conversationState(simulationId, cid).then(setConversationState).catch(() => undefined)
            }
            setMessages((prev) => {
              if (prev.some((m) => m.id === incoming.id)) return prev
              return sortChatMessages([...prev, incoming])
            })
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
      wsRef.current?.close()
      wsRef.current = null
      setWsConnected(false)
    }
  }, [simulationId, refresh, refreshWorldOnly, asamiId])

  // WebSocket is the primary realtime channel. Poll only as a low-frequency
  // fallback while it is disconnected, avoiding continuous dashboard queries.
  useEffect(() => {
    if (!simulationId || wsConnected) return
    const timer = window.setInterval(() => refresh(true).catch(() => undefined), 5000)
    return () => window.clearInterval(timer)
  }, [simulationId, refresh, wsConnected])

  const createSimulation = useCallback(async (payload: Record<string, unknown>) => {
    const created = await api.createSimulation(payload)
    setSimulationId(created.simulation.id)
    setAsamiIdState(created.asamiEntityId)
    localStorage.setItem(ASAMI_ENTITY_KEY, created.asamiEntityId)
    await loadSimulations()
    return created
  }, [loadSimulations, setSimulationId])

  const control = useCallback(async (action: 'pause' | 'resume' | 'stop') => { if (!simulationId) return; const result = await api[action](simulationId); setSimulations((prev) => prev.map((s) => s.id === result.id ? result : s)); await refresh(true) }, [simulationId, refresh])
  const changeSpeed = useCallback(async (speed: number) => { if (!simulationId) return; const result = await api.speed(simulationId, speed); setSimulations((prev) => prev.map((s) => s.id === result.id ? result : s)); await refresh(true) }, [simulationId, refresh])
  const sendMessage = useCallback(async (content: string) => {
    if (!simulationId || !chatSenderId || !asamiId) throw new Error('Serve un interlocutore valido oltre ad Asami per inviare messaggi.')

    const optimisticId = 'optimistic-user-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    const knownSequences = messages
      .map((message) => chatSequence(message))
      .filter((value): value is number => value !== null)
    const predictedTurnSequence = knownSequences.length ? Math.max(...knownSequences) + 1 : 1
    const optimisticAt = simulation?.currentSimulationAt || new Date().toISOString()
    const optimisticUser: ChatMessage = {
      id: optimisticId,
      senderEntityId: chatSenderId,
      messageType: 'USER',
      content,
      simulationAt: optimisticAt,
      status: 'DELIVERED',
      metadata: {
        source: 'frontend-optimistic',
        turnSequence: predictedTurnSequence,
        messageOrder: 0,
        optimistic: true,
      },
    }

    setMessages((prev) => sortChatMessages([...prev, optimisticUser]))

    let result
    try {
      result = await api.sendMessage(simulationId, {
        senderEntityId: chatSenderId,
        asamiEntityId: asamiId,
        conversationId: conversationId || undefined,
        content,
      })
    } catch (error) {
      setMessages((prev) => prev.filter((message) => message.id !== optimisticId))
      throw error
    }

    const persistedUser: ChatMessage = {
      id: result.userMessageId,
      senderEntityId: chatSenderId,
      messageType: 'USER',
      content,
      simulationAt: optimisticAt,
      status: 'DELIVERED',
      metadata: {
        source: 'frontend',
        turnSequence: Number(result.turnSequence || predictedTurnSequence),
        messageOrder: 0,
      },
    }
    const persistedAssistant: ChatMessage = {
      id: result.assistantMessageId,
      senderEntityId: asamiId,
      messageType: 'ASSISTANT',
      content: result.reply,
      simulationAt: optimisticAt,
      status: 'DELIVERED',
      metadata: {
        source: 'api-response',
        fallback: !result.aiUsed,
        turnSequence: Number(result.turnSequence || predictedTurnSequence),
        messageOrder: 1,
      },
    }

    setConversationId(result.conversationId)
    localStorage.setItem('asami.conversationId', result.conversationId)
    setMessages((prev) => {
      const withoutThisTurn = prev.filter((message) =>
        message.id !== optimisticId &&
        message.id !== result.userMessageId &&
        message.id !== result.assistantMessageId
      )
      const existingAssistant = prev.find((message) => message.id === result.assistantMessageId)
      const assistant = existingAssistant
        ? { ...existingAssistant, ...persistedAssistant, metadata: persistedAssistant.metadata }
        : persistedAssistant
      return sortChatMessages([...withoutThisTurn, persistedUser, assistant])
    })

    // Reconcile persisted state in the background. A failure here must not
    // hide a response that was already successfully returned by the chat API.
    void Promise.all([
      api.conversationMessages(simulationId, result.conversationId),
      api.conversationState(simulationId, result.conversationId),
    ]).then(([nextMessages, nextState]) => {
      setMessages(sortChatMessages(nextMessages))
      setConversationState(nextState)
    }).catch(() => undefined)

    void refresh(true).catch(() => undefined)
    return result
  }, [simulationId, chatSenderId, asamiId, conversationId, messages, simulation, refresh])

  useEffect(() => {
    if (!simulationId || !conversationId) {
      setConversationState(null)
      return
    }
    let cancelled = false
    Promise.all([
      api.conversationMessages(simulationId, conversationId),
      api.conversationState(simulationId, conversationId),
    ]).then(([nextMessages, nextState]) => {
      if (cancelled) return
      setMessages(sortChatMessages(nextMessages))
      setConversationState(nextState)
    }).catch(() => {
      if (!cancelled) setConversationState(null)
    })
    return () => { cancelled = true }
  }, [simulationId, conversationId])
  const setChatSenderId = useCallback((id: string) => { setChatSenderIdState(id); localStorage.setItem(CHAT_SENDER_KEY, id) }, [])

  return { simulations, simulation, simulationId, asamiId, dashboard, timeline, events, memories, development, world, worldActivities, society, messages, conversationState, clockSpeed, chatSenderId, loading, refreshing, error, wsConnected, setSimulationId, setChatSenderId, createSimulation, refresh, control, changeSpeed, sendMessage }
}
