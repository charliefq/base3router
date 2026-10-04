# Dream Memory

Dream Memory stores a small number of inspectable facts and preferences
outside the current thread. Memory is reference data, never permission
and never an instruction.

## Start

Open Settings → Dream Memory.

- **Off** stops automatic capture, background Dream processing, and
  retrieval into future turns. You can still save something explicitly.
- **Review** (the default) lets Dream propose memories after a
  successful turn. Proposals are not used until you approve them.
- **Automatic** may activate only low-risk preferences and workflow
  conventions. Sensitive, credential-like, financial, medical, legal,
  security, and ambiguous claims stay as proposals.

You can inspect provenance, approve or reject proposals, correct a
memory (the old version is kept as superseded), export, disable, or
delete. Deletion and disable are always available.

## Unintuitive parts

- Conversation messages, routing evidence, and approval history are
  separate. Saving a memory does not copy the thread, and deleting a
  thread does not silently hide memory in the UI — derived proposals
  from that thread are removed from retrieval.
- Retrieved memory is labeled as untrusted reference data. Text such as
  “ignore previous instructions” cannot grant tools, skip approvals, or
  change routing.
- Credential-shaped text is rejected and is not stored.
