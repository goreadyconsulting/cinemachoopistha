import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.0/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";


const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const LIBRARY_BUCKET = "cinema-library";
let chosenPersona = null;
let dashboardMovieData = [];
const $ = (id) => document.getElementById(id);
const state = { user: null, persona: null, room: null, videos: [], channel: null, sourceVideoId: null, applyToken: 0, scrubbing: false, lastAppliedRevision: -1 };
let toastTimer = null;
const player = $("player");

function notify(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}
function displayName() {
  return state.persona || "Guest";
}
function avatarUrl(user) { return user?.user_metadata?.avatar_url || ""; }
function show(view) {
  ["loginView","dashboardView","roomView"].forEach(id => { $(id).hidden = id !== view; });
  $("loginBtn").hidden = !!state.user;
  $("userBar").hidden = !state.user;
  $("topNav").hidden = view !== "dashboardView";
  document.body.dataset.view = view;
  if (state.persona) {
    $("dashboardName").textContent = state.persona;
    $("userAvatarBadge").textContent = state.persona.charAt(0).toUpperCase();
  }
}
function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) { button.dataset.before = button.textContent; button.textContent = label; }
  else if (button.dataset.before) { button.textContent = button.dataset.before; delete button.dataset.before; }
}
function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const s = Math.floor(value);
  return Math.floor(s / 3600) > 0
    ? [Math.floor(s / 3600), Math.floor(s % 3600 / 60).toString().padStart(2, "0"), (s % 60).toString().padStart(2, "0")].join(":")
    : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function expectedPosition(room) {
  if (!room) return 0;
  const elapsed = room.is_playing ? Math.max(0, (Date.now() - Date.parse(room.playback_updated_at)) / 1000) : 0;
  return room.position_seconds + elapsed;
}
function safeAvatar(img, url, name) {
  img.alt = name;
  if (typeof url === "string" && /^https:\/\/avatars\.githubusercontent\.com\//.test(url)) {
    img.src = url;
  } else {
    img.hidden = true;
  }
}
function routeRoom(id) { history.replaceState({}, "", location.pathname + "?room=" + encodeURIComponent(id)); }
function clearRoute() { history.replaceState({}, "", location.pathname); }
function selectPersona(persona) {
  if (!["Kittu","Subbu"].includes(persona)) return;
  chosenPersona = persona;
  $("chooseKittu").setAttribute("aria-pressed", String(persona === "Kittu"));
  $("chooseSubbu").setAttribute("aria-pressed", String(persona === "Subbu"));
  $("heroLoginBtn").disabled = false;
  $("heroLoginBtn").textContent = "Continue as " + persona + " →";
}
async function fetchPersona(userId) {
  const { data, error } = await db.from("watch_aliases")
    .select("persona").eq("user_id",userId).maybeSingle();
  if (error) throw error;
  return data?.persona || null;
}
async function signIn() {
  if (!chosenPersona) return notify("Select Kittu or Subbu first.");
  const button = $("heroLoginBtn");
  if (button.disabled) return;
  setBusy(button,true,"Entering…");
  try {
    let { data: { user } } = await db.auth.getUser();
    if (!user) {
      const { data, error } = await db.auth.signInAnonymously();
      if (error) throw error;
      user = data.user;
    }
    const { data: persona, error: claimError } =
      await db.rpc("claim_watch_alias",{p_persona:chosenPersona});
    if (claimError) throw claimError;
    state.user = user;
    state.persona = persona;
    $("userName").textContent = displayName();
    safeAvatar($("userAvatar"),avatarUrl(user),displayName());
    const params = new URLSearchParams(location.search);
    if (params.has("join")) await joinByCode(params.get("join"));
    else if (params.has("room")) await openRoom(params.get("room"));
    else await dashboard();
  } catch(err) {
    console.error(err);
    notify(err.message || "Could not enter. Enable Anonymous Sign-ins in Supabase.");
  } finally {
    setBusy(button,false);
  }
}
async function signOut() {
  if (state.room) await db.rpc("leave_watch_room",{p_room_id:state.room.id});
  await leaveRoom();
  const { error } = await db.auth.signOut();
  if (error) { notify(error.message); return; }
  state.user = null; state.persona = null;
  chosenPersona = null;
  $("chooseKittu").setAttribute("aria-pressed","false");
  $("chooseSubbu").setAttribute("aria-pressed","false");
  $("heroLoginBtn").disabled = true;
  $("heroLoginBtn").textContent = "Choose your profile →";
  clearRoute(); show("loginView");
}
async function loadMyRooms() {
  const { data, error } = await db.from("watch_rooms")
    .select("id,name,invite_code,created_at,library_path,is_playing")
    .order("created_at",{ ascending:false });
  if (error) { notify(error.message); return; }
  const list = $("roomsList"); list.replaceChildren();
  if (!data?.length) {
    const empty = document.createElement("div"); empty.className="muted-panel";
    empty.textContent="No screenings yet. Your first movie night is one click away.";
    list.append(empty); return;
  }
  data.forEach(room=>{
    const card=document.createElement("button"); card.type="button";card.className="room-card";
    const top=document.createElement("div"); top.className="room-card-top";
    const heart=document.createElement("span");heart.textContent="♡";
    const arrow=document.createElement("span");arrow.textContent="↗";top.append(heart,arrow);
    const name=document.createElement("h3");name.textContent=room.name;
    const subtitle=document.createElement("p");subtitle.textContent=
      (room.is_playing?"● Playing now":"Private watch room")+" · "+new Date(room.created_at).toLocaleDateString();
    card.append(top,name,subtitle);
    card.addEventListener("click",()=>openRoom(room.id));
    list.append(card);
  });
}
async function dashboard() {
  await leaveRoom();
  clearRoute();
  show("dashboardView");
  await Promise.all([loadMyRooms(),loadLibraryDashboard()]);
}
async function leaveSeat() {
  if (!state.room) return;
  const roomId = state.room.id;
  const { error } = await db.rpc("leave_watch_room", { p_room_id: roomId });
  if (error) { notify(error.message); return; }
  await dashboard();
  notify("You left the room. Your seat is available for another guest.");
}
async function keepSeatAlive() {
  if (!state.room || !state.user) return;
  const roomId = state.room.id;
  const invite = state.room.invite_code;
  const { data: active, error } = await db.rpc("keep_watch_seat", { p_room_id: roomId });
  if (state.room?.id !== roomId) return;
  if (!error && active) return;
  // Recover after device sleep or a briefly interrupted connection.
  const result = await db.rpc("join_watch_room", { p_code: invite });
  if (state.room?.id !== roomId) return;
  if (result.error) {
    notify(result.error.message || "The room is now full. Your seat expired.");
    await dashboard();
  } else {
    const { data: latest } = await db.from("watch_rooms").select("*").eq("id", roomId).single();
    if (latest && state.room?.id === roomId) applyPlayback(latest).catch(console.error);
  }
}
async function createRoom(event) {
  event.preventDefault();
  const btn = event.submitter || $("createForm").querySelector("button");
  setBusy(btn, true, "Creating…");
  try {
    const { data, error } = await db.rpc("create_watch_room", { p_name: $("roomName").value.trim() });
    if (error) throw error;
    $("roomName").value = "";
    await openRoom(data);
  } catch (err) { notify(err.message || "Couldn't create room"); }
  finally { setBusy(btn, false); }
}
async function joinByCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return;
  const { data, error } = await db.rpc("join_watch_room", { p_code: normalized });
  if (error) { notify(error.message); await dashboard(); return; }
  await openRoom(data);
}
async function joinForm(event) {
  event.preventDefault();
  const btn = event.submitter || $("joinForm").querySelector("button");
  setBusy(btn, true, "Joining…");
  try {
    await joinByCode($("inviteCode").value);
    $("inviteCode").value = "";
  } finally { setBusy(btn, false); }
}
async function leaveRoom() {
  ++state.applyToken;
  if (state.channel) { await db.removeChannel(state.channel); state.channel = null; }
  player.pause(); player.removeAttribute("src"); player.load();
  state.room = null; state.videos = []; state.sourceVideoId = null; state.lastAppliedRevision = -1;
  $("joinPlaybackBtn").hidden = true;
}
async function openRoom(id) {
  if (!state.user) return;
  await leaveRoom();
  let { data, error } = await db.from("watch_rooms").select("*").eq("id", id).single();
  if (error) {
    // The previous guest seat may have timed out after leaving the page.
    const savedInvite = localStorage.getItem("cinemaInvite:" + id);
    if (savedInvite) {
      const rejoin = await db.rpc("join_watch_room", { p_code: savedInvite });
      if (!rejoin.error) {
        ({ data, error } = await db.from("watch_rooms").select("*").eq("id", id).single());
      } else notify(rejoin.error.message);
    }
  }
  if (error) { notify("Room unavailable, full, or invite expired. Use a valid invite code."); await dashboard(); return; }
  localStorage.setItem("cinemaInvite:" + data.id, data.invite_code);
  state.room = data;
  routeRoom(data.id); show("roomView");
  $("currentRoomName").textContent = data.name;
  $("crumbName").textContent = data.name;
  $("roomCode").textContent = data.invite_code;
  await loadVideos();
  if (!state.room || state.room.id !== id) return;
  await applyPlayback(data);
  await subscribeRoom(id);
}
const getSelection = (room) =>
  room?.library_path ? "library:" + room.library_path : (room?.video_id || null);
const isSupportedMovie = (name) => /\.(mp4|webm|mkv)$/i.test(name || "");
const isMatroska = (name) => /\.mkv$/i.test(name || "");
function movieName(filename) {
  const cleaned=(filename || "Untitled")
    .replace(/\.(mp4|webm|mkv)$/i,"")
    .replace(/[_.-]+/g," ").replace(/\s+/g," ").trim();
  const match=cleaned.match(/^(.*?)\s+((?:19|20)\d{2})(?:\s|$)/);
  if(match && match[1].trim()) return match[1].trim()+" ("+match[2]+")";
  return cleaned.replace(/\s+(1080p|720p|2160p|HEVC|WEB DL|BluRay|x264|x265|DDP5).*$/i,"").trim() || "Untitled";
}
function formatBytes(value) {
  const bytes=Number(value)||0;
  if (bytes>=1024**3) return (bytes/(1024**3)).toFixed(2)+" GB";
  if (bytes>=1024**2) return (bytes/(1024**2)).toFixed(1)+" MB";
  return (bytes/1024).toFixed(0)+" KB";
}
async function listSharedMovies() {
  // Read directly from Supabase Storage, not from manually maintained DB rows.
  const { data, error } = await db.storage.from(LIBRARY_BUCKET)
    .list("",{limit:100,sortBy:{column:"name",order:"asc"}});
  if(error) throw error;
  const entries=(data || []).filter(file=>file.id && isSupportedMovie(file.name))
    .map(file=>({
      id:"library:"+file.name,
      object_path:file.name,
      bucket:LIBRARY_BUCKET,
      title:movieName(file.name),
      file_size:Number(file.metadata?.size || 0),
      mime_type:file.metadata?.mimetype || "",
      isMkv:isMatroska(file.name),
      isLibrary:true
    }));
  // A remastered MP4 and its older MKV copy should appear as one movie.
  const titles=new Map();
  entries.forEach(movie=>{
    const key=movie.title.toLowerCase();
    const prior=titles.get(key);
    if(!prior || (prior.isMkv && !movie.isMkv)) titles.set(key,movie);
  });
  return [...titles.values()].sort((a,b)=>a.title.localeCompare(b.title));
}
async function startMovieNight(movie=null) {
  const button=$("featuredStartBtn");
  if(button.disabled)return;
  setBusy(button,true,"Setting up our cinema…");
  try{
    const name="Our Movie Night";
    const {data,error}=await db.rpc("create_watch_room",{p_name:name});
    if(error)throw error;
    await openRoom(data);
    if(movie && state.room?.id===data){
      if(movie.isMkv)notify("MKV might not play in this browser. An H.264/AAC MP4 is recommended.");
      await sendControl(movie.id,0,false);
    }
  }catch(error){notify(error?.message||"Couldn't start our movie night.");}
  finally{setBusy(button,false);}
}
async function loadLibraryDashboard() {
  const root=$("libraryDashboard");
  try {
    const movies=await listSharedMovies();
    dashboardMovieData=movies;
    root.replaceChildren();
    const featured=movies[0] || null;
    $("featureTitle").textContent=featured?.title || "Our next movie night";
    $("featureEyebrow").textContent=featured?"FROM OUR PRIVATE LIBRARY":"WELCOME TO OUR CINEMA";
    $("featureSubtitle").textContent=featured
      ? "The best seat in the house is the one next to you. Our next story starts here."
      : "One film. Two seats. All the moments in between.";
    $("featureMeta").textContent=featured
      ? (featured.isMkv?"MKV · browser playback may be unavailable":"Ready for movie night")+(featured.file_size?" · "+formatBytes(featured.file_size):"")
      : "Our shared collection";
    $("featuredStartBtn").dataset.movieId=featured?.id||"";
    $("libraryHint").textContent=featured?.isMkv
      ? "Your MKV is in the library. Most browsers don't play MKV reliably. Converting to H.264/AAC MP4 is the best option."
      : "All your movies live in private Supabase Storage. This cinema is for watching, not uploading.";
    if(!movies.length){
      const empty=document.createElement("div");empty.className="muted-panel";
      empty.textContent="It's a blank screen waiting for a story. Once a movie is added to your private Supabase library, it'll appear right here.";
      root.append(empty);return;
    }
    movies.forEach((movie,index)=>{
      const card=document.createElement("button");card.type="button";card.className="library-card";
      card.setAttribute("aria-label","Start a movie night with "+movie.title);
      const art=document.createElement("div");art.className="library-art";
      const artIndex=document.createElement("span");artIndex.className="library-art-index";
      artIndex.textContent=index===0?"FEATURED":"OUR COLLECTION";
      const title=document.createElement("span");title.className="library-art-label";
      title.textContent=movie.title;
      const play=document.createElement("span");play.className="library-art-play";play.textContent="▶";
      art.append(artIndex,title,play);
      const body=document.createElement("div");body.className="library-info";
      const heading=document.createElement("strong");heading.textContent=movie.title;
      const meta=document.createElement("small");
      meta.className=movie.isMkv?"warning-format":"ready-format";
      meta.textContent=(movie.isMkv?"⚠ MKV · may not play":"▶ Ready to watch")+
        (movie.file_size?" · "+formatBytes(movie.file_size):"");
      body.append(heading,meta);card.append(art,body);
      card.addEventListener("click",()=>startMovieNight(movie));
      root.append(card);
    });
  }catch(error){
    root.replaceChildren();
    const empty=document.createElement("div");empty.className="muted-panel";
    empty.textContent="We couldn't load the collection right now. "+(error?.message||"Try refreshing the page.");
    root.append(empty);
  }
}
async function loadVideos() {
  if(!state.room)return;
  const roomId=state.room.id;
  const [shared,legacy]=await Promise.allSettled([
    listSharedMovies(),
    db.from("watch_videos").select("*").eq("room_id",roomId).order("created_at",{ascending:false})
  ]);
  if(state.room?.id!==roomId)return;
  if(shared.status==="rejected")notify("Movie library unavailable: "+shared.reason.message);
  if(legacy.status==="fulfilled" && legacy.value.error)notify(legacy.value.error.message);
  const movies=shared.status==="fulfilled" ? shared.value : [];
  const old=legacy.status==="fulfilled" ? (legacy.value.data || []).map(video=>({
    ...video,bucket:"watch-videos",isLibrary:false,isMkv:false
  })) : [];
  state.videos=[...movies,...old];
  renderVideos();
}
function renderVideos() {
  const list=$("videosList");list.replaceChildren();
  $("videoCount").textContent=String(state.videos.length);
  if(!state.videos.length){
    const p=document.createElement("p");p.className="muted";
    p.textContent="No films in our collection yet. Add a movie to Supabase Storage and refresh.";
    list.append(p);return;
  }
  state.videos.forEach((video)=>{
    const item=document.createElement("button");item.type="button";
    item.className="video-item"+(getSelection(state.room)===video.id?" selected":"");
    const icon=document.createElement("span");
    icon.className="video-item-icon";icon.textContent=video.isMkv?"MKV":"▶";
    const body=document.createElement("span");body.className="video-item-main";
    const title=document.createElement("strong");title.textContent=video.title;
    const info=document.createElement("small");
    info.textContent=(video.isMkv?"MKV · may not play":video.isLibrary?"Shared library":"Earlier upload")+
      (video.file_size?" · "+formatBytes(video.file_size):"");
    body.append(title,info);
    const arrow=document.createElement("span");arrow.className="play-small";
    arrow.textContent=getSelection(state.room)===video.id?"●":"↗";
    item.append(icon,body,arrow);
    item.addEventListener("click",()=>{
      if(video.isMkv)notify("MKV playback isn't supported in many browsers. For reliable viewing, convert it to an H.264/AAC MP4.");
      sendControl(video.id,0,false);
    });
    list.append(item);
  });
}
async function sendControl(videoId, position, playing) {
  if (!state.room || !videoId) return;
  const id = state.room.id;
  const safePosition = Math.min(864000, Math.max(0, Number(position) || 0));
  const { error } = videoId.startsWith("library:")
    ? await db.rpc("control_watch_library",{
      p_room_id:id,p_object_path:videoId.slice(8),p_position:safePosition,p_is_playing:!!playing
    })
    : await db.rpc("control_watch_room",{
      p_room_id:id,p_video_id:videoId,p_position:safePosition,p_is_playing:!!playing
    });
  if (error) { notify(error.message); return; }
  // Read after write as a fallback if the websocket is slow or reconnecting.
  const { data } = await db.from("watch_rooms").select("*").eq("id", id).single();
  if (data && state.room?.id === id && data.revision >= state.room.revision) await applyPlayback(data);
}
async function applyPlayback(incoming) {
  if(!state.room || incoming.id!==state.room.id)return;
  if(incoming.revision < state.lastAppliedRevision)return;
  state.room=incoming;
  state.lastAppliedRevision=incoming.revision;
  const selection=getSelection(incoming);
  $("syncStatus").innerHTML='<span class="dot"></span> In sync';
  $("playPauseBtn").disabled=!selection;
  $("seekBar").disabled=!selection;
  renderVideos();
  if(!selection){
    $("playerFormatWarning").hidden=true;
    player.pause();
    $("playerEmpty").hidden=false;player.hidden=true;
    $("nowPlayingTitle").textContent="No video selected";
    return;
  }
  let video=state.videos.find(v=>v.id===selection);
  if(!video){
    await loadVideos();
    video=state.videos.find(v=>v.id===selection);
    if(!video)return;
  }
  $("nowPlayingTitle").textContent=video.title;
  $("playerFormatWarning").hidden=!video.isMkv;
  if(video.isMkv && state.sourceVideoId!==selection){
    notify("MKV detected. Most browsers can't play this format. Convert to MP4 if playback fails.");
  }
  $("playerEmpty").hidden=true;player.hidden=false;
  if(state.sourceVideoId!==selection){
    const token=++state.applyToken;
    state.sourceVideoId=selection;
    player.pause();player.removeAttribute("src");
    $("joinPlaybackBtn").hidden=true;
    const {data,error}=await db.storage.from(video.bucket).createSignedUrl(video.object_path,21600);
    if(token!==state.applyToken || getSelection(state.room)!==selection)return;
    if(error || !data?.signedUrl){
      state.sourceVideoId=null;
      notify(error?.message || "Couldn't load this movie from Supabase");
      return;
    }
    player.src=data.signedUrl;
    player.load();
    player.addEventListener("loadedmetadata",()=>syncPlayerToRoom(),{once:true});
  }else syncPlayerToRoom();
}
function syncPlayerToRoom(){
  const room=state.room;
  if(!getSelection(room) || !player.src || player.readyState<1)return;
  const duration=Number.isFinite(player.duration)?player.duration:0;
  const target=Math.min(duration||864000,Math.max(0,expectedPosition(room)));
  if(Math.abs(player.currentTime-target)>1.25 && !state.scrubbing){
    try{player.currentTime=target;}catch(_){}
  }
  if(room.is_playing && (!duration || target<duration-.15)){
    const promise=player.play();
    if(promise && typeof promise.catch==="function"){
      promise.then(()=>{$("joinPlaybackBtn").hidden=true;})
        .catch(()=>{$("joinPlaybackBtn").hidden=false;});
    }
  } else {
    player.pause();$("joinPlaybackBtn").hidden=true;
  }
  $("playPauseBtn").textContent=room.is_playing?"Ⅱ":"▶";
  $("playPauseBtn").setAttribute("aria-label",room.is_playing?"Pause for everyone":"Play for everyone");
  updateClock();
}

function updateClock() {
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const current = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  if (!state.scrubbing) {
    $("seekBar").value = duration > 0 ? String(Math.min(1000, current / duration * 1000)) : "0";
    $("currentTime").textContent = formatTime(current);
  }
  $("duration").textContent = formatTime(duration);
}
async function subscribeRoom(roomId) {
  if (!state.user || !state.room || state.room.id !== roomId) return;
  await db.realtime.setAuth((await db.auth.getSession()).data.session?.access_token);
  const channel = db.channel("watch:" + roomId, { config: { private: true, presence: { key: state.user.id } } });
  channel
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "watch_rooms", filter: "id=eq." + roomId }, (payload) => {
      if (payload.new) applyPlayback(payload.new).catch((err) => notify(err.message));
    })
    .on("presence", { event: "sync" }, () => renderPresence(channel.presenceState()));
  state.channel = channel;
  channel.subscribe(async (status, err) => {
    if (state.channel !== channel) return;
    if (status === "SUBSCRIBED") {
      await channel.track({ userId: state.user.id, name: displayName(), avatar: avatarUrl(state.user) });
      $("syncStatus").innerHTML = '<span class="dot"></span> In sync';
      // Refresh state after subscribing to close the fetch/subscribe race.
      const { data } = await db.from("watch_rooms").select("*").eq("id", roomId).single();
      if (data && state.room?.id === roomId) applyPlayback(data).catch(console.error);
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      $("syncStatus").textContent = "Disconnected";
      notify(err?.message || "Realtime connection failed. Try refreshing.");
    }
  });
}
function renderPresence(presences) {
  const list = $("peopleList"); list.replaceChildren();
  const map = new Map();
  Object.values(presences || {}).flat().forEach((person) => { if (person.userId) map.set(person.userId, person); });
  $("peopleCount").textContent = String(map.size);
  if (!map.size) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "Nobody online yet."; list.append(p); return; }
  map.forEach((person) => {
    const row = document.createElement("div"); row.className = "person";
    const img = document.createElement("img");
    const avatar = typeof person.avatar === "string" && /^https:\/\/avatars\.githubusercontent\.com\//.test(person.avatar);
    if (avatar) { img.src = person.avatar; img.alt = ""; row.append(img); }
    else { const initial = document.createElement("span"); initial.className = "person-initial"; initial.textContent = (person.name || "?").charAt(0).toUpperCase(); row.append(initial); }
    const name = document.createElement("span"); name.textContent = String(person.name || "Movie lover").slice(0, 70) + (person.userId === state.user?.id ? " (you)" : "");
    const indicator = document.createElement("i"); indicator.title = "Online";
    row.append(name,indicator); list.append(row);
  });
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); notify("Copied to clipboard."); }
  catch (_) { notify("Copy failed. Try using your browser's address bar."); }
}
async function boot() {
  $("loginBtn").addEventListener("click",()=>{
    show("loginView");
    $("chooseKittu").focus();
  });
  $("chooseKittu").addEventListener("click",()=>selectPersona("Kittu"));
  $("chooseSubbu").addEventListener("click",()=>selectPersona("Subbu"));
  $("heroLoginBtn").addEventListener("click", signIn);
  $("featuredStartBtn").addEventListener("click",()=>{
    const id=$("featuredStartBtn").dataset.movieId;
    const movie=dashboardMovieData.find(x=>x.id===id)||null;
    startMovieNight(movie);
  });
  $("logoutBtn").addEventListener("click", signOut);
  $("createForm").addEventListener("submit", createRoom);
  $("joinForm").addEventListener("submit", joinForm);
  $("refreshRoomsBtn").addEventListener("click", loadMyRooms);
  $("backBtn").addEventListener("click", dashboard);
  $("leaveSeatBtn").addEventListener("click", leaveSeat);
  $("refreshLibraryRoom").addEventListener("click", loadVideos);
  $("refreshLibraryDashboard").addEventListener("click",loadLibraryDashboard);
  $("copyInviteBtn").addEventListener("click", () => {
    if (state.room) copyText(location.origin + location.pathname + "?join=" + encodeURIComponent(state.room.invite_code));
  });
  $("copyCodeBtn").addEventListener("click", () => { if (state.room) copyText(state.room.invite_code); });
  $("playPauseBtn").addEventListener("click", () => {
    const selection=getSelection(state.room);
    if(!selection)return;
    if(!state.room.is_playing)player.play().catch(()=>{});
    sendControl(selection,player.currentTime||expectedPosition(state.room),!state.room.is_playing);
  });
  $("joinPlaybackBtn").addEventListener("click", () => {
    player.play().then(() => { $("joinPlaybackBtn").hidden = true; }).catch(() => notify("Playback unavailable on this device."));
  });
  $("seekBar").addEventListener("input", (event) => {
    state.scrubbing = true;
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    $("currentTime").textContent = formatTime(duration * Number(event.target.value) / 1000);
  });
  $("seekBar").addEventListener("change", (event) => {
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    const target = duration * Number(event.target.value) / 1000;
    state.scrubbing = false;
    const selection=getSelection(state.room);
    if(selection){
      player.currentTime=target;
      sendControl(selection,target,state.room.is_playing);
    }
  });
  $("muteBtn").addEventListener("click", () => {
    player.muted = !player.muted;
    $("muteBtn").textContent = player.muted ? "◖×" : "◖))";
  });
  $("fullscreenBtn").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else $("player").requestFullscreen?.().catch(() => notify("Fullscreen isn't supported here."));
  });
  player.addEventListener("timeupdate", updateClock);
  player.addEventListener("loadedmetadata", updateClock);
  player.addEventListener("error",()=>{
    if(!player.getAttribute("src"))return;
    const selection=getSelection(state.room);
    const video=state.videos.find(v=>v.id===selection);
    notify(video?.isMkv
      ? "This MKV cannot play in your browser. Convert it to H.264/AAC MP4 and upload the MP4 to Supabase."
      : "Unable to play this video. Try an H.264/AAC MP4.");
  });
  player.addEventListener("ended", () => {
    const selection=getSelection(state.room);
    if(state.room?.is_playing && selection)sendControl(selection,player.duration||0,false);
  });
  let heartbeatPending = false;
  setInterval(async () => {
    if (!state.room || heartbeatPending) return;
    heartbeatPending = true;
    try { await keepSeatAlive(); } catch (err) { console.warn("Seat heartbeat failed", err); }
    finally { heartbeatPending = false; }
  }, 20000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.room && !heartbeatPending) {
      heartbeatPending = true;
      keepSeatAlive().catch(console.error).finally(() => { heartbeatPending = false; });
    }
  });
  setInterval(() => {
    if (getSelection(state.room) && document.visibilityState === "visible" && player.readyState >= 1) {
      // Correct drift, but never send a network write during this local adjustment.
      const target = expectedPosition(state.room);
      if (Math.abs(player.currentTime - target) > 2.5) syncPlayerToRoom();
    }
  }, 5000);
  db.auth.onAuthStateChange((event) => {
    if(event==="SIGNED_OUT"){state.user=null;state.persona=null;show("loginView");}
  });
  const { data: { user }, error } = await db.auth.getUser();
  if (error && error.name !== "AuthSessionMissingError") console.warn(error.message);
  if(!user){show("loginView");return;}
  let persona;
  try{persona=await fetchPersona(user.id);}catch(err){console.error(err);}
  if(!persona){show("loginView");return;}
  state.user=user;state.persona=persona;
  $("userName").textContent=displayName();
  safeAvatar($("userAvatar"),avatarUrl(user),displayName());
  show("dashboardView");
  const params = new URLSearchParams(location.search);
  if (params.has("join")) await joinByCode(params.get("join"));
  else if (params.has("room")) await openRoom(params.get("room"));
  else await Promise.all([loadMyRooms(),loadLibraryDashboard()]);
}
boot().catch((err) => notify(err.message || "Something went wrong."));
