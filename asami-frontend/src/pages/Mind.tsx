import { useEffect, useState } from 'react'
import { Brain, Compass, HeartHandshake, Lightbulb, RefreshCw, Sparkles, Target, TriangleAlert } from 'lucide-react'
import { EmptyState, Panel } from '../components/Ui'
import { api } from '../lib/api'
import { formatSimTime, labelize, pct } from '../lib/format'
import type { MindData } from '../types'
import './Mind.css'

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="mind-metric"><span>{label}</span><strong>{pct(value)}</strong><div className="mind-meter"><i style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} /></div></div>
}

function pretty(value: unknown) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

export function Mind({ simulationId, entityId, onRefresh }: { simulationId: string; entityId: string; onRefresh?: () => void }) {
  const [data, setData] = useState<MindData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true); setError(null)
    try { setData(await api.mind(simulationId, entityId)); onRefresh?.() } catch (e) { setError(e instanceof Error ? e.message : 'Impossibile caricare la mente di Asami.') } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [simulationId, entityId])

  if (loading && !data) return <div className="mind-loading"><Brain size={20} className="spin" /> Ricostruzione dello stato cognitivo…</div>
  if (error && !data) return <div className="mind-error"><TriangleAlert size={18} /><div><strong>Mind state non disponibile</strong><span>{error}</span></div><button className="ghost-button" onClick={() => void load()}><RefreshCw size={14} /> Riprova</button></div>
  if (!data) return <EmptyState title="Nessun dato cognitivo" text="Lo stato mentale di Asami non è ancora disponibile." />

  const activeConflicts = data.state.conflicts || []
  const latestExpectation = data.expectations[0]
  return <div className="mind-page">
    {error && <div className="mind-inline-error"><TriangleAlert size={15} /> {error}</div>}
    <div className="mind-top-grid">
      <Panel title="Self model" eyebrow="IDENTITY">
        <div className="mind-identity">
          <div><span>Identity</span><strong>{data.self?.identitySummary || '—'}</strong></div>
          <div><span>Self concept</span><p>{data.self?.selfConcept || '—'}</p></div>
          <div><span>Current self view</span><p>{data.self?.currentSelfView || '—'}</p></div>
        </div>
      </Panel>
      <Panel title="Current attention" eyebrow="ATTENTION">
        <div className="mind-signal-list">
          {data.state.attention.length ? data.state.attention.slice(0, 6).map((item, index) => <div className="mind-signal" key={`${String(item.type)}-${index}`}><Compass size={14} /><div><strong>{labelize(String(item.type || 'SIGNAL'))}</strong><span>{String(item.title || item.reason || item.code || 'Salient internal signal')}</span></div>{typeof item.intensity === 'number' && <b>{Math.round(item.intensity * 100)}%</b>}</div>) : <EmptyState title="Nessuna attenzione registrata" text="Il prossimo decision cycle produrrà un nuovo focus." />}
        </div>
      </Panel>
    </div>

    <div className="mind-grid three">
      <Panel title="Values" eyebrow="WHAT MATTERS">
        <div className="mind-metrics">{data.values.slice(0, 8).map(v => <Metric key={v.id} label={v.label} value={v.importance} />)}</div>
      </Panel>
      <Panel title="Long-term desires" eyebrow="WHAT I WANT">
        <div className="mind-desire-list">{data.desires.length ? data.desires.map(d => <div className="mind-desire" key={d.id}><div><strong>{d.title}</strong><span>{d.description || '—'}</span></div><b>{Math.round(d.priority * 100)}%</b><div className="mind-progress"><i style={{ width: `${d.progress * 100}%` }} /></div></div>) : <EmptyState title="Nessun desiderio persistente" text="" />}</div>
      </Panel>
      <Panel title="Self beliefs" eyebrow="WHAT I BELIEVE ABOUT MYSELF">
        <div className="mind-belief-list">{data.beliefs.map(b => <div className="mind-belief" key={b.id}><strong>{b.statement}</strong><span>{Math.round(b.confidence * 100)}% confidence · {labelize(b.sourceType)}</span></div>)}</div>
      </Panel>
    </div>

    <div className="mind-grid two">
      <Panel title="Interpretation" eyebrow="HOW I READ THE SITUATION">
        <div className="mind-interpretations">{data.state.interpretation.length ? data.state.interpretation.map((item, index) => <div key={index}><Lightbulb size={15} /><div><strong>{labelize(String(item.type || 'INTERPRETATION'))}</strong><span>{String(item.statement || '—')}</span></div>{typeof item.confidence === 'number' && <b>{Math.round(item.confidence * 100)}%</b>}</div>) : <EmptyState title="Nessuna interpretazione recente" text="" />}</div>
      </Panel>
      <Panel title="Internal conflicts" eyebrow="COMPETING MOTIVES">
        <div className="mind-conflicts">{activeConflicts.length ? activeConflicts.map((c, index) => <div className="mind-conflict" key={index}><Sparkles size={15} /><div><strong>{String(c.left?.code || c.left?.id || 'Driver')} ↔ {String(c.right?.code || c.right?.id || 'Driver')}</strong><span>Intensity {Math.round(Number(c.intensity || 0) * 100)}%</span></div></div>) : <EmptyState title="Nessun conflitto forte" text="I motivi attivi non sono abbastanza vicini da creare una collisione significativa." />}</div>
      </Panel>
    </div>

    <div className="mind-grid two">
      <Panel title="Expectation → outcome" eyebrow="PREDICTION ERROR">
        {latestExpectation ? <div className="mind-expectation"><div className="expectation-head"><span>{labelize(latestExpectation.actionType)}</span><b>{latestExpectation.status}</b></div><div className="expectation-values"><Metric label="Expected utility" value={latestExpectation.expectedUtility} /><Metric label="Expected success" value={latestExpectation.expectedSuccessProbability} /></div><div className="mind-outcome-row"><div><span>Prediction error</span><strong>{latestExpectation.predictionError === null ? 'open' : latestExpectation.predictionError.toFixed(3)}</strong></div><div><span>Regret</span><strong>{latestExpectation.regretScore === null ? 'open' : latestExpectation.regretScore.toFixed(3)}</strong></div></div></div> : <EmptyState title="Nessuna previsione risolta" text="Le prossime decisioni produrranno expectation e prediction error persistenti." />}
      </Panel>
      <Panel title="Counterfactuals" eyebrow="WHAT ELSE COULD I HAVE DONE">
        <div className="mind-counterfactuals">{data.counterfactuals.length ? data.counterfactuals.slice(0, 6).map(c => <div className="mind-counterfactual" key={c.id}><Target size={14} /><div><strong>{labelize(c.alternativeAction)}</strong><span>Predicted utility {c.predictedUtility.toFixed(2)}</span></div><b>regret {c.regretScore.toFixed(2)}</b></div>) : <EmptyState title="Nessun controfattuale" text="Il sistema salva alternative rilevanti quando Asami prende una decisione." />}</div>
      </Panel>
    </div>

    <div className="mind-grid two">
      <Panel title="Autobiographical narrative" eyebrow="LIFE STORY">
        <div className="mind-narrative">{data.narrative.map(chapter => <div key={chapter.id}><span>Chapter {chapter.chapterIndex}</span><strong>{chapter.title}</strong><p>{chapter.summary}</p><small>{formatSimTime(chapter.createdAt)}</small></div>)}</div>
      </Panel>
      <Panel title="Social mind" eyebrow="GROUPS · REPUTATION · OBLIGATIONS">
        <div className="mind-social-summary"><div className="social-kpi"><HeartHandshake size={15} /><strong>{data.social.memberships.length}</strong><span>groups</span></div><div className="social-kpi"><HeartHandshake size={15} /><strong>{data.social.reputations.length}</strong><span>reputations</span></div><div className="social-kpi"><HeartHandshake size={15} /><strong>{data.social.obligations.length + data.promises.length}</strong><span>open commitments</span></div></div>
        <div className="mind-commitments">{[...data.promises.map(p => ({ ...p, kind:'PROMISE' })), ...data.social.obligations.map(o => ({ ...o, kind:'OBLIGATION' }))].slice(0, 8).map((item, index) => <div key={`${String(item.id)}-${index}`}><span>{String(item.kind)}</span><strong>{String(item.title)}</strong><small>{String(item.dueSimulationAt || 'No deadline')}</small></div>)}</div>
      </Panel>
    </div>

    <div className="mind-footer"><span>Latest cognitive state: {data.state.simulationTime ? formatSimTime(data.state.simulationTime) : '—'}</span><button className="ghost-button" onClick={() => void load()}><RefreshCw size={14} /> Refresh mind</button></div>
  </div>
}
