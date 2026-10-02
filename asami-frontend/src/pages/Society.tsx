
import { Building2, Coins, Gavel, Handshake, Landmark, Scale, ShoppingBag, Sparkles, TrendingUp, Users, WalletCards } from 'lucide-react'
import type { SocietySnapshot, WorldSnapshot } from '../types'
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

export function Society({ society, world }: { society: SocietySnapshot | null; world: WorldSnapshot | null }) {
  if (!society) return <EmptyState icon={<Landmark size={22} />} title="Società non ancora materializzata" text="Il motore deve attraversare alcune iterazioni del mondo prima che compaiano economia, istituzioni e strutture emergenti." />

  const metric = latestMetric(society)
  const systems = society.systems
  const markets = society.markets
  const jobs = society.jobs.filter(job => job.status === 'ACTIVE')
  const enacted = society.policies.filter(policy => policy.status === 'ENACTED')
  const proposed = society.policies.filter(policy => policy.status === 'PROPOSED')
  const conflicts = society.conflicts.filter(conflict => conflict.status === 'ACTIVE')
  const recentTrades = society.trades.slice(0, 8)
  const businessMetric = society.businessMetrics?.[0] ?? null
  const openProposals = society.openEnded?.proposals ?? []
  const openDefinitions = society.openEnded?.definitions ?? []

  return <div className="society-page">
    <div className="society-hero">
      <div>
        <div className="eyebrow">OSSERVATORIO · SOCIETÀ EMERGENTE</div>
        <h1>Società</h1>
        <p>Nessuna città, economia o legge è stata inserita manualmente: qui vedi le strutture che gli abitanti hanno prodotto attraverso bisogni, coordinamento e conflitti.</p>
      </div>
      <div className="society-hero-badge"><TrendingUp size={15} /><span>{metric ? formatSimTime(metric.simulationAt) : 'in formazione'}</span></div>
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

    <Panel title="Invenzioni sociali" eyebrow="OPEN-ENDED" right={<span className="tiny-muted">{openDefinitions.length} definizioni attive · {openProposals.length} proposte</span>}>
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
