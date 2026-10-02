# Emergent world

Asami now has an open-ended emergent-world layer. The base simulation remains deterministic, but inhabitants can propose new social concepts rather than selecting from a fixed project taxonomy.

## Causal loop

\`NEED STATE -> SHARED PRESSURE -> AGENT PROPOSAL -> DETERMINISTIC VALIDATION -> SOCIAL SUPPORT -> MATERIALIZATION -> NEW CAPABILITY -> ACTION -> PERSISTENT CONSEQUENCE\`

Gemini is used as a bounded generative design layer when available. It proposes data; it never receives direct authority to mutate MySQL or execute simulation code.

## Open-ended proposal model

An inhabitant can propose one of four data-defined kinds:

- \`STRUCTURE\`: a new physical/social place with its own activity set.
- \`INSTITUTION\`: a durable social arrangement or organization.
- \`ACTIVITY\`: a new locally available behavior.
- \`SYSTEM\`: a new recurring coordination system.

These are not semantic enums with fixed meanings. The agent supplies the code, name, purpose, activities, need weights, membership model and safe effects.

## Deterministic safety boundary

Every generated definition is normalized and validated before persistence.

The validator enforces:

- bounded identifiers and text;
- bounded activity count and activity duration;
- only \`NEED_DELTA\`, \`RESOURCE_DELTA\` and \`INVENTORY_DELTA\` effects;
- valid needs and existing goods only;
- no positive \`RESOURCE_DELTA\` resource creation;
- positive inventory requires an explicit input effect;
- declared resource costs must be backed by executable consumption effects and by resources currently available at the scope location;
- physical/social kinds require a valid local scope and a minimum support base;
- duplicate definition and activity codes are rejected.

The runtime repeats the same principle: an emergent activity can only mutate state through the small validated effect vocabulary. Dynamic effects run inside the action transaction with a savepoint, so a failed effect sequence does not leave partial mutations behind.

## Social selection

The simulation computes shared pressure from the active need catalogue itself. Need direction is inferred from each need's configured default value, so the emergence layer is not tied to fixed concepts such as hunger or belonging.

A proposer is selected deterministically from the people experiencing the pressure. Gemini receives only compact local state, then returns one candidate definition. A deterministic support model estimates which nearby inhabitants would adopt it. A feasible proposal without sufficient support is stored as rejected and does not alter the world.

## Persistence

Open-ended concepts are stored in:

- \`emergent_world_proposals\`
- \`emergent_definition_catalog\`
- \`emergent_system_members\`

Materialized structures and systems still use:

- \`emergent_structures\`
- \`emergent_systems\`
- \`emergent_projects\` (compatibility record for the existing world schema)

The normal world and action pipelines consume the generated activity definitions through \`world_capabilities\`, so a new activity can become a real candidate in autonomous decision making without adding a new JavaScript action enum.

## API

\`GET /api/simulations/:simulationId/emergence\`

now includes:

- legacy/emergent projects, structures, systems, policies and conflicts;
- \`openEnded.proposals\`;
- \`openEnded.definitions\`.

## What is intentionally still fixed

Core biological and locomotion primitives remain code-defined because they are simulation infrastructure rather than social inventions: sleeping, eating, drinking, movement, basic communication and their state transitions still have dedicated deterministic semantics.

The social grammar itself is no longer restricted to \`LOCAL_MARKET\`, \`COMMUNITY_HUB\` or \`WORKSHOP_COOPERATIVE\`.