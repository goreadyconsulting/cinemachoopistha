
-- Cinema Choopistha: private two-person planning room, independent of solo playback.
create table if not exists private.cinema_lobby (
  singleton smallint primary key default 1 check(singleton=1),
  kittu_uid uuid, subbu_uid uuid,
  kittu_seen timestamptz, subbu_seen timestamptz,
  kittu_pick text, subbu_pick text,
  kittu_vote text, subbu_vote text,
  selected_path text,
  updated_at timestamptz not null default now()
);
insert into private.cinema_lobby(singleton) values (1)
on conflict(singleton) do nothing;
alter table private.cinema_lobby enable row level security;
revoke all on private.cinema_lobby from public, anon, authenticated;

create or replace function public.cinema_lobby_action(
  p_action text default 'status',
  p_movie text default null
) returns jsonb
language plpgsql security definer set search_path=''
as $func$
declare
 v_uid uuid:=auth.uid();
 v_persona text;
 v_now timestamptz:=clock_timestamp();
 v_stale interval:=interval '80 seconds';
 l private.cinema_lobby%rowtype;
 v_both boolean;
 v_joined boolean;
 v_room uuid;
 v_phase text;
begin
 if v_uid is null or not private.has_watch_alias() then
   raise exception 'Enter your verified profile PIN first';
 end if;
 select a.persona into v_persona from public.watch_aliases a where a.user_id=v_uid;
 if v_persona not in ('Kittu','Subbu') or v_persona is null then
   raise exception 'This is a private cinema';
 end if;
 if p_action not in ('status','join','heartbeat','propose','vote','leave') or p_action is null then
   raise exception 'Unsupported lobby action';
 end if;
 select * into l from private.cinema_lobby where singleton=1 for update;
 if not found then raise exception 'Lobby is not configured'; end if;

 -- Reclaim sessions whose owner stopped sending heartbeats.
 if l.kittu_uid is not null and (l.kittu_seen is null or l.kittu_seen<v_now-v_stale) then
   l.kittu_uid:=null;l.kittu_seen:=null;l.kittu_pick:=null;l.kittu_vote:=null;
   l.selected_path:=null;
 end if;
 if l.subbu_uid is not null and (l.subbu_seen is null or l.subbu_seen<v_now-v_stale) then
   l.subbu_uid:=null;l.subbu_seen:=null;l.subbu_pick:=null;l.subbu_vote:=null;
   l.selected_path:=null;
 end if;
 if l.kittu_uid is null and l.subbu_uid is null then
   l.kittu_pick:=null;l.subbu_pick:=null;l.kittu_vote:=null;l.subbu_vote:=null;l.selected_path:=null;
 end if;
 if l.selected_path is null then
   -- A new pair must actively agree again.
   if l.kittu_uid is null or l.subbu_uid is null then
     l.kittu_vote:=null;l.subbu_vote:=null;
   end if;
 end if;
 v_joined:=(case when v_persona='Kittu' then l.kittu_uid=v_uid else l.subbu_uid=v_uid end);
 v_joined:=coalesce(v_joined,false);

 if p_action='join' then
   if v_persona='Kittu' then
     if l.kittu_uid is not null and l.kittu_uid<>v_uid then
       raise exception 'Kittu is already here on another device';
     end if;
     l.kittu_uid:=v_uid;l.kittu_seen:=v_now;
   else
     if l.subbu_uid is not null and l.subbu_uid<>v_uid then
       raise exception 'Subbu is already here on another device';
     end if;
     l.subbu_uid:=v_uid;l.subbu_seen:=v_now;
   end if;
   v_joined:=true;
 elsif p_action='leave' then
   if v_joined then
     if v_persona='Kittu' then
       l.kittu_uid:=null;l.kittu_seen:=null;l.kittu_pick:=null;l.kittu_vote:=null;
     else
       l.subbu_uid:=null;l.subbu_seen:=null;l.subbu_pick:=null;l.subbu_vote:=null;
     end if;
     l.selected_path:=null;
     l.kittu_vote:=null;l.subbu_vote:=null;
   end if;
   v_joined:=false;
 elsif p_action<>'status' then
   if not v_joined then raise exception 'Join the movie-night lobby first'; end if;
   if v_persona='Kittu' then l.kittu_seen:=v_now;
   else l.subbu_seen:=v_now; end if;
   if p_action in ('propose','vote') then
     if l.kittu_uid is null or l.subbu_uid is null then
       raise exception 'Wait until both viewers have joined';
     end if;
     if l.selected_path is not null then
       raise exception 'You already agreed on a movie';
     end if;
     if p_movie is null or length(p_movie)>500 or p_movie='' then
       raise exception 'Choose a movie from the library';
     end if;
   end if;
   if p_action='propose' then
     if not exists(
       select 1 from storage.objects o where o.bucket_id='cinema-library'
         and o.name=p_movie and (lower(o.name) like '%.mp4'
           or lower(o.name) like '%.webm' or lower(o.name) like '%.mkv')
     ) then raise exception 'Movie not found in the library'; end if;
     if v_persona='Kittu' then l.kittu_pick:=p_movie;
     else l.subbu_pick:=p_movie; end if;
     l.kittu_vote:=null;l.subbu_vote:=null;
   elsif p_action='vote' then
     if l.kittu_pick is null or l.subbu_pick is null then
       raise exception 'Both viewers must recommend a movie first';
     end if;
     if p_movie<>l.kittu_pick and p_movie<>l.subbu_pick then
       raise exception 'Choose one of your two recommended films';
     end if;
     if v_persona='Kittu' then l.kittu_vote:=p_movie;
     else l.subbu_vote:=p_movie; end if;
     if l.kittu_vote is not null and l.kittu_vote=l.subbu_vote then
       l.selected_path:=p_movie;
       select h.room_id into v_room from public.cinema_home h where h.singleton=1;
       if v_room is null then raise exception 'Shared cinema is unavailable'; end if;
       update public.watch_rooms r set library_path=p_movie,
         video_id=null,position_seconds=0,is_playing=false,
         playback_updated_at=clock_timestamp(),revision=revision+1
         where r.id=v_room;
     end if;
   end if;
 end if;
 v_both:=(l.kittu_uid is not null and l.subbu_uid is not null);
 v_phase:=case when v_both and l.selected_path is not null then 'watching'
          when v_both then 'choosing' else 'waiting' end;
 update private.cinema_lobby set
   kittu_uid=l.kittu_uid,subbu_uid=l.subbu_uid,
   kittu_seen=l.kittu_seen,subbu_seen=l.subbu_seen,
   kittu_pick=l.kittu_pick,subbu_pick=l.subbu_pick,
   kittu_vote=l.kittu_vote,subbu_vote=l.subbu_vote,
   selected_path=l.selected_path,updated_at=v_now
 where singleton=1;
 return jsonb_build_object(
   'joined',v_joined,'phase',v_phase,
   'kittu_here',l.kittu_uid is not null,
   'subbu_here',l.subbu_uid is not null,
   'kittu_pick',l.kittu_pick,'subbu_pick',l.subbu_pick,
   'kittu_vote',l.kittu_vote,'subbu_vote',l.subbu_vote,
   'selected_path',l.selected_path
 );
end;
$func$;
revoke all on function public.cinema_lobby_action(text,text) from public, anon;
grant execute on function public.cinema_lobby_action(text,text) to authenticated;
