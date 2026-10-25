
-- Cinema Choopistha 2.0: one persistent, private two-person screening room.
create table public.cinema_home (
  singleton smallint primary key default 1 check (singleton = 1),
  room_id uuid not null unique references public.watch_rooms(id) on delete restrict
);
alter table public.cinema_home enable row level security;
revoke all on public.cinema_home from public, anon, authenticated;

-- Preserve the existing watch session and timestamp; do not create a new room.
insert into public.cinema_home(singleton,room_id)
select 1,r.id from public.watch_rooms r
order by case when r.name='Our Movie Night' then 0 else 1 end, r.created_at desc
limit 1 on conflict(singleton) do nothing;

create function public.get_cinema_status()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare v_room uuid; v_persona text; v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Choose a profile first';
  end if;
  select persona into v_persona from public.watch_aliases where user_id=(select auth.uid());
  if v_persona is null then raise exception 'Choose Kittu or Subbu first'; end if;
  select room_id into v_room from public.cinema_home where singleton=1;
  if v_room is null then raise exception 'Cinema not configured'; end if;
  select jsonb_build_object(
    'room_id',r.id,
    'library_path',r.library_path,
    'position_seconds',r.position_seconds,
    'is_playing',r.is_playing,
    'playback_updated_at',r.playback_updated_at,
    'active',coalesce((
       select jsonb_agg(m.persona order by m.persona)
       from public.watch_members m
       where m.room_id=r.id and m.last_seen_at>now()-interval '90 seconds'
     ),'[]'::jsonb)
  ) into v_result from public.watch_rooms r where r.id=v_room;
  return v_result;
end;
$$;
revoke all on function public.get_cinema_status() from public,anon;
grant execute on function public.get_cinema_status() to authenticated;

create function public.enter_shared_cinema()
returns uuid language plpgsql security definer set search_path=''
as $$
declare v_uid uuid:=auth.uid(); v_persona text; v_room uuid;
 v_same integer; v_others integer; v_last_seen timestamptz;
begin
  if v_uid is null then raise exception 'Choose a profile first'; end if;
  select persona into v_persona from public.watch_aliases where user_id=v_uid;
  if v_persona not in ('Kittu','Subbu') or v_persona is null
  then raise exception 'Only Kittu and Subbu may enter'; end if;

  -- The singleton row lock serializes overlapping first/second entrance attempts.
  select room_id into v_room from public.cinema_home where singleton=1 for update;
  if v_room is null then raise exception 'Cinema is not configured'; end if;

  select count(*) into v_same
  from public.watch_members m
  where m.room_id=v_room and m.user_id<>v_uid and m.persona=v_persona
    and m.last_seen_at>now()-interval '90 seconds';
  if v_same>0 then raise exception '% is already watching',v_persona; end if;
  select count(*) into v_others
  from public.watch_members m
  where m.room_id=v_room and m.user_id<>v_uid
    and m.last_seen_at>now()-interval '90 seconds';
  if v_others>=2 then raise exception 'The cinema already has two viewers'; end if;

  -- If nobody is still watching, stop a stale playing session at its last heartbeat.
  if v_others=0 and not exists(
    select 1 from public.watch_members m
    where m.room_id=v_room and m.user_id=v_uid
      and m.last_seen_at>now()-interval '90 seconds'
  ) then
    select max(m.last_seen_at) into v_last_seen from public.watch_members m
      where m.room_id=v_room;
    update public.watch_rooms r set
      position_seconds=least(864000,r.position_seconds+
        greatest(0,extract(epoch from (
          least(now(),coalesce(v_last_seen,now())+interval '25 seconds')-
          r.playback_updated_at
        )))),
      is_playing=false,
      playback_updated_at=clock_timestamp(),
      revision=r.revision+1
    where r.id=v_room and r.is_playing=true;
  end if;

  insert into public.watch_members(room_id,user_id,persona,last_seen_at)
  values(v_room,v_uid,v_persona,clock_timestamp())
  on conflict(room_id,user_id) do update
   set persona=excluded.persona,last_seen_at=excluded.last_seen_at;
  return v_room;
end;
$$;
revoke all on function public.enter_shared_cinema() from public,anon;
grant execute on function public.enter_shared_cinema() to authenticated;

create function public.leave_shared_cinema()
returns void language plpgsql security definer set search_path=''
as $$
declare v_room uuid; v_user uuid:=auth.uid();
begin
 if v_user is null then return; end if;
 select room_id into v_room from public.cinema_home where singleton=1 for update;
 if v_room is null then return; end if;
 delete from public.watch_members where room_id=v_room and user_id=v_user;
 if not exists(
   select 1 from public.watch_members m
   where m.room_id=v_room and m.last_seen_at>now()-interval '90 seconds'
 ) then
   update public.watch_rooms r set
     position_seconds=least(864000,r.position_seconds+
       case when r.is_playing then greatest(0,extract(epoch from
         (clock_timestamp()-r.playback_updated_at))) else 0 end),
     is_playing=false,
     playback_updated_at=clock_timestamp(),
     revision=r.revision+1
   where r.id=v_room and r.is_playing=true;
 end if;
end;
$$;
revoke all on function public.leave_shared_cinema() from public,anon;
grant execute on function public.leave_shared_cinema() to authenticated;
