CREATE TABLE tasks (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       varchar(120) NOT NULL CHECK (length(btrim(title)) > 0),
  description text         NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  status      text         NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'in_progress', 'done')),
  priority    text         NOT NULL DEFAULT 'medium'
              CHECK (priority IN ('low', 'medium', 'high')),
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX tasks_status_idx ON tasks (status);
