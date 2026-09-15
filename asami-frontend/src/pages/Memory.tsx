import { BrainCircuit, ChevronRight } from 'lucide-react'
import type { Memory } from '../types'
import { formatSimTime, pct } from '../lib/format'
import { EmptyState, Panel, ProgressBar } from '../components/Ui'

export function Memory({ memories }: { memories: Memory[] }) {
  return <Panel title="Memory stream" eyebrow="CONSOLIDATED + RECALLABLE" right={<span className="tiny-muted">{memories.length} records</span>}>
    {memories.length ? <div className="memory-list">{memories.map((m) => <article className="memory-card" key={m.id}><div className="memory-icon"><BrainCircuit size={17} /></div><div className="memory-body"><div className="memory-head"><span>{formatSimTime(m.simulationAt)}</span><span>importance {pct(m.importance)}</span></div><p>{m.content}</p><div className="memory-bars"><ProgressBar value={m.strength} label="Strength" compact /><ProgressBar value={m.confidence} label="Confidence" compact /><ProgressBar value={m.emotionalIntensity} label="Emotional" compact /></div></div><ChevronRight size={16} className="muted-icon" /></article>)}</div> : <EmptyState icon={<BrainCircuit size={21} />} title="No memories yet" text="The engine will persist experiences as Asami acts and observes the world." />}
  </Panel>
}
