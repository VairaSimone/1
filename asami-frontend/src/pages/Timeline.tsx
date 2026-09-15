import { Activity, Clock3, Globe2 } from 'lucide-react'
import type { EventItem, TimelineItem } from '../types'
import { formatSimTime, labelize, pct } from '../lib/format'
import { EmptyState, Panel } from '../components/Ui'

export function Timeline({ items, events }: { items: TimelineItem[]; events: EventItem[] }) {
  return <div className="split-grid"><Panel title="Live timeline" eyebrow="EVENTS + ACTIONS"><div className="timeline">{items.length ? items.map((item) => <div className="timeline-row" key={`${item.kind}-${item.id}`}><div className={`timeline-dot ${item.kind === 'EVENT' ? 'event' : 'action'}`}>{item.kind === 'EVENT' ? <Globe2 size={13} /> : <Activity size={13} />}</div><div className="timeline-content"><div className="timeline-meta"><span>{formatSimTime(item.at)}</span><b>{item.kind}</b></div><strong>{item.summary}</strong><small>{labelize(item.type)}</small></div></div>) : <EmptyState title="Timeline vuota" text="Gli eventi compariranno qui quando il simulation engine inizierà a produrli." />}</div></Panel><Panel title="Recent events" eyebrow="WORLD OBSERVATION"><div className="compact-table">{events.length ? events.map((e) => <div className="table-row" key={e.id}><div><strong>{e.title}</strong><span>{e.description || labelize(e.type)}</span></div><div className="table-time"><Clock3 size={13} />{formatSimTime(e.simulationAt)}</div><div className="importance">{pct(e.importance)}</div></div>) : <EmptyState title="Nessun evento" text="Il mondo non ha ancora registrato eventi." />}</div></Panel></div>
}
