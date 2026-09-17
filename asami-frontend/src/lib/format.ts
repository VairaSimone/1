const ASAMI_LOCALE = 'it-IT'
export const ASAMI_TIME_ZONE = 'Europe/Rome'

const ITALIAN_LABELS: Record<string, string> = {
  RUNNING: 'In esecuzione',
  PAUSED: 'In pausa',
  STOPPED: 'Fermata',
  INITIALIZING: 'In inizializzazione',
  ACTIVE: 'Attivo',
  INACTIVE: 'Inattivo',
  COMPLETED: 'Completato',
  DELIVERED: 'Consegnato',
  SENT: 'Inviato',
  FAILED: 'Fallito',
  SKIPPED: 'Saltato',
  OPEN: 'Aperto',
  CLOSED: 'Chiuso',
  PENDING: 'In attesa',
  PROCESSING: 'In elaborazione',
  CANCELLED: 'Annullato',
  CANCELED: 'Annullato',
  SUCCESS: 'Riuscito',
  SUCCESSFUL: 'Riuscito',
  PROBLEMATIC: 'Problematico',
  UNSETTLED: 'Non definito',
  INFO: 'Informazione',
  WARNING: 'Avviso',
  CRITICAL: 'Critico',
  EVENT: 'Evento',
  ACTION: 'Azione',
  USER: 'Utente',
  ASSISTANT: 'Asami',
  SELF: 'Sé',
  PERSON: 'Persona',
  MEMBER: 'Membro',
  PROMISE: 'Promessa',
  OBLIGATION: 'Obbligo',
  SIGNAL: 'Segnale',
  INTERPRETATION: 'Interpretazione',
  DRIVER: 'Motivazione',
  CHAPTER: 'Capitolo',
  EXPERIENCE: 'Esperienza',
  WORLD: 'Mondo',
  ACTIONS: 'Azioni',
  EVENTS: 'Eventi',
  DECISIONS: 'Decisioni',
  MEMORIES: 'Memorie',
  NEED: 'Bisogno',
  NEEDS: 'Bisogni',
  EMOTION: 'Emozione',
  EMOTIONS: 'Emozioni',
  TRAIT: 'Tratto',
  TRAITS: 'Tratti',
  SKILL: 'Abilità',
  SKILLS: 'Abilità',
  GOAL: 'Obiettivo',
  GOALS: 'Obiettivi',
  DESIRE: 'Desiderio',
  DESIRES: 'Desideri',
  BELIEF: 'Convinzione',
  BELIEFS: 'Convinzioni',
  VALUE: 'Valore',
  VALUES: 'Valori',
  ATTENTION: 'Attenzione',
  CONFLICT: 'Conflitto',
  EXPECTATION: 'Aspettativa',
  EXPECTATIONS: 'Aspettative',
  COUNTERFACTUAL: 'Controfattuale',
  COUNTERFACTUALS: 'Controfattuali',
  IDENTITY: 'Identità',
  SOCIAL: 'Sociale',
  COGNITIVE: 'Cognitivo',
  COGNITION: 'Cognizione',
  PHYSICAL: 'Fisico',
  EMOTIONAL: 'Emotivo',
  EDUCATION: 'Istruzione',
  PERSONALITY: 'Personalità',
  DEVELOPMENT: 'Sviluppo',
  GROUP: 'Gruppo',
  REPUTATION: 'Reputazione',
  OBLIGATIONS: 'Obblighi',
  TRUST: 'Fiducia',
  AFFECTION: 'Affetto',
  RESPECT: 'Rispetto',
  FAMILIARITY: 'Familiarità',
  ATTRACTION: 'Attrazione',
  FEAR: 'Paura',
  ADMIRATION: 'Ammirazione',
  JEALOUSY: 'Gelosia',
  DEPENDENCE: 'Dipendenza',
  CLOSENESS: 'Vicinanza',
  IRRITATION: 'Irritazione',
  FRIEND: 'Amico',
  FRIENDSHIP: 'Amicizia',
  FAMILY: 'Famiglia',
  SIBLING: 'Fratello/Sorella',
  PARENT: 'Genitore',
  CHILD: 'Figlio',
  PARTNER: 'Partner',
  STRANGER: 'Estraneo',
  COLLEAGUE: 'Collega',
  ACQUAINTANCE: 'Conoscente',
  HUNGER: 'Fame',
  THIRST: 'Sete',
  SLEEP: 'Sonno',
  ENERGY: 'Energia',
  BOREDOM: 'Noia',
  LONELINESS: 'Solitudine',
  SAFETY: 'Sicurezza',
  CURIOSITY: 'Curiosità',
  SOCIAL_NEED: 'Bisogno sociale',
  COMFORT: 'Comfort',
  JOY: 'Gioia',
  SADNESS: 'Tristezza',
  ANGER: 'Rabbia',
  DISGUST: 'Disgusto',
  SURPRISE: 'Sorpresa',
  CALM: 'Calma',
  ANXIETY: 'Ansia',
  REST: 'Riposo',
  WALK: 'Camminata',
  WALKING: 'Camminata',
  MOVE: 'Movimento',
  MOVEMENT: 'Movimento',
  EXPLORE: 'Esplorazione',
  EXPLORING: 'Esplorazione',
  OBSERVE: 'Osservazione',
  EAT: 'Mangiare',
  DRINK: 'Bere',
  WORK: 'Lavorare',
  STUDY: 'Studiare',
  LEARN: 'Imparare',
  PLAY: 'Giocare',
  TALK: 'Parlare',
  INTERACT: 'Interagire',
  WAIT: 'Aspettare',
  SEEK_FOOD: 'Cercare cibo',
  SEEK_WATER: 'Cercare acqua',
  FIND_FOOD: 'Trovare cibo',
  FIND_WATER: 'Trovare acqua',
  SATISFY_NEED: 'Soddisfare un bisogno',
  RESTORE_ENERGY: 'Recuperare energia',
  RECALL: 'Ricordare',
  REMEMBER: 'Ricordare',
  THINK: 'Pensare',
  DECIDE: 'Decidere',
  COMMUNICATE: 'Comunicare',
  DIRECT_COMMUNICATION: 'Comunicazione diretta',
  REPUTATIONS: 'Reputazioni',
  MIND: 'Mente',
  MEMORY: 'Memoria',
  LIFE_STORY: 'Storia di vita',
  SELF_MODEL: 'Modello del sé',
  CURRENT_SELF_VIEW: 'Percezione attuale di sé',
  SELF_CONCEPT: 'Concetto di sé',
  INTERNAL_STATE: 'Stato interno',
  WORLD_STATE: 'Stato del mondo',
  WHAT_MATTERS: 'Ciò che conta',
  WHAT_I_WANT: 'Ciò che voglio',
  PREDICTION_ERROR: 'Errore di previsione',
  COMPETING_MOTIVES: 'Motivazioni in conflitto',
  BRANCHED_FUTURES: 'Futuri alternativi',
  BELIEF_REVISION: 'Revisione delle convinzioni',
  EPISODIC: 'Episodico',
  SEMANTIC: 'Semantico',
  MEMBER_ROLE: 'Ruolo del membro',
  TIME: 'Tempo',
  CUSTOM: 'Personalizzato',
}

export function formatDate(value?: string | Date | null, options?: Intl.DateTimeFormatOptions) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(ASAMI_LOCALE, {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    ...options,
    timeZone: ASAMI_TIME_ZONE,
  }).format(date)
}

export function formatSimTime(value?: string | Date | null) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(ASAMI_LOCALE, {
    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: ASAMI_TIME_ZONE,
  }).format(date)
}

export function labelize(value: string) {
  const raw = String(value ?? '').trim()
  if (!raw) return '—'
  const key = raw.toUpperCase().replace(/[\s-]+/g, '_')
  if (ITALIAN_LABELS[key]) return ITALIAN_LABELS[key]
  return raw.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function pct(value?: number | null) {
  return `${Math.round(Math.max(0, Math.min(1, Number(value ?? 0))) * 100)}%`
}

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number(value) || 0))
}

export function formatValue(value: unknown) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'boolean') return value ? 'Sì' : 'No'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  try { return JSON.stringify(value) } catch { return String(value) }
}
