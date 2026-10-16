# OpenRouter text tasks

OpenRouter is an optional text transport. It uses the same task contracts,
execution grants, start limits and result history as the other providers.
It cannot run coding tools, use images, steer an active response, or perform
native conversation fork/rollback. Model capabilities that were not supplied
remain unknown.

In Settings > Providers, add an **OpenRouter (text)** instance. Enable the
instance and **Enable text execution**. Add the explicit model slugs you want
under Models. **OpenRouter Auto (remote model selection)** is supplied as a
separate choice using `openrouter/auto`. B3R's heuristic Auto does not select
OpenRouter; choose Manual and the OpenRouter instance/model for these tasks.
Teacher/Shadow guidance does not enable execution or supply its credentials.

When you are ready to authorize paid execution, use **Save API key (no probe)**
in this instance's sign-in flow. The key stays in this environment's secret
store and is not a provider setting. Saving a key does not make a model call
or verify the account. Without execution opt-in and a saved key there are no
executable models, and sending a task makes zero provider requests. Removing
the key or disabling execution removes those model choices.

For an owner-controlled trial, first set the account/key's spending limits in
OpenRouter and review the task's start, token and cost brakes. These actions
require your separate authorization. Then create a governed task, explicitly
select this provider and either a model slug or OpenRouter Auto, and send a
short text instruction. Inspect the streamed response, refresh Tasks and open
the conversation to read its persisted output. Tasks shows the requested model
and the provider-reported resolved model. Unreported identity, usage and cost
remain unknown. Provider completion does not mean owner acceptance.

OpenRouter Auto uses task classification and market spend rankings, with cost
bands and provider restrictions. It does not guarantee the best answer, and
its cost tier is not a spending ceiling. Task accounting observes reported
usage; it cannot guarantee a hard per-request dollar ceiling. See
[Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router) and
[provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

Follow-up text is reconstructed from persisted app history, including failed
or interrupted history as recorded; it does not resume a native OpenRouter
conversation. History over 100,000 characters or containing attachments is
rejected before dispatch. A response has a two-minute local transport limit.
Authentication, rate-limit, provider and malformed/interrupted-stream errors
are visible failures, with no automatic paid retry. Cancel aborts the local
HTTP connection; remote work and billing may remain unknown. Capacity stays
reserved when termination is unconfirmed. Do not replay an uncertain request
as though it had never started.

The development checks for this integration are **LOCAL/FIXTURE** HTTP/SSE and
disposable SQLite tests. They do not establish browser/LIVE operation, valid
credentials, available paid budget or real-provider quality.
