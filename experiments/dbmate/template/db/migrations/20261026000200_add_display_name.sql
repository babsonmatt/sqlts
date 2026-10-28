-- migrate:up
ALTER TABLE public.users ADD COLUMN display_name text;

-- migrate:down
ALTER TABLE public.users DROP COLUMN display_name;
