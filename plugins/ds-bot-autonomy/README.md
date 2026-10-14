# DS Bot Autonomy

`ds-bot-autonomy` adds bounded, persistent work items to DS Bot. It uses the public DSH Agent and Goal services for live work and the `ds_bot_autonomy` storage domain for business records. The small DS Bot host adapter exposes only current-part resolution, ownership, delivery receipts, and lifecycle hooks.

## Use it in Bot chat

Give the Bot a natural-language task and state its goal, completion conditions, and allowed scope.

- **Start ongoing work:** “Use an autonomous task to organize these materials. Completion condition: answer my three questions with sources; use only the files I provided and run for at most 20 rounds.”
- **Check progress:** “List my autonomous tasks and tell me which are running, what they are waiting for, and how many rounds remain.”
- **Stop or resume:** “Stop the autonomous task you just started.” / “Resume this task and continue toward the original goal.”
- **Set a recurring responsibility:** “At 9 a.m. each day, organize new content in the specified materials folder and save a summary to the workspace; use only that folder. First create the responsibility, then bind a scheduled trigger.”
- **Coordinate Bots:** “Ask the specified Bot to collect the materials, wait for its result, then integrate and verify it.”

Each task allows up to 20 rounds by default; you can set another limit when assigning it. A task waits when it needs your answer, and a stopped task requires an explicit resume. Incomplete work remains saved after restart and waits for you to resume it. Scheduled work requires DS Bot to be running and the host to stay awake.

## Use

The plugin registers these tools:

- `autonomy_submit_work` starts a task with an objective, acceptance conditions, target Bot, optional allowed scope, and a positive `maxGoalRounds` limit. The default is 20 rounds.
- `autonomy_list_work` and `autonomy_get_work` inspect saved tasks.
- `autonomy_stop_work` fences the task generation before disarming and cancelling its Agent.
- `autonomy_resume_work` resumes a stopped or waiting task from a direct user turn.
- `autonomy_manage_responsibilities` stores or updates an authorized recurring responsibility.
- `autonomy_manage_schedules` manages schedules attached to a responsibility when DSH Schedule is available.
- `autonomy_delegate_work` assigns a bounded subtask to a different Bot and waits for its matching result.

The same operations are available through `POST /api/bot` endpoints `autonomy-list`, `autonomy-get`, `autonomy-submit`, `autonomy-stop`, `autonomy-resume`, and `autonomy-responsibilities`. Mutating endpoint payloads include the current `sessionId`; create, stop, resume, and responsibility changes require a direct human message in that live Session's current turn. The plugin derives authorization and return addresses from the live Session log rather than accepting model-supplied source or authorization fields.

The injected `dsBotAutonomy` service exposes `submit`, `get`, `list`, `stop`, `resume`, responsibility and schedule operations, and `receiveDependency`. Mutating methods require the exact live Agent as their actor.

## Runtime behavior

On DS Bot 0.1.6, ordinary `/goal` commands remain blocked in Bot chats. The host exempts only the exact native Goal bound to this plugin's live task, Agent, Session, and Stop generation. Goal creation stays hidden; reads and updates of an owned Goal continue through the native tools and their authorization checks. Stop, unload, stale parts, and foreign Goals revoke the exemption.

With native Jobs available, DS Bot shell calls use `run_in_background: true` and job reads use `wait: false`. The process continues while the same Bot handles new human messages, and its native completion notice brings the result back. Foreground shell calls and blocking job reads are rejected before dispatch; native permissions and cancellation remain authoritative. Managed Goal continuation waits without consuming rounds and resumes only for the same active task generation. User Stop, job kill, teardown, and changed Goals do not resume it. This applies to new calls; an existing foreground call cannot be converted without cancelling it.

Each task owns one native Goal for one exact Agent and Session. A queued task waits while its Agent is busy, a foreign Goal is unfinished, or another task owns the Bot resource. The saved round limit is total across Session part moves. Every admitted native Goal round is persisted before the next step can pass the plugin's fence.

After reload, unfinished tasks remain waiting for an explicit resume. Ask-user cards block the task until the matching answer arrives. Final results use stable delivery IDs and native Session/inbox event readback. User results are appended to the original return chat without starting another model turn. Child results use the saved parent exchange; the parent resumes only for that matching completed child and must integrate the evidence before completing. Ambiguous receipts stay marked for reconciliation.

Scheduled messages are consumed only when their fixed reminder framing names a schedule bound to a saved, active responsibility. Unrecognized entries in a batch remain in the original message. The plugin does not poll Bots or invent recurring duties. Without DSH Schedule, manual work and responsibility records remain available while schedule operations report that the service is unavailable.

This source package and its isolated tests do not establish behavior of an installed DS Bot profile. Install and runtime acceptance must be performed against the intended DSH profile separately.
## Load the source package

Load DS Bot with the included `dsBotAutonomyHost` version 1 adapter, then resolve this package as a separate Cordis plugin (`ds-bot-autonomy`). The included `cordis.patch.yml` is a loader patch, not an installation performed by these tests. The plugin waits for `dsBotAutonomyHost`, `agents`, `goals`, `sessions`, `tools`, `storageDomain`, and `systemPrompt`. DS Bot does not import this package. Keep exactly one existing native `@deepseek-ai/dsh-goal-round-driver` in the profile; this package creates no round driver and does not modify native Goal tools. Native Goal create/edit/resume authorization remains unchanged.

Provide a native storage backend and route the storage-domain facility to it. The plugin opens `ds_bot_autonomy` version 1 with `responsibilities` and `work_items` tables. DSH Schedule is optional. No responsibility, task, schedule, connector subscription, or polling loop is installed automatically.

The public service uses the exact live Agent, rather than a tool execution wrapper:

```js
// From a host-attested direct human turn; tool wrappers supply exec.agent.
const item = await ctx.dsBotAutonomy.submit({
  botId: 'writer',
  objective: 'Prepare the requested report',
  acceptance: 'The report answers the original questions with source evidence',
  allowedScope: 'The approved source folder',
  maxGoalRounds: 20,
  resources: ['path:J:/approved-source', 'computer:shared'],
}, exactAgent)
const saved = await ctx.dsBotAutonomy.get(item.id)
```

Resource strings explicitly reserve requested shared resources; `path:` values are normalized. Bot and current Session claims are always included and survive part moves. These claims coordinate this plugin's work items; they are not a filesystem permission system. Saved responsibilities can carry the same resource list. Inspecting saved work does not require a currently running human turn. Mutation authorization is read from the exact Agent's current native turn events; model-supplied authorization and return addresses are ignored.

## Verified source behavior

The named isolated tests run against the public DSH 0.2.0-rc.2 packages available to the DS Bot source test bench. `test/native.test.js` loads real Cordis, the Agent loop, native Goal tools, the single native Goal round driver, the JSON storage domain, and the DS Bot host adapter with an offline model. It verifies two rounds and final text after Goal completion, matching question answers, child result integration, native user cancellation, active plugin unload/remount, remaining-budget transfer to a new native Session, and native schedule storage/binding moves with mixed occurrence deduplication. It also verifies that user delivery starts no extra model turn. Scheduler tests use isolated JSONL Session persistence.

`test/service.test.js` targets part budget preservation and rollback, busy/foreign Goal queueing, scoped Stop, requested resources, durable round-write failure, mixed schedule inputs, and the unmanaged legacy turn path.

Run these named checks from the source package, with the DS Bot source bench beside `plugins/` (or `DSH_HARNESS` pointing at its dependency runtime):

```powershell
node --import ./test/resolve-harness.mjs --test ./test/service.test.js ./test/native.test.js
```

No installed profile, live user data, live model, real UI interaction, packaging, release, deployment, or full repository test suite was used for this source verification.
