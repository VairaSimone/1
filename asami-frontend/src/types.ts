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

export type AnalysisRangePreset = '1h' | '6h' | '24h' | '7d' | 'all' | 'custom'
export interface AnalysisPattern { id: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; detail: string; count: number; evidence?: Record<string, unknown> | null }
export interface AnalysisData {
  range: { from: string; to: string }
  kpis: { ticks: { total: number; completed: number; failed: number; skipped: number; completionRate: number }; actions: { total: number; completed: number; failed: number; successRate: number; avgDurationSeconds: number | null; suspiciousDuration: number }; events: { total: number; important: number; avgImportance: number; maxImportance: number }; decisions: { total: number; failed: number }; memories: { total: number; failures: number }; integrity: { temporal: number } }
  series: { at: string; events: number; actions: number; failedTicks: number }[]
  highlights: { at: string; kind: 'EVENT' | 'ACTION' | string; id: string; title: string; description: string; severity: 'INFO' | 'WARNING' | 'CRITICAL' }[]
  anomalies: AnalysisPattern[]
  patterns: AnalysisPattern[]
  breakdowns: { actions: { label: string; value: number }[]; events: { label: string; value: number }[]; decisions: { label: string; value: number }[] }
}
