export type SimulationStatus = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'INITIALIZING' | string

export interface Simulation { id: string; name: string; status: SimulationStatus; startedSimulationAt: string; currentSimulationAt: string; createdRealAt?: string; updatedRealAt?: string; version: number }
export interface Clock { simulationAnchorAt: string; realAnchorAt: string; speed: number }
export interface Entity { id: string; displayName: string; entityType: string; status: string; description?: string | null; attributes?: Record<string, unknown> | null; version: number }
export interface Need { code: string; name: string; value: number; priorityWeight: number }
export interface Emotion { code: string; name: string; intensity: number }
export interface Trait { code: string; name: string; value: number }
export interface Skill { code: string; name: string; proficiency: number | null; confidence: number | null }
export interface Location { locationId: string; locationType: string; latitude: number | null; longitude: number | null; addressData: Record<string, unknown> | null; sinceSimulationAt: string }
export interface Relationship { id: string; type: string; sourceEntityId: string; targetEntityId: string; trustScore: number; affectionScore: number; respectScore: number; familiarityScore: number; attractionScore: number; conflictScore: number; fearScore: number; admirationScore: number; jealousyScore: number; dependenceScore: number; closenessScore: number; irritationScore: number }
export interface Goal { id: string; title: string; description?: string | null; goalType: string; priority: number; status: string; progress: number; deadline?: string | null; motivation?: unknown; result?: unknown; version: number }
export interface Action { id: string; actionType: string; sourceType?: string; status: string; target?: unknown; parameters?: unknown; startedAt: string; completedAt?: string | null; result?: unknown }
export interface Dashboard { entity: Entity; needs: Need[]; emotions: Emotion[]; traits: Trait[]; skills: Skill[]; location: Location | null; relationships: Relationship[]; goals: Goal[]; currentAction: Action | null }
export interface Memory { id: string; memoryType?: string; content: string; importance: number; strength: number; confidence: number; emotionalIntensity: number; simulationAt: string; lastRecalledAt?: string | null; metadata?: unknown }
export interface TimelineItem { at: string; kind: 'EVENT' | 'ACTION' | string; id: string; type: string; summary: string; metadata?: unknown }
export interface EventItem { id: string; type: string; category: string; title: string; description?: string | null; simulationAt: string; importance: number; status: string; sourceActionId?: string | null; metadata?: unknown }
export interface Development { entityId?: string; developmentStageId?: string | null; physicalScore?: number; cognitiveScore?: number; socialScore?: number; emotionalScore?: number; educationScore?: number; updatedSimulationAt?: string; version?: number }
export interface DevelopmentHistoryItem extends Development { simulationAt?: string; reason?: string | null; oldStage?: string | null; newStage?: string | null; oldStageId?: string | null; newStageId?: string | null }
export interface ChatMessage { id: string; senderEntityId: string; messageType: 'USER' | 'ASSISTANT' | string; content: string; simulationAt: string; status: string; metadata?: unknown }
export interface ChatResponse { conversationId: string; userMessageId: string; assistantMessageId: string; reply: string; aiUsed: boolean }
export interface WsMessage { type: string; simulationId: string; occurredAt: string; payload: Record<string, unknown> }

export interface MindValue { id: string; code: string; label: string; importance: number; confidence: number; origin: string; salience: number; updatedAt: string }
export interface SelfBelief { id: string; beliefKey: string; statement: string; confidence: number; importance: number; sourceType: string; status: string; updatedAt: string }
export interface LongTermDesire { id: string; desireKey: string; title: string; description: string | null; desireType: string; priority: number; persistence: number; progress: number; status: string; origin: string; createdAt: string; updatedAt: string }
export interface NarrativeChapter { id: string; chapterIndex: number; title: string; summary: string; importance: number; createdAt: string; updatedAt: string }
export interface CognitiveState { attention: Array<Record<string, unknown>>; interpretation: Array<Record<string, unknown>>; conflicts: Array<Record<string, unknown>>; simulationTime: string | null }
export interface Expectation { id: string; decisionId: string; actionType: string; expectedUtility: number; expectedSuccessProbability: number; predictionError: number | null; regretScore: number | null; status: string; createdAt: string; resolvedAt: string | null }
export interface Counterfactual { id: string; decisionId: string; alternativeAction: string; predictedOutcome: unknown; predictedUtility: number; regretScore: number; createdAt: string }
export interface PromiseItem { id: string; title: string; description: string | null; targetEntityId: string | null; dueSimulationAt: string | null; status: string; importance: number; createdAt: string }
export interface SocialMind { memberships: Array<Record<string, unknown>>; reputations: Array<Record<string, unknown>>; obligations: Array<Record<string, unknown>>; norms: Array<Record<string, unknown>> }
export interface EmergentSnapshot { id: string; simulationTime: string; triggerType: string; selfView: string; capabilities?: Record<string, unknown>; limitations?: string[]; metrics?: Record<string, unknown> }
export interface BeliefEvidence { id: string; beliefKey: string; polarity: number; evidenceStrength: number; sourceType: string; statement?: string | null; createdAt: string; metadata?: Record<string, unknown> }
export interface MemoryConsolidation { id: string; consolidationKey: string; sourceCount: number; sourceFrom: string | null; sourceTo: string | null; summary: string; confidence: number; createdAt: string }
export interface CounterfactualWorld { id: string; decisionId: string; worldKey: string; selected: number; predictedState?: Record<string, unknown>; predictedUtility: number; actualOutcome?: string | null; regretScore: number; status: string; createdAt: string; resolvedAt?: string | null }
export interface SocialGroup { id: string; name: string; groupType: string; status: string; role?: string | null; joinedAt: string }
export interface EmergentMind { evolution: EmergentSnapshot[]; evidence: BeliefEvidence[]; consolidations: MemoryConsolidation[]; worlds: CounterfactualWorld[]; groups: SocialGroup[] }
export interface MindData {
  self: { id: string; identitySummary: string; selfConcept: string; capabilities: unknown; aspirations: unknown; limitations: unknown; currentSelfView: string | null; version: number; updatedAt: string } | null
  values: MindValue[]
  beliefs: SelfBelief[]
  desires: LongTermDesire[]
  narrative: NarrativeChapter[]
  state: CognitiveState
  expectations: Expectation[]
  counterfactuals: Counterfactual[]
  promises: PromiseItem[]
  social: SocialMind
  emergent: EmergentMind
}

export type AnalysisRangePreset = '1h' | '6h' | '24h' | '7d' | 'all' | 'custom'
export interface AnalysisPattern { id: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; detail: string; count: number; evidence?: Record<string, unknown> | null }
export interface AnalysisData {
  range: { from: string; to: string }
  kpis: { ticks: { total: number; completed: number; failed: number; skipped: number; completionRate: number }; actions: { total: number; completed: number; successful: number; failed: number; problematic: number; unsettled: number; successRate: number; technicalCompletionRate: number; avgDurationSeconds: number | null; suspiciousDuration: number }; events: { total: number; important: number; avgImportance: number; maxImportance: number }; decisions: { total: number; executed: number; successful: number; failed: number; problematic: number; outcomeCoverage: number; adaptationRate: number; learningSignals: number }; memories: { total: number; failures: number }; integrity: { temporal: number } }
  series: { at: string; events: number; actions: number; failedTicks: number }[]
  highlights: { at: string; kind: 'EVENT' | 'ACTION' | string; id: string; title: string; description: string; severity: 'INFO' | 'WARNING' | 'CRITICAL' }[]
  anomalies: AnalysisPattern[]
  patterns: AnalysisPattern[]
  breakdowns: { actions: { label: string; value: number }[]; events: { label: string; value: number }[]; decisions: { label: string; value: number }[] }
}
