import { useNavigate, useSearch } from "@tanstack/react-router";
import { AgentsPage, TasksPage } from "./CollaborationPages";
import { validateCollaborationScope, type CollaborationPage } from "./collaborationScope";
export function CollaborationRoutePage({ page }: { page: CollaborationPage }) {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const Component = page === "agents" ? AgentsPage : TasksPage;
  return (
    <Component
      scope={validateCollaborationScope(search)}
      onScopeChange={(next) => {
        void navigate({
          to: page === "agents" ? "/agents" : "/tasks",
          search: () => next,
          replace: true,
        });
      }}
    />
  );
}
