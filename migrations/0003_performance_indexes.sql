CREATE INDEX IF NOT EXISTS idx_memo_status_pinned_created
  ON memo(row_status, pinned, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_memo_creator_status_pinned_created
  ON memo(creator_id, row_status, pinned, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_memo_visibility_status_created
  ON memo(visibility, row_status, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_attachment_creator_created
  ON attachment(creator_id, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_attachment_memo_id
  ON attachment(memo_id);

CREATE INDEX IF NOT EXISTS idx_memo_relation_memo_type
  ON memo_relation(memo_id, type);

CREATE INDEX IF NOT EXISTS idx_memo_relation_related_type
  ON memo_relation(related_memo_id, type);

CREATE INDEX IF NOT EXISTS idx_reaction_content_created
  ON reaction(content_id, created_ts ASC);

CREATE INDEX IF NOT EXISTS idx_inbox_receiver_status_created
  ON inbox(receiver_id, status, created_ts DESC);
