import { useCallback, useEffect, useRef, useState } from 'react'
import { Brain, Compass, GitBranch, HeartHandshake, Lightbulb, RefreshCw, Sparkles, Target, TriangleAlert } from 'lucide-react'
import { EmptyState, Panel } from '../components/Ui'
import { api } from '../lib/api'
import { formatSimTime, labelize, pct } from '../lib/format'
import type { MindData, PromiseItem } from '../types'
import './Mind.css'

type AttentionItem = { type?: string; title?: string; reason?: string; code?: string; intensity?: number }
type ConflictItem = { left?: { code?: string; id?: string }; right?: { code?: string; id?: string }; intensity?: number }
type CommitmentItem = PromiseItem & { kind: string }

function Metric({ label, value }: { label: string; value: number }) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  return <div className="mind-metric"><span>{label}</span><strong>{pct(safe)}</strong><div className="mind-meter"><i style={{ width: `${safe * 100}%` }} /></div></div>
}

export function Mind({ simulationId, entityId, currentSimulationAt, onRefresh }: { simulationId: string; entityId: string; currentSimulationAt: string; onRefresh?: () => void }) {
  const [data, setData] = useState<MindData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadKeyRef = useRef('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setData(await api.mind(simulationId, entityId)); onRefresh?.() } catch (e) { setError(e instanceof Error ? e.message : 'Impossibile caricare la mente di Asami.') } finally { setLoading(false) }
  }, [entityId, onRefresh, simulationId])

  useEffect(() => {
    const key = `${simulationId}:${entityId}`
    const firstLoadForEntity = loadKeyRef.current !== key
    loadKeyRef.current = key
    let disposed = false
    const timer = window.setTimeout(() => { if (!disposed) void load() }, firstLoadForEntity ? 0 : 700)
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [currentSimulationAt, entityId, load, simulationId])

  if (loading && !data) return <div className="mind-loading"><Brain size={20} className="spin" /> Ricostruzione dello stato cognitivo…</div>
  if (error && !data) return <div className="mind-error"><TriangleAlert size={18} /><div><strong>Stato mentale non disponibile</strong><span>{error}</span></div><button className="ghost-button" onClick={() => void load()}><RefreshCw size={14} /> Riprova</button></div>
  if (!data) return <EmptyState title="Nessun dato cognitivo" text="Lo stato mentale di Asami non è ancora disponibile." />

  const attention = data.state.attention as AttentionItem[]
  const activeConflicts = data.state.conflicts as ConflictItem[]
  const latestExpectation = data.expectations[0]
  const commitments: CommitmentItem[] = [
    ...data.promises.map(p => ({ ...p, kind: 'PROMISE' })),
    ...data.social.obligations.map(o => ({
      id: String(o.id ?? ''), title: String(o.title ?? 'Obbligo'), description: o.description ? String(o.description) : null,
      targetEntityId: o.targetEntityId ? String(o.targetEntityId) : null, dueSimulationAt: o.dueSimulationAt ? String(o.dueSimulationAt) : null,
      status: String(o.status ?? 'OPEN'), importance: Number(o.priority ?? o.importance ?? 0.5), createdAt: String(o.createdAt ?? ''), kind: 'OBLIGATION'
    }))
  ]
  const latestEvolution = data.emergent.evolution[0]
  const causalActivations = data.causal.activations || []
  const causalLinks = data.causal.links || []

  return <div className="mind-page">
    {error && <div className="mind-inline-error"><TriangleAlert size={15} /> {error}</div>}
    <div className="mind-top-grid">
      <Panel title="Modello del sé" eyebrow="IDENTITÀ">
        <div className="mind-identity">
          <div><span>Identità</span><strong>{data.self?.identitySummary || '—'}</strong></div>
          <div><span>Concetto di sé</span><p>{data.self?.selfConcept || '—'}</p></div>
          <div><span>Percezione attuale di sé</span><p>{data.self?.currentSelfView || '—'}</p></div>
        </div>
      </Panel>
      <Panel title="Attenzione attuale" eyebrow="ATTENZIONE">
        <div className="mind-signal-list">
          {attention.length ? attention.slice(0, 6).map((item, index) => <div className="mind-signal" key={`${String(item.type)}-${index}`}><Compass size={14} /><div><strong>{labelize(String(item.type || 'SIGNAL'))}</strong><span>{String(item.title || item.reason || item.code || 'Segnale interno rilevante')}</span></div>{typeof item.intensity === 'number' && <b>{Math.round(item.intensity * 100)}%</b>}</div>) : <EmptyState title="Nessuna attenzione registrata" text="Il prossimo ciclo decisionale produrrà un nuovo focus." />}
        </div>
      </Panel>
    </div>

    <div className="mind-grid three">
      <Panel title="Valori" eyebrow="CIÒ CHE CONTA">
        <div className="mind-metrics">{data.values.slice(0, 8).map(v => <Metric key={v.id} label={v.label} value={v.importance} />)}</div>
      </Panel>
      <Panel title="Desideri a lungo termine" eyebrow="CIÒ CHE VOGLIO">
        <div className="mind-desire-list">{data.desires.length ? data.desires.map(d => <div className="mind-desire" key={d.id}><div><strong>{d.title}</strong><span>{d.description || '—'}</span></div><b>{Math.round(d.priority * 100)}%</b><div className="mind-progress"><i style={{ width: `${Math.max(0, Math.min(100, d.progress * 100))}%` }} /></div></div>) : <EmptyState title="Nessun desiderio persistente" text="" />}</div>
      </Panel>
      <Panel title="Convinzioni su di sé" eyebrow="CIÒ CHE PENSO DI ME">
        <div className="mind-belief-list">{data.beliefs.map(b => <div className="mind-belief" key={b.id}><strong>{b.statement}</strong><span>{Math.round(b.confidence * 100)}% di affidabilità · {labelize(b.sourceType)}</span></div>)}</div>
      </Panel>
    </div>

    <div className="mind-grid two">
      <Panel title="Interpretazione" eyebrow="COME LEGGO LA SITUAZIONE">
        <div className="mind-interpretations">{data.state.interpretation.length ? data.state.interpretation.map((item, index) => <div key={index}><Lightbulb size={15} /><div><strong>{labelize(String(item.type || 'INTERPRETATION'))}</strong><span>{String(item.statement || '—')}</span></div>{typeof item.confidence === 'number' && <b>{Math.round(item.confidence * 100)}%</b>}</div>) : <EmptyState title="Nessuna interpretazione recente" text="" />}</div>
      </Panel>
      <Panel title="Conflitti interni" eyebrow="MOTIVAZIONI IN CONFLITTO">
        <div className="mind-conflicts">{activeConflicts.length ? activeConflicts.map((c, index) => <div className="mind-conflict" key={index}><Sparkles size={15} /><div><strong>{String(c.left?.code || c.left?.id || 'Motivazione')} ↔ {String(c.right?.code || c.right?.id || 'Motivazione')}</strong><span>Intensità {Math.round(Number(c.intensity || 0) * 100)}%</span></div></div>) : <EmptyState title="Nessun conflitto forte" text="Le motivazioni attive non sono abbastanza vicine da creare una collisione significativa." />}</div>
      </Panel>
    </div>

    <div className="mind-grid two">
      <Panel title="Aspettativa → esito" eyebrow="ERRORE DI PREVISIONE">
        {latestExpectation ? <div className="mind-expectation"><div className="expectation-head"><span>{labelize(latestExpectation.actionType)}</span><b>{labelize(latestExpectation.status)}</b></div><div className="expectation-values"><Metric label="Utilità prevista" value={latestExpectation.expectedUtility} /><Metric label="Probabilità di successo prevista" value={latestExpectation.expectedSuccessProbability} /></div><div className="mind-outcome-row"><div><span>Errore di previsione</span><strong>{latestExpectation.predictionError === null ? 'aperto' : latestExpectation.predictionError.toFixed(3)}</strong></div><div><span>Rammarico</span><strong>{latestExpectation.regretScore === null ? 'aperto' : latestExpectation.regretScore.toFixed(3)}</strong></div></div></div> : <EmptyState title="Nessuna previsione risolta" text="Le prossime decisioni produrranno aspettative ed errori di previsione persistenti." />}
      </Panel>
      <Panel title="Controfattuali" eyebrow="COS'ALTRO AVREI POTUTO FARE">
        <div className="mind-counterfactuals">{data.counterfactuals.length ? data.counterfactuals.slice(0, 6).map(c => <div className="mind-counterfactual" key={c.id}><Target size={14} /><div><strong>{labelize(c.alternativeAction)}</strong><span>Utilità prevista {c.predictedUtility.toFixed(2)}</span></div><b>rammarico {c.regretScore.toFixed(2)}</b></div>) : <EmptyState title="Nessun controfattuale" text="Il sistema salva alternative rilevanti quando Asami prende una decisione." />}</div>
      </Panel>
    </div>

    <div className="mind-grid two">
      <Panel title="Mente causale" eyebrow="ESPERIENZA → MEMORIA → CONVINZIONE → DESIDERIO → VALORE">
        {causalActivations.length ? <div className="mind-causal-list">{causalActivations.slice(0, 8).map(item => <div className="mind-causal" key={item.id}><GitBranch size={14} /><div><strong>{labelize(item.sourceType)} · {labelize(item.sourceKey)}</strong><span>→ {labelize(item.targetType)} · {labelize(item.targetKey)}</span></div><b>{item.activation >= 0 ? '+' : '−'}{Math.abs(item.activation).toFixed(2)}</b></div>)}</div> : <EmptyState title="Nessuna catena causale" text="Quando le esperienze vengono propagate, qui comparirà il percorso che ha cambiato la mente di Asami." />}
        <div className="mind-causal-footer"><span>{causalActivations.length} attivazioni recenti · {causalLinks.length} collegamenti appresi</span></div>
      </Panel>
      <Panel title="Traiettoria causale" eyebrow="COME IL CAMBIAMENTO PERSISTE">
        <div className="mind-causal-explain">
          <div><span>Ultima causa</span><strong>{causalActivations[0] ? `${labelize(causalActivations[0].sourceType)} → ${labelize(causalActivations[0].targetType)}` : '—'}</strong></div>
          <div><span>Propagazione più profonda</span><strong>{causalActivations.length ? `${Math.max(...causalActivations.map(a => Number(a.depth || 0)))} livelli` : '—'}</strong></div>
          <div><span>Collegamento più rinforzato</span><strong>{causalLinks[0] ? `${labelize(causalLinks[0].sourceKey)} → ${labelize(causalLinks[0].targetKey)}` : '—'}</strong></div>
        </div>
      </Panel>
    </div>

    <div className="mind-grid two">
      <Panel title="Evoluzione del sé" eyebrow="ESPERIENZA → MODELLO DEL SÉ">
        {latestEvolution ? <div className="mind-narrative"><div><span>{labelize(latestEvolution.triggerType)}</span><strong>{latestEvolution.selfView}</strong><small>{formatSimTime(latestEvolution.simulationTime)}</small></div><div><span>Tasso di successo recente</span><strong>{typeof latestEvolution.metrics?.successRate === 'number' ? pct(latestEvolution.metrics.successRate) : '—'}</strong></div></div> : <EmptyState title="Nessuna evoluzione registrata" text="Le esperienze significative aggiorneranno progressivamente il modello del sé." />}
      </Panel>
      <Panel title="Evidenze di apprendimento" eyebrow="REVISIONE DELLE CONVINZIONI">
        <div className="mind-belief-list">{data.emergent.evidence.length ? data.emergent.evidence.slice(0, 6).map(item => <div className="mind-belief" key={item.id}><strong>{labelize(item.beliefKey)}</strong><span>{item.polarity > 0 ? '+' : '−'} evidenza · {Math.round(item.evidenceStrength * 100)}% · {labelize(item.sourceType)}</span><small>{item.statement || 'Un\'esperienza ha aggiornato questa convinzione.'}</small></div>) : <EmptyState title="Nessuna evidenza" text="Le azioni completate inizieranno a lasciare tracce sulle convinzioni." />}</div>
      </Panel>
    </div>

    <div className="mind-grid two">
      <Panel title="Consolidamento della memoria" eyebrow="EPISODICO → SEMANTICO">
        <div className="mind-narrative">{data.emergent.consolidations.length ? data.emergent.consolidations.map(item => <div key={item.id}><span>{item.sourceCount} esperienze</span><strong>{item.summary}</strong><small>{formatSimTime(item.createdAt)}</small></div>) : <EmptyState title="Nessuna regola consolidata" text="Le esperienze ripetute verranno trasformate in conoscenza più stabile." />}</div>
      </Panel>
      <Panel title="Mondi controfattuali" eyebrow="FUTURI ALTERNATIVI">
        <div className="mind-counterfactuals">{data.emergent.worlds.length ? data.emergent.worlds.slice(0, 6).map(world => <div className="mind-counterfactual" key={world.id}><Target size={14} /><div><strong>{labelize(world.worldKey)}</strong><span>{labelize(world.status)} · utilità {world.predictedUtility.toFixed(2)}</span></div><b>{world.selected ? 'scelto' : `rammarico ${world.regretScore.toFixed(2)}`}</b></div>) : <EmptyState title="Nessun ramo alternativo" text="Ogni decisione importante può lasciare una traccia delle alternative non scelte." />}</div>
      </Panel>
    </div>

    <div className="mind-grid two">
      <Panel title="Narrativa autobiografica" eyebrow="STORIA DI VITA">
        <div className="mind-narrative">{data.narrative.map(chapter => <div key={chapter.id}><span>Capitolo {chapter.chapterIndex}</span><strong>{chapter.title}</strong><p>{chapter.summary}</p><small>{formatSimTime(chapter.createdAt)}</small></div>)}</div>
      </Panel>
      <Panel title="Mente sociale" eyebrow="GRUPPI · REPUTAZIONE · OBBLIGHI">
        <div className="mind-social-summary"><div className="social-kpi"><HeartHandshake size={15} /><strong>{data.social.memberships.length}</strong><span>gruppi</span></div><div className="social-kpi"><HeartHandshake size={15} /><strong>{data.social.reputations.length}</strong><span>reputazioni</span></div><div className="social-kpi"><HeartHandshake size={15} /><strong>{commitments.length}</strong><span>impegni aperti</span></div></div>
        {data.emergent.groups.length > 0 && <div className="mind-commitments">{data.emergent.groups.map(group => <div key={group.id}><span>{labelize(group.groupType)}</span><strong>{group.name}</strong><small>{labelize(group.role || 'MEMBER')}</small></div>)}</div>}
        <div className="mind-commitments">{commitments.slice(0, 8).map((item, index) => <div key={`${item.id}-${index}`}><span>{labelize(item.kind)}</span><strong>{item.title}</strong><small>{item.dueSimulationAt || 'Nessuna scadenza'}</small></div>)}</div>
      </Panel>
    </div>

    <div className="mind-footer"><span>Ultimo stato cognitivo: {data.state.simulationTime ? formatSimTime(data.state.simulationTime) : '—'}</span><button className="ghost-button" onClick={() => void load()}><RefreshCw size={14} /> Aggiorna mente</button></div>
  </div>
}
