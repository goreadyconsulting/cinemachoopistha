
alter table public.watch_videos
 drop constraint watch_videos_file_size_check;
alter table public.watch_videos
 add constraint watch_videos_file_size_check
 check (file_size > 0 and file_size <= 5368709120);
update storage.buckets
set file_size_limit = 5368709120
where id = 'watch-videos' and public = false;
