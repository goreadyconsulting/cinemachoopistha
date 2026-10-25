
-- Private two-person chat, with server-authorized sender identity.
create table public.watch_chat_messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  sender_persona text not null check (sender_persona in ('Kittu','Subbu')),
  body text not null check (char_length(trim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index watch_chat_messages_room_recent_idx
  on public.watch_chat_messages(room_id,id desc);
alter table public.watch_chat_messages enable row level security;
revoke all on public.watch_chat_messages from public,anon,authenticated;
grant select on public.watch_chat_messages to authenticated;
create policy "Only active PIN verified cinema members read chat"
  on public.watch_chat_messages for select to authenticated
  using (private.is_watch_member(room_id));
alter publication supabase_realtime add table public.watch_chat_messages;

create function public.send_cinema_chat(p_room_id uuid,p_message text)
returns bigint
language plpgsql security definer set search_path=''
as $$
declare
  v_user uuid:=auth.uid();
  v_persona text;
  v_body text:=trim(coalesce(p_message,''));
  v_id bigint;
begin
  if v_user is null or not private.is_watch_member(p_room_id) then
    raise exception 'Join the cinema first';
  end if;
  if char_length(v_body) not between 1 and 500 then
    raise exception 'Messages must be between 1 and 500 characters';
  end if;

  -- Serialize writes to avoid burst spam and keep sent message ordering stable.
  perform 1 from public.watch_rooms r where r.id=p_room_id for update;
  if not found then raise exception 'Cinema not found'; end if;

  if exists (
    select 1 from public.watch_chat_messages m
    where m.room_id=p_room_id and m.sender_user_id=v_user
      and m.created_at>clock_timestamp()-interval '1 second'
  ) then
    raise exception 'Please wait a moment before sending again';
  end if;
  select persona into v_persona from public.watch_aliases a where a.user_id=v_user;
  if v_persona is null then raise exception 'PIN verification required'; end if;

  insert into public.watch_chat_messages(room_id,sender_user_id,sender_persona,body)
  values (p_room_id,v_user,v_persona,v_body)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.send_cinema_chat(uuid,text) from public,anon;
grant execute on function public.send_cinema_chat(uuid,text) to authenticated;

-- A shared, atomic ±10 second skip: both browsers observe the same revision.
create function public.skip_cinema_seconds(p_delta integer,p_duration double precision default null)
returns void
language plpgsql security definer set search_path=''
as $$
declare
  v_room uuid;
  v_playing boolean;
  v_position double precision;
  v_updated timestamptz;
  v_limit double precision:=864000;
  v_next double precision;
begin
  if p_delta not in (-10,10) or p_delta is null then
    raise exception 'Skip must be 10 seconds forward or backward';
  end if;
  if p_duration is not null and p_duration>0
     and p_duration<864000 and p_duration not in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8) then
    v_limit:=p_duration;
  end if;
  select r.id,r.is_playing,r.position_seconds,r.playback_updated_at
    into v_room,v_playing,v_position,v_updated
  from public.watch_rooms r
  join public.cinema_home h on h.room_id=r.id and h.singleton=1
  for update of r;

  if v_room is null then raise exception 'Cinema not configured'; end if;
  if not private.is_watch_member(v_room) then raise exception 'Join the cinema first'; end if;
  if not exists (select 1 from public.watch_rooms r where r.id=v_room and r.library_path is not null) then
    raise exception 'Select a movie first';
  end if;
  v_next:=greatest(0,least(v_limit,
    v_position+
    (case when v_playing then greatest(0,extract(epoch from (clock_timestamp()-v_updated))) else 0 end)
    + p_delta
  ));
  update public.watch_rooms r
    set position_seconds=v_next,
        playback_updated_at=clock_timestamp(),
        revision=revision+1
  where r.id=v_room;
end;
$$;
revoke all on function public.skip_cinema_seconds(integer,double precision) from public,anon;
grant execute on function public.skip_cinema_seconds(integer,double precision) to authenticated;
