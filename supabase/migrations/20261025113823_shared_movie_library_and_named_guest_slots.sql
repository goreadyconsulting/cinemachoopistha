
-- Two named entry choices and a dashboard-managed private movie catalog.
create table public.watch_aliases (
  user_id uuid primary key references auth.users(id) on delete cascade,
  persona text not null check (persona in ('Kittu','Subbu')),
  created_at timestamptz not null default now()
);
alter table public.watch_aliases enable row level security;
revoke all on public.watch_aliases from public, anon, authenticated;
grant select on public.watch_aliases to authenticated;
create policy "See only own cinema identity" on public.watch_aliases
  for select to authenticated using (user_id=(select auth.uid()));

create function private.has_watch_alias()
returns boolean language sql stable security definer set search_path=''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.watch_aliases where user_id=(select auth.uid())
  );
$$;
revoke all on function private.has_watch_alias() from public,anon;
grant execute on function private.has_watch_alias() to authenticated;

create function public.claim_watch_alias(p_persona text)
returns text language plpgsql security definer set search_path=''
as $$
declare v_persona text; v_existing text;
begin
  if (select auth.uid()) is null then raise exception 'Enter as a guest first'; end if;
  v_persona:=case lower(trim(coalesce(p_persona,'')))
    when 'kittu' then 'Kittu'
    when 'subbu' then 'Subbu'
    else null end;
  if v_persona is null then raise exception 'Only Kittu or Subbu may enter'; end if;
  insert into public.watch_aliases (user_id,persona)
  values ((select auth.uid()),v_persona)
  on conflict (user_id) do nothing;
  select persona into v_existing from public.watch_aliases
    where user_id=(select auth.uid());
  if v_existing is distinct from v_persona then
    raise exception 'This guest session is already set to %. Exit to switch names',v_existing;
  end if;
  return v_existing;
end; $$;
revoke all on function public.claim_watch_alias(text) from public,anon;
grant execute on function public.claim_watch_alias(text) to authenticated;

alter table public.watch_members
 add column persona text check (persona in ('Kittu','Subbu'));
-- Preserve any earlier memberships should they exist, and label any named existing guests.
update public.watch_members m set persona=
 case lower(trim(u.raw_user_meta_data->>'display_name'))
  when 'kittu' then 'Kittu' when 'subbu' then 'Subbu' else null end
from auth.users u where u.id=m.user_id and m.persona is null;

create or replace function public.create_watch_room(p_name text)
returns uuid language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_id uuid; v_name text:=trim(coalesce(p_name,''));
 v_persona text;
begin
  if v_user is null then raise exception 'Enter as Kittu or Subbu first'; end if;
  select persona into v_persona from public.watch_aliases where user_id=v_user;
  if v_persona is null then raise exception 'Choose Kittu or Subbu first'; end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'Room name must be 1–60 characters';
  end if;
  insert into public.watch_rooms(name,created_by) values(v_name,v_user) returning id into v_id;
  insert into public.watch_members(room_id,user_id,persona)
  values(v_id,v_user,v_persona);
  return v_id;
end; $$;

create or replace function public.join_watch_room(p_code text)
returns uuid language plpgsql security definer set search_path=''
as $$
declare
 v_user uuid:=auth.uid(); v_id uuid; v_count integer; v_persona text;
begin
 if v_user is null then raise exception 'Enter as Kittu or Subbu first'; end if;
 select persona into v_persona from public.watch_aliases where user_id=v_user;
 if v_persona is null then raise exception 'Choose Kittu or Subbu first'; end if;
 -- Lock the room to serialize seat claims.
 select id into v_id from public.watch_rooms
 where invite_code=upper(trim(coalesce(p_code,''))) for update;
 if v_id is null then raise exception 'No room found for that invite code'; end if;
 select count(*) into v_count from public.watch_members m
 where m.room_id=v_id and m.user_id<>v_user
 and m.last_seen_at>now()-interval '90 seconds';
 if v_count >= 2 then raise exception 'Room full: only Kittu and Subbu can watch together'; end if;
 if exists(
  select 1 from public.watch_members m
  join public.watch_aliases a on a.user_id=m.user_id
  where m.room_id=v_id and m.user_id<>v_user
  and m.last_seen_at>now()-interval '90 seconds'
  and a.persona=v_persona
 ) then raise exception '% is already watching in this room',v_persona; end if;
 insert into public.watch_members(room_id,user_id,persona,last_seen_at)
 values(v_id,v_user,v_persona,clock_timestamp())
 on conflict (room_id,user_id)
 do update set persona=excluded.persona,last_seen_at=excluded.last_seen_at;
 return v_id;
end; $$;

alter table public.watch_rooms add column library_path text;

-- Dashboard uploads only. No upload/write policy for guests.
insert into storage.buckets(id,name,public,file_size_limit)
values('cinema-library','cinema-library',false,5368709120)
on conflict(id) do nothing;
create policy "Cinema members can list and stream library" on storage.objects
for select to authenticated
using(bucket_id='cinema-library' and private.has_watch_alias());

create function public.control_watch_library(
 p_room_id uuid,p_object_path text,p_position double precision,p_is_playing boolean
) returns void language plpgsql security definer set search_path=''
as $$
begin
 if (select auth.uid()) is null or not private.is_watch_member(p_room_id)
 then raise exception 'Not a room member'; end if;
 if p_object_path is null or not exists (
   select 1 from storage.objects o
   where o.bucket_id='cinema-library' and o.name=p_object_path
   and o.name ~* '\\.(mp4|webm|mkv)$'
 ) then raise exception 'That movie is not in the shared library'; end if;
 if p_position is null or p_position < 0 or p_position > 864000
   or not isfinite(p_position) then raise exception 'Invalid playback position'; end if;
 if p_is_playing is null then raise exception 'Playback state required'; end if;
 update public.watch_rooms set library_path=p_object_path,video_id=null,
 position_seconds=p_position,is_playing=p_is_playing,playback_updated_at=clock_timestamp(),
 revision=revision+1 where id=p_room_id;
end; $$;
revoke all on function public.control_watch_library(uuid,text,double precision,boolean) from public,anon;
grant execute on function public.control_watch_library(uuid,text,double precision,boolean) to authenticated;

-- Ensure a legacy room video selection clears shared-library selection.
create or replace function public.control_watch_room(
 p_room_id uuid,p_video_id uuid,p_position double precision,p_is_playing boolean
) returns void language plpgsql security definer set search_path=''
as $$
begin
 if (select auth.uid()) is null or not private.is_watch_member(p_room_id)
 then raise exception 'Not a room member'; end if;
 if p_video_id is null or not exists(
   select 1 from public.watch_videos where id=p_video_id and room_id=p_room_id
 ) then raise exception 'Video is not part of this room'; end if;
 if p_position is null or p_position<0 or p_position>864000 or not isfinite(p_position)
 then raise exception 'Invalid playback position'; end if;
 if p_is_playing is null then raise exception 'Playback state required'; end if;
 update public.watch_rooms set video_id=p_video_id,library_path=null,
 position_seconds=p_position,is_playing=p_is_playing,playback_updated_at=clock_timestamp(),
 revision=revision+1 where id=p_room_id;
end; $$;
