
-- Cinema Choopistha: first production schema
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.watch_rooms (
 id uuid primary key default gen_random_uuid(),
 invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text,'-',''),1,16)),
 name text not null check (char_length(name) between 1 and 60),
 created_by uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default now(),
 video_id uuid,
 position_seconds double precision not null default 0 check (position_seconds >= 0 and position_seconds <= 864000),
 is_playing boolean not null default false,
 playback_updated_at timestamptz not null default now(),
 revision bigint not null default 0
);
create index watch_rooms_creator_idx on public.watch_rooms (created_by);

create table public.watch_members (
 room_id uuid not null references public.watch_rooms(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 joined_at timestamptz not null default now(),
 primary key(room_id,user_id)
);
create index watch_members_user_idx on public.watch_members(user_id);

create table public.watch_videos (
 id uuid primary key default gen_random_uuid(),
 room_id uuid not null references public.watch_rooms(id) on delete cascade,
 uploaded_by uuid not null references auth.users(id) on delete cascade,
 title text not null check (char_length(title) between 1 and 180),
 object_path text not null unique,
 mime_type text not null check (mime_type in ('video/mp4','video/webm')),
 file_size bigint not null check (file_size > 0 and file_size <= 52428800),
 created_at timestamptz not null default now(),
 constraint path_matches_owner check (
    split_part(object_path,'/',1) = room_id::text
    and split_part(object_path,'/',2) = uploaded_by::text
 )
);
create index watch_videos_room_created_idx on public.watch_videos (room_id, created_at desc);
alter table public.watch_rooms add constraint watch_rooms_video_fk
 foreign key(video_id) references public.watch_videos(id) on delete set null;

create function private.is_watch_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select (select auth.uid()) is not null
 and exists (select 1 from public.watch_members wm
 where wm.room_id=p_room_id and wm.user_id=(select auth.uid())); $$;
revoke all on function private.is_watch_member(uuid) from public, anon;
grant execute on function private.is_watch_member(uuid) to authenticated;

alter table public.watch_rooms enable row level security;
alter table public.watch_members enable row level security;
alter table public.watch_videos enable row level security;

create policy "Members may see rooms" on public.watch_rooms for select to authenticated
 using (private.is_watch_member(id));
create policy "Members may see room participants" on public.watch_members for select to authenticated
 using (private.is_watch_member(room_id));
create policy "Members may see videos" on public.watch_videos for select to authenticated
 using (private.is_watch_member(room_id));
create policy "Members may add their own video metadata" on public.watch_videos for insert to authenticated
 with check ((select auth.uid()) = uploaded_by and private.is_watch_member(room_id));

revoke all on public.watch_rooms, public.watch_members, public.watch_videos from public, anon, authenticated;
grant select on public.watch_rooms, public.watch_members, public.watch_videos to authenticated;
grant insert on public.watch_videos to authenticated;

create function public.create_watch_room(p_name text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_user uuid := auth.uid(); v_id uuid; v_name text := trim(coalesce(p_name,''));
begin
 if v_user is null then raise exception 'Please sign in'; end if;
 if char_length(v_name) not between 1 and 60 then raise exception 'Room name must be 1–60 characters'; end if;
 insert into public.watch_rooms(name, created_by) values (v_name,v_user) returning id into v_id;
 insert into public.watch_members(room_id,user_id) values (v_id,v_user);
 return v_id;
end $$;

create function public.join_watch_room(p_code text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_user uuid := auth.uid(); v_id uuid;
begin
 if v_user is null then raise exception 'Please sign in'; end if;
 select id into v_id from public.watch_rooms where invite_code=upper(trim(coalesce(p_code,'')));
 if v_id is null then raise exception 'No room found for that invite code'; end if;
 insert into public.watch_members(room_id,user_id) values (v_id,v_user) on conflict do nothing;
 return v_id;
end $$;

create function public.control_watch_room(
 p_room_id uuid, p_video_id uuid, p_position double precision, p_is_playing boolean
) returns void language plpgsql security definer set search_path = ''
as $$
begin
 if (select auth.uid()) is null or not private.is_watch_member(p_room_id) then
  raise exception 'Not a room member';
 end if;
 if p_video_id is null or not exists (
  select 1 from public.watch_videos where id=p_video_id and room_id=p_room_id
 ) then raise exception 'Video is not part of this room'; end if;
 if p_position is null or p_position < 0 or p_position > 864000 or p_position = 'NaN'::float8
 or p_position = 'Infinity'::float8 or p_position = '-Infinity'::float8 then
  raise exception 'Invalid playback position';
 end if;
 if p_is_playing is null then raise exception 'Playback state required'; end if;
 update public.watch_rooms set video_id=p_video_id, position_seconds=p_position,
 is_playing=p_is_playing, playback_updated_at=clock_timestamp(),
 revision=revision+1 where id=p_room_id;
end $$;

revoke all on function public.create_watch_room(text) from public, anon;
revoke all on function public.join_watch_room(text) from public, anon;
revoke all on function public.control_watch_room(uuid,uuid,double precision,boolean) from public, anon;
grant execute on function public.create_watch_room(text) to authenticated;
grant execute on function public.join_watch_room(text) to authenticated;
grant execute on function public.control_watch_room(uuid,uuid,double precision,boolean) to authenticated;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('watch-videos','watch-videos',false,52428800,array['video/mp4','video/webm'])
on conflict (id) do nothing;

create policy "Room members can view private videos"
on storage.objects for select to authenticated
using (
 bucket_id='watch-videos'
 and private.is_watch_member((storage.foldername(name))[1]::uuid)
);
create policy "Room members can upload into their own folder"
on storage.objects for insert to authenticated
with check (
 bucket_id='watch-videos'
 and private.is_watch_member((storage.foldername(name))[1]::uuid)
 and (storage.foldername(name))[2] = (select auth.uid())::text
);

-- Channel topics are exactly "watch:<room UUID>"; presence is members-only.
create policy "Watch members can receive presence" on realtime.messages for select to authenticated
using (
 extension='presence'
 and left((select realtime.topic()),6)='watch:'
 and private.is_watch_member(substr((select realtime.topic()),7)::uuid)
);
create policy "Watch members can publish presence" on realtime.messages for insert to authenticated
with check (
 extension='presence'
 and left((select realtime.topic()),6)='watch:'
 and private.is_watch_member(substr((select realtime.topic()),7)::uuid)
);

alter publication supabase_realtime add table public.watch_rooms;
