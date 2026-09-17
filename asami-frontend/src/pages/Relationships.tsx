import { HeartHandshake, Shield, Sparkles } from 'lucide-react'
import type { Relationship } from '../types'
import { labelize, pct } from '../lib/format'
import { EmptyState, Panel, Score } from '../components/Ui'

export function Relationships({ relationships }: { relationships: Relationship[] }) {
  return <Panel title="Rete delle relazioni" eyebrow="STATO SOCIALE" right={<span className="tiny-muted">{relationships.length} collegamenti attivi</span>}>
    {relationships.length ? <div className="relationship-grid">{relationships.map((r) => <div className="relationship-card" key={r.id}><div className="relationship-head"><div className="relationship-avatar"><HeartHandshake size={18} /></div><div><strong>{labelize(r.type)}</strong><span>relazione · {r.id.slice(0, 8)}</span></div><div className="relationship-strength"><Sparkles size={13} />{pct(r.closenessScore)}</div></div><div className="relationship-scores"><Score label="Fiducia" value={r.trustScore} /><Score label="Affetto" value={r.affectionScore} /><Score label="Rispetto" value={r.respectScore} /><Score label="Familiarità" value={r.familiarityScore} /><Score label="Conflitto" value={r.conflictScore} /></div><div className="relationship-footer"><span><Shield size={13} /> Origine: {r.sourceEntityId === r.targetEntityId ? 'sé' : r.sourceEntityId.slice(0, 8)}</span><span>Destinazione: {r.targetEntityId.slice(0, 8)}</span></div></div>)}</div> : <EmptyState icon={<HeartHandshake size={21} />} title="Nessuna relazione" text="Asami costruirà relazioni quando nella simulazione saranno presenti altre entità." />}
  </Panel>
}
