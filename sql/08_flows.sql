-- 08_flows.sql — the Flow Studio: canvas-based user-flow documentation.
-- A flow is one canvas: nodes (message cards / decisions / triggers / notes)
-- + edges (who-gets-what-after-what), stored as one JSONB blob — the editor
-- owns the shape, the DB just persists and versions it.

CREATE TABLE IF NOT EXISTS flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',          -- audience/patient-type tags, free-form
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'draft', 'archived')),
  canvas JSONB NOT NULL DEFAULT '{"nodes": [], "edges": []}',
  is_template BOOLEAN NOT NULL DEFAULT false, -- seeded system flows (duplicate to customize)
  sort_order INT NOT NULL DEFAULT 100,
  updated_by TEXT,                            -- display name of last editor
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Manual save-points (the editor also keeps a client-side undo stack).
CREATE TABLE IF NOT EXISTS flow_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  label TEXT,
  canvas JSONB NOT NULL,
  saved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flow_snapshots_flow ON flow_snapshots (flow_id, created_at DESC);

ALTER TABLE flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_all ON flows;
CREATE POLICY admin_all ON flows FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
DROP POLICY IF EXISTS admin_all ON flow_snapshots;
CREATE POLICY admin_all ON flow_snapshots FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
