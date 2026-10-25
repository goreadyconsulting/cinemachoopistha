
create or replace function public.control_watch_library(
 p_room_id uuid,p_object_path text,p_position double precision,p_is_playing boolean
) returns void language plpgsql security definer set search_path=''
as $$
begin
 if (select auth.uid()) is null or not private.is_watch_member(p_room_id)
 then raise exception 'Not a room member'; end if;
 if p_object_path is null or not exists(
   select 1 from storage.objects o
   where o.bucket_id='cinema-library' and o.name=p_object_path
     and (lower(right(o.name,4)) in ('.mkv','.mp4')
          or lower(right(o.name,5))='.webm')
 ) then raise exception 'That movie is not in the shared library'; end if;
 if p_position is null or p_position < 0 or p_position > 864000
    or p_position in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)
 then raise exception 'Invalid playback position'; end if;
 if p_is_playing is null then raise exception 'Playback state required'; end if;
 update public.watch_rooms set library_path=p_object_path,video_id=null,
 position_seconds=p_position,is_playing=p_is_playing,playback_updated_at=clock_timestamp(),
 revision=revision+1 where id=p_room_id;
end; $$;
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
 if p_position is null or p_position < 0 or p_position > 864000
    or p_position in ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)
 then raise exception 'Invalid playback position'; end if;
 if p_is_playing is null then raise exception 'Playback state required'; end if;
 update public.watch_rooms set video_id=p_video_id,library_path=null,
 position_seconds=p_position,is_playing=p_is_playing,playback_updated_at=clock_timestamp(),
 revision=revision+1 where id=p_room_id;
end; $$;
