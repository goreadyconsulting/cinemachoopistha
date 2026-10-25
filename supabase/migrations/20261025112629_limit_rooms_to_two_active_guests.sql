
-- Active guest seats: at most two per room, reclaimed after 90s without a heartbeat.
alter table public.watch_members
  add column last_seen_at timestamptz not null default now();

create index watch_members_active_idx on public.watch_members(room_id, last_seen_at desc);

create or replace function private.is_watch_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.watch_members m
    where m.room_id = p_room_id
      and m.user_id = (select auth.uid())
      and m.last_seen_at > now() - interval '90 seconds'
  );
$$;

create or replace function public.join_watch_room(p_code text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_room uuid;
  v_others integer;
begin
  if v_user is null then raise exception 'Please enter as a guest first'; end if;
  -- A row lock serializes simultaneous joins, preventing overbooking.
  select r.id into v_room from public.watch_rooms r
  where r.invite_code = upper(trim(coalesce(p_code,'')))
  for update;
  if v_room is null then raise exception 'No room found for that invite code'; end if;

  select count(*) into v_others from public.watch_members m
  where m.room_id = v_room and m.user_id <> v_user
    and m.last_seen_at > now() - interval '90 seconds';

  if v_others >= 2 then
    raise exception 'This room is full (maximum 2 guests). Try again after someone leaves';
  end if;
  insert into public.watch_members(room_id, user_id, last_seen_at)
  values (v_room, v_user, clock_timestamp())
  on conflict (room_id,user_id) do update set last_seen_at=excluded.last_seen_at;
  return v_room;
end;
$$;

create function public.keep_watch_seat(p_room_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_updated integer;
begin
  if v_user is null then return false; end if;
  update public.watch_members m
     set last_seen_at=clock_timestamp()
   where m.room_id=p_room_id and m.user_id=v_user
     and m.last_seen_at > now() - interval '90 seconds';
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create function public.leave_watch_room(p_room_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then return; end if;
  delete from public.watch_members
   where room_id=p_room_id and user_id=(select auth.uid());
end;
$$;

revoke all on function public.keep_watch_seat(uuid) from public, anon;
revoke all on function public.leave_watch_room(uuid) from public, anon;
grant execute on function public.keep_watch_seat(uuid) to authenticated;
grant execute on function public.leave_watch_room(uuid) to authenticated;
