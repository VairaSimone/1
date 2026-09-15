import { HeartHandshake, Shield, Sparkles } from 'lucide-react'
import type { Relationship } from '../types'
import { labelize, pct } from '../lib/format'
import { EmptyState, Panel, Score } from '../components/Ui'

export function Relationships({ relationships }: { relationships: Relationship[] }) {
  return <Panel title="Relationship graph" eyebrow="SOCIAL STATE" right={<span className="tiny-muted">{relationships.length} active links</span>}>
    {relationships.length ? <div className="relationship-grid">{relationships.map((r) => <div className="relationship-card" key={r.id}><div className="relationship-head"><div className="relationship-avatar"><HeartHandshake size={18} /></div><div><strong>{labelize(r.type)}</strong><span>relationship · {r.id.slice(0, 8)}</span></div><div className="relationship-strength"><Sparkles size={13} />{pct(r.closenessScore)}</div></div><div className="relationship-scores"><Score label="Trust" value={r.trustScore} /><Score label="Affection" value={r.affectionScore} /><Score label="Respect" value={r.respectScore} /><Score label="Familiarity" value={r.familiarityScore} /><Score label="Conflict" value={r.conflictScore} /></div><div className="relationship-footer"><span><Shield size={13} /> Source: {r.sourceEntityId === r.targetEntityId ? 'self' : r.sourceEntityId.slice(0, 8)}</span><span>Target: {r.targetEntityId.slice(0, 8)}</span></div></div>)}</div> : <EmptyState icon={<HeartHandshake size={21} />} title="No relationships yet" text="Asami will build relationships only when other entities exist in the simulation." />}
  </Panel>
}
