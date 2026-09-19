import { Brain, HeartPulse, MapPin, Sparkles, Target, Zap } from 'lucide-react'
import type { Dashboard, Simulation } from '../types'
import { formatSimTime, formatValue, labelize, pct } from '../lib/format'
import { EmptyState, Panel, ProgressBar, Score, StatusPill } from '../components/Ui'

function needPressure(code: string, value: number) {
  const safeValue = Math.max(0, Math.min(1, Number(value) || 0))
  return ['ENERGY', 'SAFETY'].includes(code.toUpperCase()) ? 1 - safeValue : safeValue
}

export function Overview({ simulation, dashboard, clockSpeed }: { simulation: Simulation; dashboard: Dashboard; clockSpeed: number }) {
  const topNeed = [...dashboard.needs].sort((a, b) => needPressure(b.code, b.value) - needPressure(a.code, a.value))[0]
  const topEmotion = dashboard.emotions[0]
  const activeGoals = dashboard.goals.filter((goal) => String(goal.status).toUpperCase() === 'ACTIVE')
  const topGoal = [...activeGoals].sort((a, b) => Number(b.priority) - Number(a.priority))[0]
  const orderedNeeds = [...dashboard.needs].sort((a, b) => needPressure(b.code, b.value) - needPressure(a.code, a.value))
  const action = dashboard.currentAction
  const strongestTraits = [...dashboard.traits].sort((a, b) => Number(b.value) - Number(a.value)).slice(0, 5)
  const loc = dashboard.location

  return <>
    <div className="hero-card">
      <div className="hero-orb"><Sparkles size={32} /></div>
      <div className="hero-copy"><div className="eyebrow">ENTITÀ AUTONOMA · PERSONA</div><h2>{dashboard.entity.displayName}</h2><p>{dashboard.entity.description || 'Persona simulata autonoma.'}</p><div className="hero-meta"><StatusPill value={dashboard.entity.status} /><span>Tempo simulato · {formatSimTime(simulation.currentSimulationAt)}</span></div></div>
      <div className="hero-action"><div className="eyebrow">ADESSO</div><strong>{action ? labelize(action.actionType) : 'Osservazione'}</strong><span>{action?.status ? labelize(action.status) : 'In attesa del prossimo ciclo del motore'}</span></div>
    </div>

    <div className="metric-grid">
      <div className="metric-card"><div className="metric-icon"><HeartPulse size={18} /></div><div><span>Bisogno dominante</span><strong>{topNeed ? labelize(topNeed.name) : '—'}</strong><small>{topNeed ? `${pct(needPressure(topNeed.code, topNeed.value))} di pressione` : 'Nessun dato'}</small></div></div>
      <div className="metric-card"><div className="metric-icon"><Brain size={18} /></div><div><span>Emozione dominante</span><strong>{topEmotion ? labelize(topEmotion.name) : '—'}</strong><small>{topEmotion ? pct(topEmotion.intensity) : 'Nessun dato'}</small></div></div>
      <div className="metric-card"><div className="metric-icon"><Target size={18} /></div><div><span>Intenzione / obiettivo</span><strong>{topGoal?.title || 'Nessun obiettivo attivo'}</strong><small>{topGoal ? `${pct(topGoal.progress)} di avanzamento · P${topGoal.priority}` : 'Il motore ne creerà uno quando necessario'}</small></div></div>
      <div className="metric-card"><div className="metric-icon"><Zap size={18} /></div><div><span>Velocità del tempo</span><strong>×{Number.isInteger(clockSpeed) ? clockSpeed : clockSpeed.toFixed(2)}</strong><small>{labelize(simulation.status)} · v{simulation.version}</small></div></div>
    </div>

    <div className="overview-grid">
      <Panel title="Pressione dei bisogni" eyebrow="STATO INTERNO">
        <div className="list-stack">{orderedNeeds.map((n) => <ProgressBar key={n.code} value={needPressure(n.code, n.value)} label={labelize(n.name)} />)}</div>
      </Panel>
      <Panel title="Campo emotivo" eyebrow="EMOZIONI">
        <div className="emotion-grid">{dashboard.emotions.map((e) => <div className="emotion-tile" key={e.code}><div className="emotion-top"><span>{labelize(e.name)}</span><strong>{pct(e.intensity)}</strong></div><ProgressBar value={e.intensity} compact /></div>)}</div>
      </Panel>
      <Panel title="Traiettoria della personalità" eyebrow="SEGNALI DI SVILUPPO" right={<span className="tiny-muted">Tratti attuali</span>}>
        <div className="score-stack">{strongestTraits.map((t) => <Score key={t.code} label={t.name} value={t.value} />)}</div>
      </Panel>
      <Panel title="Dove / cosa" eyebrow="STATO DEL MONDO">
        {loc ? <div className="location-card"><div className="location-icon"><MapPin size={18} /></div><div><strong>{labelize(loc.locationType)}</strong><span>{loc.addressData ? formatValue(loc.addressData) : 'Posizione collegata ad Asami'}</span><small>Da {formatSimTime(loc.sinceSimulationAt)}</small></div></div> : <EmptyState icon={<MapPin size={20} />} title="Nessuna posizione" text="Lo schema attuale non contiene ancora una posizione per Asami." />}
      </Panel>
    </div>

    <Panel title="Obiettivi" eyebrow="INTENZIONI">
      {activeGoals.length ? <div className="goal-table">{activeGoals.map((g) => <div className="goal-row" key={g.id}><div><strong>{g.title}</strong><span>{g.description || formatValue(g.motivation) || labelize(g.goalType)}</span></div><div className="goal-progress"><ProgressBar value={g.progress} compact /><small>{pct(g.progress)}</small></div><StatusPill value={g.status} /></div>)}</div> : <EmptyState icon={<Target size={20} />} title="Nessun obiettivo" text="Gli obiettivi vengono generati dal motore di autonomia a partire dai bisogni attuali." />}
    </Panel>
  </>
}
