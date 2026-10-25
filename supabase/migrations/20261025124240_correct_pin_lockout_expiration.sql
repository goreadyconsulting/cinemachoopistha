CREATE OR REPLACE FUNCTION public.verify_cinema_pin(p_persona text, p_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  set failures=case when failures>=5 and blocked_until<=now() then 1 else least(5,failures+1) end,
      blocked_until=case when failures>=5 and blocked_until<=now() then now() when failures>=4 then now()+interval '15 minutes' else now() end
  where user_id=v_uid;
  return false;
end
$function$
;