import { Pause, Play, RefreshCw, Square, Gauge, Wifi, WifiOff } from 'lucide-react'
import type { Simulation } from '../types'
import { formatSimTime, labelize } from '../lib/format'

interface Props {
  simulation: Simulation | null
  clockSpeed: number
  wsConnected: boolean
  refreshing: boolean
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onSpeed: (speed: number) => void
  onRefresh: () => void
}

export function Topbar({ simulation, clockSpeed, wsConnected, refreshing, onPause, onResume, onStop, onSpeed, onRefresh }: Props) {
  const running = simulation?.status === 'RUNNING'
  return (
    <header className="topbar">
      <div className="topbar-context">
        <div className="status-line">
          <span className={`status-dot ${running ? 'running' : simulation?.status === 'PAUSED' ? 'paused' : 'stopped'}`} />
          <strong>{simulation?.status ? labelize(simulation.status) : 'NESSUNA SIMULAZIONE'}</strong>
          <span className="muted">·</span>
          <span className="sim-time">{formatSimTime(simulation?.currentSimulationAt)}</span>
        </div>
        <div className="realtime-badge">{wsConnected ? <><Wifi size={13} /> tempo reale</> : <><WifiOff size={13} /> aggiornamento di riserva</>}</div>
      </div>
      <div className="topbar-actions">
        <div className="speed-control"><Gauge size={14} /><span>×</span><select value={String(clockSpeed)} onChange={(e) => onSpeed(Number(e.target.value))} disabled={!simulation} aria-label="Velocità della simulazione">
          {[0.25, 0.5, 1, 2, 5, 10, 30, 60, 120].map((v) => <option key={v} value={v}>{v}</option>)}
        </select><span className="speed-label">velocità</span></div>
        {running ? <button className="icon-button" title="Metti in pausa" onClick={onPause}><Pause size={16} /></button> : <button className="icon-button primary" title="Riprendi" onClick={onResume} disabled={!simulation || simulation.status === 'STOPPED'}><Play size={16} /></button>}
        <button className="icon-button danger" title="Ferma" onClick={onStop} disabled={!simulation || simulation.status === 'STOPPED'}><Square size={15} /></button>
        <button className="icon-button" title="Aggiorna" onClick={onRefresh} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'spin' : ''} /></button>
      </div>
    </header>
  )
}
