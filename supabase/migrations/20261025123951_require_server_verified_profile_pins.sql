
alter table public.watch_aliases
 add column pin_session_id text;
create table private.watch_pin_codes (
  persona text primary key check(persona in ('Kittu','Subbu')),
  password_hash text not null
);
create table private.watch_pin_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failures int not null default 0,
  blocked_until timestamptz not null default now()
);
revoke all on private.watch_pin_codes from public,anon,authenticated;
revoke all on private.watch_pin_attempts from public,anon,authenticated;

create or replace function private.has_watch_alias()
returns boolean language sql stable security definer set search_path=''
as $$
 select auth.uid() is not null
   and (auth.jwt()->>'session_id') is not null
   and exists(
     select 1 from public.watch_aliases a
     where a.user_id=(select auth.uid())
       and a.pin_session_id=(auth.jwt()->>'session_id')
   )
$$;

create or replace function private.is_watch_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path=''
as $$
 select private.has_watch_alias() and exists(
   select 1 from public.watch_members m
   where m.room_id=p_room_id and m.user_id=(select auth.uid())
     and m.last_seen_at>now()-interval '90 seconds'
 )
$$;

create or replace function public.verify_cinema_pin(p_persona text,p_pin text)
returns boolean language plpgsql security definer set search_path=''
as $$
declare
  v_uid uuid:=auth.uid();
  v_session text:=(auth.jwt()->>'session_id');
  v_name text;
  v_hash text;
  v_block timestamptz;
begin
  if v_uid is null or v_session is null then return false; end if;
  v_name:=case lower(trim(coalesce(p_persona,'')))
    when 'kittu' then 'Kittu' when 'subbu' then 'Subbu'
    else null end;
  if v_name is null then return false; end if;

  insert into private.watch_pin_attempts(user_id,failures,blocked_until)
  values(v_uid,0,now()) on conflict(user_id) do nothing;
  select blocked_until into v_block
  from private.watch_pin_attempts where user_id=v_uid for update;
  if v_block>now() then return false; end if;

  select password_hash into v_hash from private.watch_pin_codes where persona=v_name;
  if p_pin is not null and p_pin ~ '^[0-9]{4}$'
     and v_hash is not null
     and extensions.crypt(p_pin,v_hash)=v_hash then
    insert into public.watch_aliases(user_id,persona,pin_session_id)
    values(v_uid,v_name,v_session)
    on conflict(user_id) do update
      set persona=excluded.persona,pin_session_id=excluded.pin_session_id;
    update private.watch_pin_attempts set failures=0,blocked_until=now() where user_id=v_uid;
    return true;
  end if;

  update private.watch_pin_attempts
  set failures=case when blocked_until<now()-interval '15 minutes' then 1 else least(5,failures+1) end,
      blocked_until=case when failures>=4 then now()+interval '15 minutes' else now() end
  where user_id=v_uid;
  return false;
end
$$;
revoke all on function public.verify_cinema_pin(text,text) from public,anon;
grant execute on function public.verify_cinema_pin(text,text) to authenticated;

-- Previous guest-label-only RPC can no longer grant a role.
revoke all on function public.claim_watch_alias(text) from public,anon,authenticated;
-- Old room creation/join flows are retired. Everyone enters the persistent cinema.
revoke all on function public.create_watch_room(text) from public,anon,authenticated;
revoke all on function public.join_watch_room(text) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION public.enter_shared_cinema()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid:=auth.uid(); v_persona text; v_room uuid;
 v_same integer; v_others integer; v_last_seen timestamptz;
begin
  if v_uid is null then raise exception 'Choose a profile first'; end if;
  if not private.has_watch_alias() then raise exception 'PIN required'; end if;
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
$function$;
CREATE OR REPLACE FUNCTION public.get_cinema_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_room uuid; v_persona text; v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'Choose a profile first';
  end if;
  if not private.has_watch_alias() then raise exception 'PIN required'; end if;
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
$function$;
CREATE OR REPLACE FUNCTION public.keep_watch_seat(p_room_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user uuid := auth.uid();
  v_updated integer;
begin
  if v_user is null then return false; end if;
  if not private.has_watch_alias() then return false; end if;
  update public.watch_members m
     set last_seen_at=clock_timestamp()
   where m.room_id=p_room_id and m.user_id=v_user
     and m.last_seen_at > now() - interval '90 seconds';
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$function$;
