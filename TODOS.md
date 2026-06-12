# TODOs

## Poll loop: cap consecutive 503s independently of Max Wait

**What:** Add a max-consecutive-503 ceiling to `pollForResultLoop` (`nodes/Pipelex/Pipelex.node.ts`) that breaks to the graceful still-running output after N straight 503 responses, distinct from the total `maxWaitSeconds` budget.

**Why:** `mapResultResponse` treats 503 as "still running" (a transient gateway/Temporal blip must not lose a poller). With `maxWaitSeconds: 0` (unbounded — the documented self-hosted setting), a backend that is genuinely down and returns 503 forever makes the node poll until the n8n execution itself times out. Cloud users are safe (300s default cap); this is bounded to self-hosted with the unbounded setting.

**Pros:** Turns a silent spin into a bounded, actionable outcome (return the `pipeline_run_id` + a "backend unhealthy, fetch later" message). Cheap, pure-loop change.

**Cons:** Adds a second knob/heuristic to the poll loop; risk of cutting off a backend that is slow-but-recovering if N is too low. Pick N generously (e.g. 10 consecutive) and honor `Retry-After` between them.

**Context:** Surfaced in the 2026-06-12 eng review (Finding 2). The loop lives at `Pipelex.node.ts` `pollForResultLoop`; 503→running mapping is `GenericFunctions.ts` `mapResultResponse`. The graceful-degrade payload helper (`runStillRunning`) already exists and is the natural return on tripping the ceiling. Add a unit test mirroring the existing "treats a 503 mid-poll as still running" cases but asserting the ceiling trips.

**Depends on / blocked by:** Nothing. Independent of the `runs:execute` / prod-deploy publish gates.
