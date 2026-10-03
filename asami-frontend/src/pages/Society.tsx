
import { Activity, ArrowRight, Building2, CircleCheck, CircleDashed, Coins, Factory, Gavel, Handshake, Landmark, Scale, ShoppingBag, Sparkles, TrendingUp, Users, WalletCards } from 'lucide-react'
import type { SocietyEvent, SocietySnapshot, WorldSnapshot } from '../types'
import { labelize, pct, formatSimTime } from '../lib/format'
import { EmptyState, Panel, StatusPill } from '../components/Ui'
import './Society.css'

function money(value: number) { return '¤ ' + Number(value || 0).toFixed(2) }
function nameFor(id: string | null | undefined, world: WorldSnapshot | null) {
  if (!id) return '—'
  return world?.actors.find(a => a.id === id)?.displayName
    || world?.locations.find(l => l.locationId === id)?.name
    || id.slice(0, 8)
}
function latestMetric(society: SocietySnapshot | null) { return society?.metrics?.[0] || null }

function societyStage(society: SocietySnapshot) {
  const proposals = society.openEnded?.proposals?.length ?? 0
  const definitions = society.openEnded?.definitions?.length ?? 0
  const structures = society.openEnded?.definitions?.filter(item => ['STRUCTURE', 'INSTITUTION', 'SYSTEM'].includes(String(item.kind).toUpperCase())).length ?? 0
  const economy = society.markets.length > 0 || (society.businesses?.length ?? 0) > 0 || society.trades.length > 0
  const governance = society.policies.length > 0 || society.conflicts.length > 0

  if (governance) return 4
  if (economy) return 3
  if (structures > 0) return 2
  if (proposals > 0 || definitions > 0) return 1
  return 0
}

function societyNarrative(society: SocietySnapshot) {
  const activeBusinesses = society.businesses?.filter(item => item.status === 'ACTIVE').length ?? 0
  const totalBusinesses = society.businesses?.length ?? 0
  const activeJobs = society.jobs.filter(item => item.status === 'ACTIVE').length
  const proposalCount = society.openEnded?.proposals?.length ?? 0
  const definitionCount = society.openEnded?.definitions?.length ?? 0

  if (society.trades.length > 0) {
    return 'La società è entrata in una fase economica osservabile: ci sono già scambi registrati. I prossimi segnali da seguire sono prezzi, produzione, salari e distribuzione della ricchezza.'
  }
  if (society.markets.length > 0) {
    return 'Esiste almeno un mercato con domanda e offerta misurate, ma non risultano ancora scambi recenti. Il passaggio importante da osservare è quando qualcuno inizia a comprare, vendere o produrre per quel mercato.'
  }
  if (activeBusinesses > 0 || totalBusinesses > 0 || activeJobs > 0) {
    return 'L’economia sta iniziando a prendere forma: imprese e rapporti di lavoro sono già tracciati. Ora il sistema può iniziare a far circolare ricavi, salari e beni.'
  }
  if (definitionCount > 0 || proposalCount > 0) {
    return 'Il mondo è nella fase di sperimentazione sociale: gli abitanti stanno producendo nuove attività, strutture o istituzioni. Per ora queste innovazioni non hanno ancora generato un mercato o un ciclo economico completo.'
  }
  return 'La società è ancora nella fase iniziale. Gli abitanti stanno costruendo pressione, esperienze e relazioni da cui potranno emergere nuove organizzazioni.'
}

function societyEventLabel(event: SocietyEvent) {
  const kind = String(event.metadata?.kind || '').toUpperCase()
  if (kind === 'DEFINITION_ACCEPTED') return 'Nuova definizione'
  if (kind === 'SYSTEM_FORMED') return 'Nuovo sistema'
  if (kind.includes('POLICY')) return 'Politica'
  if (kind.includes('BUSINESS')) return 'Impresa'
  if (kind.includes('TRADE')) return 'Scambio'
  if (kind.includes('CONFLICT')) return 'Conflitto'
  if (kind) return labelize(kind)
  return labelize(event.category || event.type || 'Evento')
}

function isSocietyEvent(event: SocietyEvent) {
  const text = [event.title, event.type, event.category, event.metadata?.kind]
    .map(value => String(value || '')).join(' ').toUpperCase()
  return Number(event.importance || 0) >= .6 || /EMERG|DEFINITION|SYSTEM_FORMED|BUSINESS|TRADE|POLICY|CONFLICT|GOVERN/.test(text)
}

function societyEventDetail(event: SocietyEvent, world: WorldSnapshot | null) {
  if (event.description) return event.description
  const location = event.locationId ? nameFor(event.locationId, world) : null
  return location ? `Luogo coinvolto · ${location}` : 'Il motore ha registrato un cambiamento persistente.'
}

export function Society({ society, world }: { society: SocietySnapshot | null; world: WorldSnapshot | null }) {
  if (!society) return <EmptyState icon={<Landmark size={22} />} title="Società non ancora materializzata" text="Il motore deve attraversare alcune iterazioni del mondo prima che compaiano economia, istituzioni e strutture emergenti." />

  const metric = latestMetric(society)
  const systems = society.systems
  const markets = society.markets
  const marketLocationCount = new Set(markets.map(market => String(market.locationId || ''))).size
  const jobs = society.jobs.filter(job => job.status === 'ACTIVE')
  const enacted = society.policies.filter(policy => policy.status === 'ENACTED')
  const proposed = society.policies.filter(policy => policy.status === 'PROPOSED')
  const conflicts = society.conflicts.filter(conflict => conflict.status === 'ACTIVE')
  const recentTrades = society.trades.slice(0, 8)
  const businessMetric = society.businessMetrics?.[0] ?? null
  const openProposals = society.openEnded?.proposals ?? []
  const openDefinitions = society.openEnded?.definitions ?? []
  const macroDefinitions = openDefinitions.filter(item => ['STRUCTURE', 'INSTITUTION', 'SYSTEM'].includes(String(item.kind).toUpperCase()))
  const derivedActivities = openDefinitions.filter(item => String(item.kind).toUpperCase() === 'ACTIVITY')

  return <div className="society-page">
    <div className="society-hero">
      <div>
        <div className="eyebrow">OSSERVATORIO · SOCIETÀ EMERGENTE</div>
        <h1>Società</h1>
        <p>Nessuna città, economia o legge è stata inserita manualmente: qui vedi le strutture che gli abitanti hanno prodotto attraverso bisogni, coordinamento e conflitti.</p>
      </div>
      <div className="society-hero-badge"><TrendingUp size={15} /><span>{metric ? formatSimTime(metric.simulationAt) : 'in formazione'}</span></div>
    </div>

    <section className="society-now">
      <div className="society-now-main">
        <div className="society-now-header">
          <div>
            <div className="eyebrow">STATO DEL MONDO</div>
            <h2>Cosa sta succedendo adesso</h2>
          </div>
          <span className="society-state-pill"><Activity size={13} /> fase {societyStage(society)} / 4</span>
        </div>
        <p className="society-now-summary">{societyNarrative(society)}</p>
        <div className="society-progress">
          {[
            { n: 1, label: 'Pressione', done: society.openEnded?.proposals?.length > 0 || society.openEnded?.definitions?.length > 0, text: 'Bisogni e idee iniziano a produrre proposte.' },
            { n: 2, label: 'Strutture', done: macroDefinitions.length > 0, text: 'Una proposta diventa una struttura, istituzione o sistema persistente.' },
            { n: 3, label: 'Economia', done: society.markets.length > 0 || (society.businesses?.length ?? 0) > 0 || society.trades.length > 0, text: 'Compaiono mercato, produzione, lavoro e scambi.' },
            { n: 4, label: 'Governance', done: society.policies.length > 0 || society.conflicts.length > 0, text: 'Interessi differenti iniziano a produrre regole o conflitti.' },
          ].map((stage, index) => (
            <div className={`society-progress-step ${stage.done ? 'done' : societyStage(society) === stage.n - 1 ? 'current' : 'locked'}`} key={stage.n}>
              <div className="society-progress-marker">{stage.done ? <CircleCheck size={14} /> : <span>{stage.n}</span>}</div>
              <div className="society-progress-copy"><strong>{stage.label}</strong><span>{stage.text}</span></div>
              {index < 3 && <ArrowRight className="society-progress-arrow" size={13} />}
            </div>
          ))}
        </div>
      </div>

      <div className="society-next">
        <div className="eyebrow">PROSSIMO SEGNALE</div>
        {society.markets.length === 0 && (society.businesses?.length ?? 0) === 0 ? (
          <>
            <Factory size={22} />
            <strong>Produzione o commercio</strong>
            <p>Il mondo non ha ancora raggiunto un ciclo economico osservabile. Cerca una struttura che inizi a vendere, produrre o assumere.</p>
          </>
        ) : society.trades.length === 0 ? (
          <>
            <ShoppingBag size={22} />
            <strong>Primo scambio</strong>
            <p>Esistono già capacità economiche, ma non sono ancora comparsi scambi recenti.</p>
          </>
        ) : society.jobs.length === 0 ? (
          <>
            <Users size={22} />
            <strong>Primo lavoro</strong>
            <p>Gli scambi sono iniziati: il passaggio successivo da osservare è la formazione di rapporti di lavoro e salari.</p>
          </>
        ) : (
          <>
            <TrendingUp size={22} />
            <strong>Effetti a cascata</strong>
            <p>Ora puoi seguire come prezzi, salari, ricavi e ricchezza iniziano a modificarsi a vicenda.</p>
          </>
        )}
      </div>
    </section>

    <div className="society-columns society-change-grid">
      <Panel title="Cambiamenti recenti" eyebrow="CRONOLOGIA DEL MONDO">
        <div className="society-event-list">
          {(society.events || []).filter(isSocietyEvent).sort((a, b) => new Date(b.simulationAt).getTime() - new Date(a.simulationAt).getTime()).slice(0, 10).map(event => (
            <article className="society-event" key={event.id}>
              <div className="society-event-time">{formatSimTime(event.simulationAt)}</div>
              <div className="society-event-dot" />
              <div className="society-event-body">
                <div className="society-event-top"><strong>{event.title}</strong><span>{societyEventLabel(event)}</span></div>
                <p>{societyEventDetail(event, world)}</p>
              </div>
            </article>
          ))}
          {!(society.events || []).some(isSocietyEvent) && (
            <EmptyState icon={<CircleDashed size={20} />} title="Nessun cambiamento sociale recente" text="Le azioni ordinarie continuano, ma non è ancora stato registrato un cambiamento sociale abbastanza rilevante da apparire qui." />
          )}
        </div>
      </Panel>

      <Panel title="Cosa sta cambiando davvero" eyebrow="LETTURA RAPIDA">
        <div className="society-read-grid">
          <div><span>Nuove idee</span><strong>{society.openEnded?.proposals?.length ?? 0}</strong><p>proposte registrate</p></div>
          <div><span>Invenzioni strutturali</span><strong>{macroDefinitions.length}</strong><p>strutture, istituzioni e sistemi</p></div>
          <div><span>Attività derivate</span><strong>{derivedActivities.length}</strong><p>nuove capacità utilizzabili</p></div>
          <div><span>Mercati</span><strong>{marketLocationCount}</strong><p>luoghi con prezzo</p></div>
          <div><span>Imprese</span><strong>{society.businesses?.filter(item => item.status === 'ACTIVE').length ?? 0}</strong><p>attive ora</p></div>
          <div><span>Lavoro</span><strong>{society.jobs.length}</strong><p>rapporti attivi</p></div>
          <div><span>Scambi</span><strong>{society.trades.length}</strong><p>registrati nel periodo</p></div>
        </div>
        <div className="society-observation">
          <span>Come interpretarlo</span>
          <p>{societyNarrative(society)}</p>
        </div>
      </Panel>
    </div>

    <div className="metric-grid society-metrics">
      <div className="metric-card"><div className="metric-icon"><Users size={18} /></div><div><span>Popolazione economica</span><strong>{metric?.populationCount ?? 0}</strong><small>persone con ricchezza tracciata</small></div></div>
      <div className="metric-card"><div className="metric-icon"><WalletCards size={18} /></div><div><span>Ricchezza totale</span><strong>{money(metric?.totalWealth ?? 0)}</strong><small>media {money(metric?.averageWealth ?? 0)}</small></div></div>
      <div className="metric-card"><div className="metric-icon"><Scale size={18} /></div><div><span>Disuguaglianza</span><strong>{pct(metric?.gini ?? 0)}</strong><small>coefficiente di Gini</small></div></div>
      <div className="metric-card"><div className="metric-icon"><Coins size={18} /></div><div><span>Prezzo food</span><strong>{money(metric?.averageFoodPrice ?? 1)}</strong><small>scambio nelle ultime 24h {money(metric?.totalTradeValue ?? 0)}</small></div></div>
    </div>

    <div className="society-columns">
      <Panel title="Sistemi emersi" eyebrow="MACRO STRUTTURE">
        <div className="society-card-list">
          {systems.length ? systems.map(system => <div className="society-row" key={system.id}>
            <div className="society-row-icon"><Landmark size={16} /></div>
            <div><strong>{system.name}</strong><span>{labelize(system.systemType)} · {labelize(system.stage)}</span></div>
            <StatusPill value={system.stage} />
          </div>) : <EmptyState icon={<Landmark size={20} />} title="Nessun sistema" text="Economia e governance emergeranno quando esisteranno abbastanza strutture persistenti." />}
        </div>
      </Panel>

      <Panel title="Mercati e prezzi" eyebrow="ECONOMIA LOCALE">
        <div className="market-list">
          {markets.length ? markets.map(market => <div className="market-row" key={market.locationId + market.goodCode}>
            <div><strong>{nameFor(market.locationId, world)}</strong><span>{labelize(market.goodCode)} · domanda {Number(market.demand).toFixed(0)} · offerta {Number(market.supply).toFixed(0)}</span></div>
            <strong>{money(market.price)}</strong>
          </div>) : <EmptyState icon={<ShoppingBag size={20} />} title="Nessun mercato" text="Un mercato nasce quando una pressione collettiva diventa un progetto sostenuto." />}
        </div>
      </Panel>
    </div>

    <div className="society-columns">
      <Panel title="Imprese e ciclo economico" eyebrow="DINAMICA ECONOMICA">
        <div className="society-card-list">
          <div className="society-row">
            <div className="society-row-icon"><Building2 size={16} /></div>
            <div><strong>{businessMetric?.activeBusinessCount ?? 0} imprese attive</strong><span>{businessMetric?.failedBusinessCount ?? 0} fallite · {businessMetric?.businessCount ?? 0} totali</span></div>
            <strong>{money(businessMetric?.profit ?? 0)}</strong>
          </div>
          <div className="society-row">
            <div className="society-row-icon"><Users size={16} /></div>
            <div><strong>{businessMetric?.employedCount ?? 0} occupati</strong><span>{businessMetric?.unemployedCount ?? 0} senza lavoro</span></div>
            <strong>{pct((businessMetric?.unemployedCount ?? 0) / Math.max(1, (businessMetric?.employedCount ?? 0) + (businessMetric?.unemployedCount ?? 0)))}</strong>
          </div>
          <div className="society-row">
            <div className="society-row-icon"><TrendingUp size={16} /></div>
            <div><strong>Produzione</strong><span>valore prodotto nel ciclo recente</span></div>
            <strong>{money(businessMetric?.productionValue ?? 0)}</strong>
          </div>
          <div className="society-row">
            <div className="society-row-icon"><Coins size={16} /></div>
            <div><strong>Ricavi</strong><span>input {money(businessMetric?.inputCost ?? 0)} · salari {money(businessMetric?.wageCost ?? 0)}</span></div>
            <strong>{money(businessMetric?.revenue ?? 0)}</strong>
          </div>
        </div>
      </Panel>

      <Panel title="Imprese" eyebrow="STATO">
        {society.businesses?.length ? <div className="society-card-list">{society.businesses.slice(0, 10).map(business => <div className="society-row" key={business.id}>
          <div className="society-row-icon"><Building2 size={16} /></div>
          <div><strong>{nameFor(business.entityId, world)}</strong><span>{labelize(business.status)} · capacità {Number(business.productionCapacity || 1).toFixed(2)}× · profitto {money(business.recentProfit)}</span></div>
          <strong>{business.status === 'FAILED' ? 'CHIUSA' : money(business.recentRevenue)}</strong>
        </div>)}</div> : <EmptyState icon={<Building2 size={20} />} title="Nessuna impresa" text="Le strutture economiche diventano imprese quando iniziano a produrre o commerciare." />}
      </Panel>
    </div>

    <div className="society-columns">
      <Panel title="Lavoro e salari" eyebrow="PRODUZIONE">
        {jobs.length ? <div className="society-card-list">{jobs.slice(0, 10).map(job => <div className="society-row" key={job.id}>
          <div className="society-row-icon"><Building2 size={16} /></div>
          <div><strong>{nameFor(job.employeeEntityId, world)}</strong><span>{labelize(job.role)} · datore {nameFor(job.employerEntityId, world)}</span></div>
          <strong>{money(job.wagePerHour)}/h</strong>
        </div>)}</div> : <EmptyState icon={<Building2 size={20} />} title="Nessun rapporto di lavoro" text="I lavori vengono creati sulle strutture emergenti e assegnati agli abitanti che ne condividono il progetto." />}
      </Panel>

      <Panel title="Ricchezza" eyebrow="DISTRIBUZIONE">
        {society.accounts.length ? <div className="wealth-list">{society.accounts.slice(0, 10).map((account, index) => <div className="wealth-row" key={account.entityId}>
          <span className="wealth-rank">#{index + 1}</span><div><strong>{nameFor(account.entityId, world)}</strong><span>entrate {money(account.lifetimeIncome)} · spese {money(account.lifetimeSpending)}</span></div><strong>{money(account.balance)}</strong>
        </div>)}</div> : <EmptyState icon={<WalletCards size={20} />} title="Nessuna ricchezza registrata" text="Gli abitanti ricevono un conto economico quando il motore socioeconomico viene inizializzato." />}
      </Panel>
    </div>

    <Panel title="Invenzioni sociali" eyebrow="OPEN-ENDED" right={<span className="tiny-muted">{macroDefinitions.length} invenzioni strutturali · {derivedActivities.length} attività · {openProposals.length} proposte</span>}>
      <div className="open-ended-grid">
        <div className="open-ended-list">
          {openProposals.length ? openProposals.slice(0, 8).map(proposal => <article className="open-ended-card" key={proposal.id}>
            <div className="open-ended-top"><Sparkles size={15} /><StatusPill value={proposal.status} /></div>
            <strong>{proposal.title}</strong>
            <span>{labelize(proposal.kind)} · {proposal.code}</span>
            <p>proposto da {nameFor(proposal.proposerEntityId, world)} · supporto {pct(proposal.supportScore)} · soglia {proposal.requiredSupport}</p>
          </article>) : <EmptyState icon={<Sparkles size={20} />} title="Nessuna nuova proposta" text="Quando un gruppo sperimenta una pressione comune, un abitante può generare una nuova struttura, istituzione, attività o sistema." />}
        </div>
        <div className="open-ended-list">
          {openDefinitions.length ? openDefinitions.slice(0, 8).map(definition => {
            const activities = Array.isArray(definition.definition?.activities) ? definition.definition.activities : []
            return <article className="open-ended-card active" key={definition.id}>
              <div className="open-ended-top"><Sparkles size={15} /><StatusPill value={definition.status} /></div>
              <strong>{definition.name}</strong>
              <span>{labelize(definition.kind)} · {labelize(definition.category)} · {definition.code}</span>
              <p>{activities.length} attività derivate · scope {definition.scopeLocationId ? definition.scopeLocationId.slice(0, 8) : 'globale'}</p>
            </article>
          }) : <EmptyState icon={<Sparkles size={20} />} title="Nessuna definizione attiva" text="Le proposte accettate diventano definizioni persistenti che il motore può rendere disponibili come capacità." />}
        </div>
      </div>
    </Panel>

    <Panel title="Politica e leggi" eyebrow="GOVERNANCE" right={<span className="tiny-muted">{enacted.length} leggi in vigore · {proposed.length} proposte</span>}>
      <div className="policy-grid">
        {[...enacted, ...proposed].slice(0, 8).map(policy => <article className="policy-card" key={policy.id}>
          <div className="policy-top"><Gavel size={15} /><StatusPill value={policy.status} /></div>
          <strong>{policy.title}</strong><p>{policy.statement}</p>
          <div className="policy-meter"><span>supporto</span><div><i style={{ width: Math.max(0, Math.min(1, Number(policy.supportScore || 0))) * 100 + '%' }} /></div><b>{pct(policy.supportScore)}</b></div>
          <small>proposta da {nameFor(policy.proposerEntityId, world)} · {labelize(policy.issueCode)}</small>
        </article>)}
      </div>
    </Panel>

    <div className="society-columns">
      <Panel title="Conflitti" eyebrow="PRESSIONI E CONTROPRESSIONI">
        {conflicts.length ? <div className="society-card-list">{conflicts.slice(0, 10).map(conflict => <div className="society-row" key={conflict.id}>
          <div className="society-row-icon conflict"><Handshake size={16} /></div>
          <div><strong>{labelize(conflict.conflictType)}</strong><span>{nameFor(conflict.leftId, world)} ↔ {nameFor(conflict.rightId, world)}</span></div>
          <strong>{pct(conflict.intensity)}</strong>
        </div>)}</div> : <EmptyState icon={<Handshake size={20} />} title="Nessun conflitto attivo" text="Quando strutture o interessi diventano incompatibili, il sistema crea un conflitto persistente." />}
      </Panel>

      <Panel title="Scambi recenti" eyebrow="FLUSSI ECONOMICI">
        {recentTrades.length ? <div className="society-card-list">{recentTrades.map(trade => <div className="society-row" key={trade.id}>
          <div className="society-row-icon"><Coins size={16} /></div>
          <div><strong>{nameFor(trade.buyerEntityId, world)} → {nameFor(trade.sellerEntityId, world)}</strong><span>{labelize(trade.goodCode)} · {Number(trade.quantity).toFixed(0)} unità · {formatSimTime(trade.simulationAt)}</span></div>
          <strong>{money(trade.total)}</strong>
        </div>)}</div> : <EmptyState icon={<Coins size={20} />} title="Nessuno scambio" text="Gli scambi compaiono quando gli abitanti iniziano a utilizzare le attività economiche emergenti." />}
      </Panel>
    </div>

    <Panel title="Come leggere questa pagina" eyebrow="MODELLO">
      <div className="society-model">
        <div><span>1</span><strong>Bisogno</strong><p>Più abitanti sperimentano una pressione compatibile.</p></div>
        <div><span>2</span><strong>Progetto</strong><p>Un agente formula una soluzione e recluta altri abitanti.</p></div>
        <div><span>3</span><strong>Struttura</strong><p>Il progetto modifica davvero il mondo e crea nuove capacità.</p></div>
        <div><span>4</span><strong>Sistema</strong><p>Ripetizione, scambi e conflitti fanno emergere economia e governance.</p></div>
      </div>
    </Panel>
  </div>
}
