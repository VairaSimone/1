import { AlertTriangle, ArrowUpRight, CheckCircle2, CircleDashed, LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { labelize, pct } from '../lib/format'

export function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>
}

export function Panel({ title, eyebrow, children, right, className = '' }: { title?: string; eyebrow?: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="panel-head"> <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}{title && <h2>{title}</h2>}</div>{right}</div>{children}</section>
}

export function ProgressBar({ value, label, compact = false }: { value: number; label?: string; compact?: boolean }) {
  const v = Math.max(0, Math.min(1, Number(value) || 0))
  return <div className={`progress-wrap ${compact ? 'compact' : ''}`}>{label && <div className="progress-label"><span>{label}</span><span>{pct(v)}</span></div>}<div className="progress"><div className="progress-fill" style={{ width: `${v * 100}%` }} /></div></div>
}

export function EmptyState({ icon = <CircleDashed size={22} />, title, text }: { icon?: ReactNode; title: string; text: string }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><span>{text}</span></div>
}

export function ErrorState({ text, retry }: { text: string; retry?: () => void }) {
  return <div className="error-state"><AlertTriangle size={18} /><div><strong>Qualcosa non torna</strong><span>{text}</span></div>{retry && <button className="ghost-button" onClick={retry}>Riprova</button>}</div>
}

export function LoadingState({ text = 'Caricamento…' }: { text?: string }) {
  return <div className="loading-state"><LoaderCircle size={18} className="spin" /> {text}</div>
}

export function Score({ label, value }: { label: string; value: number }) {
  return <div className="score-row"><span>{labelize(label)}</span><div className="score-line"><div className="score-track"><div className="score-value" style={{ width: `${Math.max(0, Math.min(1, Number(value) || 0)) * 100}%` }} /></div><span>{pct(value)}</span></div></div>
}

export function StatusPill({ value }: { value: string }) {
  const lower = value.toLowerCase()
  const ok = ['running', 'active', 'completed', 'delivered', 'sent'].includes(lower)
  return <span className={`status-pill ${ok ? 'ok' : lower.includes('pause') ? 'warn' : 'neutral'}`}>{ok ? <CheckCircle2 size={12} /> : <ArrowUpRight size={12} />}{labelize(value)}</span>
}
