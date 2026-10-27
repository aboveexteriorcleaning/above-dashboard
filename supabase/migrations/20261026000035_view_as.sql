-- Owners can open a crew member's "My stats" page and see exactly what that
-- person sees. The web app sends an x-view-as header (an employee id) on those
-- requests only. It is honoured only when the signed-in person is an owner;
-- for anyone else it is ignored and they keep getting their own numbers.
create or replace function app.my_employee_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid;
  h  text;
begin
  select e.id into me from public.employees e where e.auth_user_id = auth.uid() and e.active;
  begin
    h := nullif(current_setting('request.headers', true), '')::json ->> 'x-view-as';
  exception when others then h := null;
  end;
  if h is not null and app.is_owner() then
    if h !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
    return (select e.id from public.employees e where e.id = h::uuid);   -- unknown id -> null -> "not authorised"
  end if;
  return me;
end $$;
grant execute on function app.my_employee_id() to authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'app') and p.prokind = 'f'
             and not coalesce('jit=off' = any(p.proconfig), false)
  loop
    execute format('alter function %s set jit = off', f.sig);
  end loop;
end $$;
