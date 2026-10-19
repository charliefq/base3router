# Supervised workflows

Start a workflow from Governance to create its stage history. This does not start a model.
For an agent stage, preview the packet, choose an exact provider instance and model, and enter
Goal, Redirect, Acceptance and Brake. Review the stage, then explicitly start it. Changing the
model, instructions or workflow context requires a fresh review. Each stage permits one provider
start with the reviewed token limit and deadline.

After the conversation settles, inspect its output. The artifact shows its source, outcome,
sections, missing information as Unknown, and recorded redactions. Failed, cancelled or interrupted
output can be rejected or revised; it cannot be approved as completed work. Approving Discovery
opens the human Build Gate. Approving that gate leaves Architecture pending until another
reviewed Start. A revision also creates a pending attempt and retains the earlier history.

If a response is lost, use **Reconcile original dispatch**. It checks the original receipts and
may restore the workflow's recorded binding. It never starts or resends work. An unproven outcome
stays UNKNOWN. Reloading or resetting a preview does not authorize another dispatch.

Pausing or cancelling the workflow changes its ledger only. To interrupt a running model, open
the linked stage conversation and use its Stop control.
