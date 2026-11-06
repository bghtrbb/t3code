import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE native_checkpoint_rewind (
      thread_id TEXT PRIMARY KEY,
      target_checkpoint_id TEXT NOT NULL,
      source_checkpoint_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('files_pending', 'provider_pending', 'provider_done')),
      provider_thread_json TEXT
    )
  `;
});
