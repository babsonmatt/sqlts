-- migrate:up
CREATE TABLE public.users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL
);

-- migrate:down
DROP TABLE public.users;
