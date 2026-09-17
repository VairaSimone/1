import { BrainCircuit, ChevronRight } from 'lucide-react'
import type { Memory } from '../types'
import { formatSimTime, pct, labelize } from '../lib/format'
import { EmptyState, Panel, ProgressBar } from '../components/Ui'

export function Memory({ memories }: { memories: Memory[] }) {
  return <Panel title="Flusso della memoria" eyebrow="CONSOLIDATA + RICHIAMABILE" right={<span className="tiny-muted">{memories.length} record</span>}>
    {memories.length ? <div className="memory-list">{memories.map((m) => <article className="memory-card" key={m.id}><div className="memory-icon"><BrainCircuit size={17} /></div><div className="memory-body"><div className="memory-head"><span>{formatSimTime(m.simulationAt)}</span><span>importanza {pct(m.importance)}</span></div><p>{m.content}</p><div className="memory-bars"><ProgressBar value={m.strength} label="Forza" compact /><ProgressBar value={m.confidence} label="Affidabilità" compact /><ProgressBar value={m.emotionalIntensity} label="Intensità emotiva" compact /></div><small className="memory-type">{labelize(m.memoryType || 'MEMORY')}</small></div><ChevronRight size={16} className="muted-icon" /></article>)}</div> : <EmptyState icon={<BrainCircuit size={21} />} title="Nessuna memoria" text="Il motore conserverà le esperienze mentre Asami agisce e osserva il mondo." />}
  </Panel>
}
