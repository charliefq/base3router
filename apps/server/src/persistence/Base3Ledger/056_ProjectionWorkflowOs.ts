import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workflow_cursors (
      project_id TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_agent_profile_versions (
      project_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      profile_json TEXT NOT NULL,
      PRIMARY KEY (project_id, profile_id, version)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workflow_template_versions (
      project_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      template_json TEXT NOT NULL,
      PRIMARY KEY (project_id, template_id, version)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workflow_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workflow_runs_project_updated
    ON projection_workflow_runs(project_id, updated_at DESC)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workflow_stage_attempts (
      run_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      attempt_json TEXT NOT NULL,
      PRIMARY KEY (run_id, stage_id, attempt)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workflow_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      artifact_json TEXT NOT NULL,
      UNIQUE (run_id, stage_id, attempt)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workflow_decisions (
      decision_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      decision_json TEXT NOT NULL,
      UNIQUE (run_id, stage_id, attempt)
    )
  `;
});
