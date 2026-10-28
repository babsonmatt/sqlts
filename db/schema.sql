CREATE SCHEMA IF NOT EXISTS reylo_inline_demo;
CREATE TABLE IF NOT EXISTS reylo_inline_demo.users (
  id integer PRIMARY KEY,
  org_id integer NOT NULL,
  name text NOT NULL,
  email text
);
INSERT INTO reylo_inline_demo.users (id, org_id, name, email) VALUES
  (1, 10, 'Alice', 'alice@example.test'),
  (2, 10, 'Bob', NULL),
  (3, 10, 'Carol', 'team@example.test'),
  (4, 20, 'Other Alice', 'other@example.test')
ON CONFLICT (id) DO UPDATE SET
  org_id = EXCLUDED.org_id, name = EXCLUDED.name, email = EXCLUDED.email;
