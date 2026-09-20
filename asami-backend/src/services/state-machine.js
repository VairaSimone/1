const TRANSITIONS = Object.freeze({
  action: {
    CREATED:new Set(["ACTIVE","FAILED","CANCELLED"]),
    ACTIVE:new Set(["COMPLETED","FAILED","CANCELLED","INTERRUPTED"]),
    COMPLETED:new Set([]),FAILED:new Set([]),CANCELLED:new Set([]),INTERRUPTED:new Set([])
  },
  decision: {
    CREATED:new Set(["EVALUATED","FAILED","CANCELLED"]),
    EVALUATED:new Set(["EXECUTED","FAILED","CANCELLED"]),
    EXECUTED:new Set([]),FAILED:new Set([]),CANCELLED:new Set([])
  },
  goal: {
    DRAFT:new Set(["ACTIVE","PAUSED","BLOCKED","CANCELLED","ABANDONED"]),
    ACTIVE:new Set(["PAUSED","COMPLETED","FAILED","CANCELLED","ABANDONED","BLOCKED"]),
    PAUSED:new Set(["ACTIVE","CANCELLED","ABANDONED","BLOCKED"]),
    BLOCKED:new Set(["ACTIVE","CANCELLED","ABANDONED"]),
    COMPLETED:new Set([]),FAILED:new Set([]),CANCELLED:new Set([]),ABANDONED:new Set([])
  },
  plan: {
    DRAFT:new Set(["ACTIVE","PAUSED","BLOCKED","CANCELLED","FAILED"]),
    ACTIVE:new Set(["PAUSED","COMPLETED","FAILED","CANCELLED","BLOCKED"]),
    PAUSED:new Set(["ACTIVE","BLOCKED","CANCELLED","FAILED"]),
    BLOCKED:new Set(["ACTIVE","CANCELLED","FAILED"]),
    COMPLETED:new Set([]),FAILED:new Set([]),CANCELLED:new Set([])
  },
  plan_step: {
    PENDING:new Set(["ACTIVE","SKIPPED","FAILED","CANCELLED","BLOCKED"]),
    ACTIVE:new Set(["COMPLETED","SKIPPED","FAILED","CANCELLED","BLOCKED"]),
    BLOCKED:new Set(["PENDING","ACTIVE","CANCELLED","FAILED"]),
    COMPLETED:new Set([]),SKIPPED:new Set([]),FAILED:new Set([]),CANCELLED:new Set([])
  },
  tick: {
    RUNNING:new Set(["COMPLETED","FAILED","SKIPPED"]),
    COMPLETED:new Set([]),FAILED:new Set([]),SKIPPED:new Set([])
  }
});

function normalize(value){return String(value||"").trim().toUpperCase();}

function canTransition(kind,from,to){
  const type=TRANSITIONS[kind];
  if(!type)return false;
  const source=normalize(from),target=normalize(to);
  if(source===target)return true;
  return Boolean(type[source]?.has(target));
}

function assertTransition(kind,from,to){
  if(!canTransition(kind,from,to)){
    throw Object.assign(
      new Error(`Invalid ${kind} transition: ${normalize(from)} -> ${normalize(to)}`),
      {code:"INVALID_STATE_TRANSITION",stateKind:kind,from:normalize(from),to:normalize(to)}
    );
  }
  return true;
}

module.exports={TRANSITIONS,canTransition,assertTransition};
