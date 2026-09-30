import { useEffect, useMemo, useState } from 'react'
import {
  Coffee, Dumbbell, Footprints, Globe2, HeartPulse, Home, Landmark,
  Library, LocateFixed, MapPin, Moon, Pause, Play, Radio, RotateCcw, School,
  ShoppingCart, Sparkles, Sun, TreePine, UserRound, Users, Wrench, CloudRain,
} from 'lucide-react'
import type { Dashboard, Simulation, WorldActor, WorldLocation, WorldSnapshot } from '../types'
import { api } from '../lib/api'
import { formatSimTime, labelize, pct } from '../lib/format'
import { EmptyState, ErrorState, ProgressBar } from '../components/Ui'
import './LiveWorld.css'

type Mode = 'live' | 'replay'

const REPLAY_RATES = [
  { value: 1, label: '1 h/s' },
  { value: 6, label: '6 h/s' },
  { value: 24, label: '24 h/s' },
  { value: 72, label: '72 h/s' },
]

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

function locationIcon(type: string) {
  const code = String(type || '').toUpperCase()
  if (code === 'HOME') return <Home size={17} />
  if (code === 'PARK' || code === 'NATURE') return <TreePine size={17} />
  if (code === 'CAFE') return <Coffee size={17} />
  if (code === 'SHOP' || code === 'GROCERY') return <ShoppingCart size={17} />
  if (code === 'LIBRARY') return <Library size={17} />
  if (code === 'SQUARE') return <Landmark size={17} />
  if (code === 'SCHOOL') return <School size={17} />
  if (code === 'COMMUNITY') return <Users size={17} />
  if (code === 'GYM') return <Dumbbell size={17} />
  if (code === 'CLINIC') return <HeartPulse size={17} />
  if (code === 'WORKSHOP') return <Wrench size={17} />
  return <MapPin size={17} />
}

function weatherIcon(weather?: string) {
  const code = String(weather || 'CLEAR').toUpperCase()
  if (code === 'RAIN' || code === 'STORM') return <CloudRain size={15} />
  if (code === 'CLEAR' || code === 'HEAT') return <Sun size={15} />
  return <Moon size={15} />
}

function eventSeverity(importance: number) {
  if (Number(importance) >= .75) return 'critical'
  if (Number(importance) >= .5) return 'warning'
  return 'info'
}

function needPressure(code: string, value: number) {
  const safeValue = Math.max(0, Math.min(1, Number(value) || 0))
  return ['ENERGY', 'SAFETY'].includes(code.toUpperCase()) ? 1 - safeValue : safeValue
}

function actionLabel(actor: WorldActor) {
  if (actor.movement) return actor.action ? labelize(actor.action.actionType) : 'In movimento'
  return actor.action ? labelize(actor.action.actionType) : 'In osservazione'
}

function formatReplayDuration(start: number, end: number) {
  const hours = Math.max(0, (end - start) / 3600000)
  if (hours < 1) return Math.round(hours * 60) + ' min'
  if (hours < 24) return hours.toFixed(1) + ' h'
  return (hours / 24).toFixed(1) + ' giorni'
}

function projectWorld(locations: WorldLocation[]) {
  const valid = locations.filter((location) => Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude)))
  if (!valid.length) return { points: new Map<string, { x: number; y: number }>(), minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }

  const lats = valid.map((location) => Number(location.latitude))
  const lons = valid.map((location) => Number(location.longitude))
  const latRange = Math.max(...lats) - Math.min(...lats)
  const lonRange = Math.max(...lons) - Math.min(...lons)
  const latPad = Math.max(latRange * .13, .00035)
  const lonPad = Math.max(lonRange * .13, .00035)
  const minLat = Math.min(...lats) - latPad
  const maxLat = Math.max(...lats) + latPad
  const minLon = Math.min(...lons) - lonPad
  const maxLon = Math.max(...lons) + lonPad

  const points = new Map<string, { x: number; y: number }>()
  for (const location of valid) {
    const x = ((Number(location.longitude) - minLon) / Math.max(.000001, maxLon - minLon)) * 1000
    const y = (1 - (Number(location.latitude) - minLat) / Math.max(.000001, maxLat - minLat)) * 680
    points.set(location.locationId, { x, y })
  }
  return { points, minLat, maxLat, minLon, maxLon }
}

export function LiveWorld({
  simulation,
  world,
  dashboard,
  asamiId,
}: {
  simulation: Simulation
  world: WorldSnapshot | null
  dashboard: Dashboard | null
  asamiId: string
}) {
  const [mode, setMode] = useState<Mode>('live')
  const [displayWorld, setDisplayWorld] = useState<WorldSnapshot | null>(world)
  const [replayAt, setReplayAt] = useState(() => new Date(world?.simulationAt || simulation.currentSimulationAt).getTime())
  const [replayPlaying, setReplayPlaying] = useState(false)
  const [replayRate, setReplayRate] = useState(6)
  const [loadingReplay, setLoadingReplay] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState(asamiId)

  const rangeStart = new Date(simulation.startedSimulationAt).getTime()
  const rangeEnd = new Date(simulation.currentSimulationAt).getTime()
  const replayMax = Math.max(rangeStart + 1, rangeEnd)

  useEffect(() => {
    if (mode !== 'live') return
    setDisplayWorld(world)
    const nextAt = new Date(world?.simulationAt || simulation.currentSimulationAt).getTime()
    if (Number.isFinite(nextAt)) setReplayAt(nextAt)
  }, [mode, simulation.currentSimulationAt, world])

  useEffect(() => {
    if (mode !== 'replay') return
    const timer = window.setTimeout(() => {
      setLoadingReplay(true)
      setError(null)
      api.world(simulation.id, new Date(Math.min(replayAt, rangeEnd)).toISOString())
        .then(setDisplayWorld)
        .catch((e) => setError(e instanceof Error ? e.message : 'Impossibile ricostruire questo istante della simulazione.'))
        .finally(() => setLoadingReplay(false))
    }, 160)
    return () => window.clearTimeout(timer)
  }, [mode, replayAt, rangeEnd, simulation.id])

  useEffect(() => {
    if (!replayPlaying || mode !== 'replay') return
    const timer = window.setInterval(() => {
      setReplayAt((value) => Math.min(replayMax, value + replayRate * 3600000 * .5))
    }, 500)
    return () => window.clearInterval(timer)
  }, [mode, replayMax, replayPlaying, replayRate])

  useEffect(() => {
    if (replayAt >= replayMax && replayPlaying) setReplayPlaying(false)
  }, [replayAt, replayMax, replayPlaying])

  useEffect(() => {
    if (!displayWorld?.actors.some((actor) => actor.id === selectedId)) {
      const asami = displayWorld?.actors.find((actor) => actor.isAsami)
      setSelectedId(asami?.id || displayWorld?.actors[0]?.id || asamiId)
    }
  }, [asamiId, displayWorld, selectedId])

  const projection = useMemo(() => projectWorld(displayWorld?.locations || []), [displayWorld?.locations])
  const selected = displayWorld?.actors.find((actor) => actor.id === selectedId) || null
  const selectedLocation = selected?.locationId ? displayWorld?.locations.find((location) => location.locationId === selected.locationId) || null : null
  const selectedTargetLocation = selected?.action?.targetLocationId
    ? displayWorld?.locations.find((location) => location.locationId === selected.action?.targetLocationId) || null
    : null
  const targetActor = selected?.action?.targetEntityId
    ? displayWorld?.actors.find((actor) => actor.id === selected.action?.targetEntityId) || null
    : null

  const currentNeeds = dashboard && mode === 'live' ? [...dashboard.needs].sort((a, b) => Number(a.value) - Number(b.value)).slice(0, 4) : []
  const currentEmotions = dashboard && mode === 'live' ? dashboard.emotions.slice(0, 4) : []
  const hour = displayWorld ? new Date(displayWorld.simulationAt).getUTCHours() : 12
  const phase = hour < 6 || hour >= 21 ? 'night' : hour < 9 ? 'morning' : hour < 18 ? 'day' : 'evening'
  const weather = selectedLocation?.environment?.weather || 'CLEAR'

  const enterReplay = (at?: string) => {
    const next = at ? new Date(at).getTime() : new Date(displayWorld?.simulationAt || simulation.currentSimulationAt).getTime()
    setMode('replay')
    setReplayPlaying(false)
    setReplayAt(Number.isFinite(next) ? Math.max(rangeStart, Math.min(rangeEnd, next)) : rangeEnd)
  }

  const goLive = () => {
    setReplayPlaying(false)
    setMode('live')
    setError(null)
  }

  if (!displayWorld) {
    return <div className="live-world-empty"><EmptyState icon={<Globe2 size={23} />} title="Mondo non disponibile" text="Il motore non ha ancora restituito una scena del mondo. Riprova dalla barra superiore." /></div>
  }

  return <div className={cn('live-world-page', 'phase-' + phase, mode === 'replay' ? 'is-replay' : 'is-live')}>
    <header className="live-world-header">
      <div>
        <div className="eyebrow">OSSERVATORIO · MONDO FISICO</div>
        <div className="live-world-title-row">
          <h1>Mondo vivo</h1>
          <span className={cn('world-mode-pill', mode)}>{mode === 'live' ? <Radio size={11} /> : <RotateCcw size={11} />} {mode === 'live' ? 'LIVE' : 'REPLAY'}</span>
          {mode === 'replay' && <span className="world-replay-range">storia · {formatReplayDuration(rangeStart, rangeEnd)}</span>}
        </div>
        <p>Guarda il quartiere e gli abitanti mentre le decisioni del motore diventano comportamenti visibili.</p>
      </div>
      <div className="live-world-meta">
        <div className="world-clock"><Clock3Icon /><strong>{formatSimTime(displayWorld.simulationAt)}</strong></div>
        <div className="world-meta-line">{displayWorld.meta.actorCount} persone · {displayWorld.meta.locationCount} luoghi · {displayWorld.meta.eventCount} eventi recenti</div>
        {selectedLocation && <div className="world-weather">{weatherIcon(weather)} {labelize(weather)} · {selectedLocation.environment?.temperature ?? '—'}°</div>}
      </div>
    </header>

    <section className="world-replay-panel">
      <div className="replay-head">
        <div className="replay-controls">
          {mode === 'replay' && <button className="world-control-button" onClick={() => setReplayPlaying((value) => !value)} title={replayPlaying ? 'Pausa replay' : 'Avvia replay'}>{replayPlaying ? <Pause size={15} /> : <Play size={15} />}</button>}
          <button className={cn('world-mode-button', mode === 'live' && 'active')} onClick={goLive}><Radio size={13} /> Live</button>
          <button className={cn('world-mode-button', mode === 'replay' && 'active')} onClick={() => enterReplay()}><RotateCcw size={13} /> Replay</button>
          {mode === 'replay' && <select value={replayRate} onChange={(e) => setReplayRate(Number(e.target.value))} aria-label="Velocità replay">{REPLAY_RATES.map((rate) => <option key={rate.value} value={rate.value}>{rate.label}</option>)}</select>}
        </div>
        <div className="replay-time">
          <strong>{formatSimTime(displayWorld.simulationAt)}</strong>
          {mode === 'replay' && <span>di {formatSimTime(simulation.currentSimulationAt)}</span>}
          {loadingReplay && <span className="replay-loading">ricostruzione…</span>}
        </div>
      </div>
      <input
        className="replay-slider"
        type="range"
        min={rangeStart}
        max={replayMax}
        value={Math.max(rangeStart, Math.min(replayMax, replayAt))}
        disabled={mode === 'live' || rangeEnd <= rangeStart}
        onChange={(e) => { setMode('replay'); setReplayPlaying(false); setReplayAt(Number(e.target.value)) }}
        aria-label="Posizione temporale del replay"
      />
      <div className="replay-scale"><span>{formatSimTime(rangeStart)}</span><span>{formatSimTime(rangeEnd)}</span></div>
    </section>

    {error && <ErrorState text={error} retry={() => enterReplay()} />}

    <div className="world-main-grid">
      <section className="world-canvas-panel">
        <div className="world-canvas-topbar">
          <div><Sparkles size={14} /><strong>Quartiere simulato</strong><span>{mode === 'live' ? 'stato corrente del motore' : 'istantanea storica'}</span></div>
          <span className="world-follow"><LocateFixed size={12} /> {selected ? 'segui ' + selected.displayName : 'seleziona un abitante'}</span>
        </div>

        <div className="world-canvas">
          <svg className="world-roads" viewBox="0 0 1000 680" preserveAspectRatio="none" aria-hidden="true">
            <defs><filter id="worldGlow"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
            {Array.from(projection.points.entries()).map(([locationId, point]) => {
              const location = displayWorld.locations.find((item) => item.locationId === locationId)
              if (!location) return null
              return location.connectionIds.filter((targetId) => projection.points.has(targetId) && targetId > locationId).map((targetId) => {
                const target = projection.points.get(targetId)
                if (!target) return null
                return <line key={locationId + '-' + targetId} x1={point.x} y1={point.y} x2={target.x} y2={target.y} className="world-road" />
              })
            })}
            <path d={'M 0 ' + (340 + Math.sin(hour / 24 * Math.PI * 2) * 12) + ' C 180 295, 300 380, 490 342 S 760 282, 1000 340'} className="world-river" />
          </svg>

          <div className="world-grid-lines" aria-hidden="true" />

          {displayWorld.locations.map((location) => {
            const point = projection.points.get(location.locationId)
            if (!point) return null
            const active = selectedLocation?.locationId === location.locationId
            const hasEvent = displayWorld.recentEvents.some((event) => event.locationId === location.locationId && new Date(event.simulationAt).getTime() >= new Date(displayWorld.simulationAt).getTime() - 6 * 3600000)
            const occupant = displayWorld.actors.find((actor) => actor.locationId === location.locationId)
            return <button
              key={location.locationId}
              className={cn('world-location', active && 'selected', hasEvent && 'has-event')}
              style={{ left: point.x / 10 + '%', top: point.y / 6.8 + '%' }}
              onClick={() => { if (occupant) setSelectedId(occupant.id) }}
              title={location.description || location.name}
            >
              <span className="location-icon">{locationIcon(location.locationType)}</span>
              <span className="location-label">{location.name}</span>
              {hasEvent && <i className="location-pulse" />}
            </button>
          })}

          {displayWorld.actors.map((actor) => {
            if (actor.latitude === null || actor.longitude === null) return null
            const x = ((Number(actor.longitude) - projection.minLon) / Math.max(.000001, projection.maxLon - projection.minLon)) * 100
            const y = (1 - (Number(actor.latitude) - projection.minLat) / Math.max(.000001, projection.maxLat - projection.minLat)) * 100
            return <button
              key={actor.id}
              className={cn('world-actor', actor.id === selectedId && 'selected', actor.isAsami && 'asami', actor.moving && 'moving')}
              style={{ left: x + '%', top: y + '%' }}
              onClick={() => setSelectedId(actor.id)}
              title={actor.displayName + ' · ' + actionLabel(actor)}
            >
              <span className="actor-glow" />
              <span className="actor-core"><UserRound size={actor.isAsami ? 17 : 14} /></span>
              <span className="actor-name">{actor.displayName}</span>
              {actor.moving && <span className="actor-move"><Footprints size={10} /></span>}
            </button>
          })}
        </div>

        <div className="world-legend">
          <span><i className="legend-dot asami-dot" /> Asami</span>
          <span><i className="legend-dot person-dot" /> Abitante</span>
          <span><i className="legend-line" /> Connessione</span>
          <span><i className="legend-pulse" /> Evento</span>
        </div>
      </section>

      <aside className="world-inspector">
        {selected ? <div className="inspector-content">
          <div className="inspector-hero">
            <div className={cn('inspector-avatar', selected.isAsami && 'asami')}><UserRound size={22} /></div>
            <div><div className="eyebrow">{selected.isAsami ? 'ENTITÀ OSSERVATA' : 'ABITANTE'}</div><h2>{selected.displayName}</h2><span>{selected.description || 'Persona presente nel quartiere.'}</span></div>
          </div>

          <div className="inspector-state">
            <div><span>Stato</span><strong>{selected.moving ? 'In movimento' : selected.action ? labelize(selected.action.actionType) : 'Libero'}</strong></div>
            <div><span>Luogo</span><strong>{selectedLocation?.name || '—'}</strong></div>
            <div><span>Obiettivo immediato</span><strong>{selectedTargetLocation?.name || targetActor?.displayName || '—'}</strong></div>
          </div>

          {selected.movement && <div className="movement-card">
            <div className="movement-head"><Footprints size={15} /><span>Percorso in corso</span><strong>{Math.round(selected.movement.progress * 100)}%</strong></div>
            <div className="movement-route"><span>{selected.movement.originName || 'Origine'}</span><i>→</i><span>{selected.movement.destinationName || 'Destinazione'}</span></div>
            <ProgressBar value={selected.movement.progress} compact />
            <small>Arrivo stimato · {formatSimTime(selected.movement.arrivalSimulationAt)}</small>
          </div>}

          {selected.isAsami && mode === 'live' && dashboard && <div className="inspector-metrics">
            <div className="inspector-section-label">STATO INTERNO · AGGIORNAMENTO LIVE</div>
            <div className="inspector-metric-grid">
              {currentNeeds.map((need) => <div key={need.code}><span>{labelize(need.name)}</span><strong>{pct(needPressure(need.code, Number(need.value)))}</strong><ProgressBar value={needPressure(need.code, Number(need.value))} compact /></div>)}
              {currentEmotions.map((emotion) => <div key={emotion.code}><span>{labelize(emotion.name)}</span><strong>{pct(emotion.intensity)}</strong><ProgressBar value={emotion.intensity} compact /></div>)}
            </div>
          </div>}

          {selected.isAsami && mode === 'replay' && <div className="inspector-history-note">
            <RotateCcw size={15} />
            <div><strong>Istantanea storica</strong><span>Il replay ricostruisce posizione, movimenti, azioni ed eventi. Lo stato mentale dettagliato resta quello corrente e non viene mostrato per evitare di mescolare presente e passato.</span></div>
          </div>}

          <div className="inspector-action">
            <div className="inspector-section-label">ATTIVITÀ</div>
            {selected.action ? <div className="activity-row"><span>{actionLabel(selected)}</span><b>{labelize(selected.action.status)}</b><small>iniziata {formatSimTime(selected.action.startedAt)}</small></div> : <div className="activity-idle"><UserRound size={14} /> Nessuna azione attiva in questo istante.</div>}
          </div>
        </div> : <EmptyState icon={<UserRound size={21} />} title="Seleziona un abitante" text="Clicca un'entità sulla mappa per aprire il suo inspector." />}
      </aside>
    </div>

    <div className="world-bottom-grid">
      <section className="world-event-panel">
        <div className="world-panel-header"><div><div className="eyebrow">SEQUENZA OSSERVABILE</div><h2>Event feed</h2></div><span>{displayWorld.recentEvents.length} recenti</span></div>
        {displayWorld.recentEvents.length ? <div className="world-event-list">
          {displayWorld.recentEvents.map((event) => <button key={event.id} className={cn('world-event-row', eventSeverity(event.importance))} onClick={() => enterReplay(event.simulationAt)}>
            <span className="world-event-mark" />
            <div><div className="world-event-meta"><span>{formatSimTime(event.simulationAt)}</span><b>{labelize(event.type)}</b></div><strong>{event.title}</strong><small>{event.description || 'Evento registrato nel mondo simulato.'}</small></div>
            <span className="world-event-place">{event.locationId ? displayWorld.locations.find((location) => location.locationId === event.locationId)?.name || 'Mondo' : 'Mondo'}</span>
          </button>)}
        </div> : <EmptyState icon={<Globe2 size={20} />} title="Nessun evento" text="Gli eventi ambientali e sociali compariranno qui mentre il mondo evolve." />}
      </section>

      <section className="world-status-panel">
        <div className="world-panel-header"><div><div className="eyebrow">SCENA</div><h2>Stato del quartiere</h2></div><span>{labelize(phase)}</span></div>
        <div className="world-status-grid">
          <div><span>Luoghi attivi</span><strong>{displayWorld.meta.locationCount}</strong><small>rete collegata dal grafo fisico</small></div>
          <div><span>Abitanti visibili</span><strong>{displayWorld.meta.actorCount}</strong><small>persone attive nel mondo</small></div>
          <div><span>Eventi recenti</span><strong>{displayWorld.meta.eventCount}</strong><small>finestra osservata fino a questo istante</small></div>
          <div><span>Modalità</span><strong>{mode === 'live' ? 'Tempo reale' : 'Storico'}</strong><small>{mode === 'live' ? 'WebSocket + stato backend' : 'ricostruzione server-side'}</small></div>
        </div>
        <div className="world-status-note"><Globe2 size={15} /><span>La scena non ha logica autonoma: è una rappresentazione del mondo persistito dal motore di simulazione.</span></div>
      </section>
    </div>
  </div>
}

function Clock3Icon() {
  return <span className="clock-icon" aria-hidden="true">◷</span>
}
