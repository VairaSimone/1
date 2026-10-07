const test=require("node:test");
const assert=require("node:assert/strict");
const retention=require("../src/services/safe-retention-service");

test("retention backlog total includes plan-step result debt and all tracked categories",()=>{
  const summary={
    needHistoryBacklog:1,emotionHistoryBacklog:2,simulationTickBacklog:3,eventBacklog:4,
    actionBacklog:5,actionDecisionSummaryBacklog:6,planStepResultBacklog:7,memoryArchiveBacklog:8,
    memoryDedupeBacklog:9,memoryDeleteBacklog:10,relationshipHistoryBacklog:11,expectationBacklog:12,
    counterfactualBacklog:13,counterfactualWorldBacklog:14,decisionContextArchiveBacklog:15,
    intentionsDeleted:16,decisionOptionCandidates:17,traitHistoryCandidates:18,
    geminiDecisionTelemetryCandidates:19,decisions:20
  };
  assert.equal(retention.retentionBacklogTotalFromSummary(summary),210);
});
