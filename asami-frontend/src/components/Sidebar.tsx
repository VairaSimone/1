import { Brain, BrainCircuit, Clock3, Database, HeartHandshake, History, LayoutDashboard, MessageCircle, Plus, Sparkles, Users, Activity } from 'lucide-react'
import type { Simulation } from '../types'
import { formatSimTime } from '../lib/format'
import { Brand } from './Brand'
import type { View } from '../App'

interface Props {
  simulations: Simulation[]
  simulation: Simulation | null
  view: View
  setView: (v: View) => void
  onSimulationChange: (id: string) => void
  onNewSimulation: () => void
}

export function Sidebar({ simulations, simulation, view, setView, onSimulationChange, onNewSimulation }: Props) {
  const nav = [
    ['overview', LayoutDashboard, 'Panoramica'],
    ['analysis', Activity, 'Analisi'],
    ['timeline', History, 'Cronologia'],
    ['memory', BrainCircuit, 'Memoria'],
    ['mind', Brain, 'Mente di Asami'],
    ['relationships', HeartHandshake, 'Relazioni'],
    ['development', Sparkles, 'Sviluppo'],
    ['chat', MessageCircle, 'Parla con Asami'],
  ] as const

  return (
    <aside className="sidebar">
      <Brand />
      <div className="sim-picker">
        <div className="eyebrow">SIMULAZIONE</div>
        <select value={simulation?.id || ''} onChange={(e) => onSimulationChange(e.target.value)} aria-label="Seleziona simulazione">
          {simulations.length === 0 && <option value="">Nessuna simulazione</option>}
          {simulations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className="ghost-button full" onClick={onNewSimulation}><Plus size={15} /> Nuova simulazione</button>
      </div>
      <nav className="nav-stack" aria-label="Sezioni">
        {nav.map(([key, Icon, label]) => (
          <button key={key} className={`nav-item ${view === key ? 'active' : ''}`} onClick={() => setView(key)}>
            <Icon size={17} /> <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="mini-stat"><Database size={15} /><span>MySQL come fonte dati</span></div>
        <div className="mini-stat"><Clock3 size={15} /><span>{simulation ? formatSimTime(simulation.currentSimulationAt) : '—'}</span></div>
        <div className="mini-stat"><Users size={15} /><span>Motore di autonomia</span></div>
        <div className="version-chip">Frontend 1.1 · Cognizione v2</div>
      </div>
    </aside>
  )
}
