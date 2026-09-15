import { LineChart, Sparkles } from 'lucide-react'
import type { Development, DevelopmentHistoryItem, Trait } from '../types'
import { formatSimTime, pct } from '../lib/format'
import { EmptyState, Panel, ProgressBar } from '../components/Ui'

export function Development({ current, history, traits }: { current: Development | null; history: DevelopmentHistoryItem[]; traits: Trait[] }) {
  const areas = [
    ['physicalScore', 'Physical'], ['cognitiveScore', 'Cognitive'], ['socialScore', 'Social'], ['emotionalScore', 'Emotional'], ['educationScore', 'Education'],
  ] as const
  return <div className="split-grid"><Panel title="Development state" eyebrow="LONGITUDINAL GROWTH"><div className="dev-grid">{areas.map(([key, label]) => <div className="dev-card" key={key}><span>{label}</span><strong>{pct(Number(current?.[key] ?? 0))}</strong><ProgressBar value={Number(current?.[key] ?? 0)} compact /></div>)}</div></Panel><Panel title="Trait profile" eyebrow="PERSONALITY" right={<span className="tiny-muted">Traits update over experience</span>}><div className="score-stack">{traits.map((t) => <div key={t.code} className="trait-card"><Sparkles size={14} /><div><strong>{t.name}</strong><ProgressBar value={t.value} compact /></div><span>{pct(t.value)}</span></div>)}</div></Panel><Panel title="History" eyebrow="DEVELOPMENT LOG"><div className="history-list">{history.length ? history.slice(0, 40).map((h, i) => <div className="history-row" key={`${h.updatedSimulationAt}-${i}`}><div className="history-point"><LineChart size={13} /></div><div><strong>{h.updatedSimulationAt ? formatSimTime(h.updatedSimulationAt) : '—'}</strong><span>Physical {pct(Number(h.physicalScore ?? 0))} · Cognitive {pct(Number(h.cognitiveScore ?? 0))} · Social {pct(Number(h.socialScore ?? 0))}</span></div></div>) : <EmptyState title="No development history" text="Development snapshots will appear as simulation time advances." />}</div></Panel></div>
}
