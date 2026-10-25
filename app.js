import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.0/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const $ = (id) => document.getElementById(id);
const state = { user: null, room: null, videos: [], channel: null, sourceVideoId: null, applyToken: 0, scrubbing: false, lastAppliedRevision: -1 };
let toastTimer = null;
const player = $("player");

function notify(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}
function displayName(user) {
  return user?.user_metadata?.display_name || user?.user_metadata?.user_name || "Guest";
}
function avatarUrl(user) { return user?.user_metadata?.avatar_url || ""; }
function show(view) {
  ["loginView", "dashboardView", "roomView"].forEach((id) => { $(id).hidden = id !== view; });
  $("loginBtn").hidden = !!state.user;
  $("userBar").hidden = !state.user;
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
async function signIn() {
  const button = $("heroLoginBtn");
  if (button.disabled) return;
  setBusy(button, true, "Entering…");
  try {
    const requested = $("guestName").value.trim().slice(0, 28);
    const name = requested || "Guest " + Math.floor(1000 + Math.random() * 9000);
    const { data, error } = await db.auth.signInAnonymously({ options: { data: { display_name: name } } });
    if (error) throw error;
    state.user = data.user;
    $("userName").textContent = displayName(data.user);
    safeAvatar($("userAvatar"), avatarUrl(data.user), displayName(data.user));
    const params = new URLSearchParams(location.search);
    if (params.has("join")) await joinByCode(params.get("join"));
    else if (params.has("room")) await openRoom(params.get("room"));
    else await dashboard();
  } catch (err) {
    console.error(err);
    notify("Guest entry failed: " + (err.message || "Unknown error") + ". Enable Anonymous Sign-ins in Supabase Authentication → Providers.");
  } finally { setBusy(button, false); }
}
async function signOut() {
  if (state.room) await db.rpc("leave_watch_room", { p_room_id: state.room.id });
  await leaveRoom();
  const { error } = await db.auth.signOut();
  if (error) { notify(error.message); return; }
  state.user = null;
  clearRoute(); show("loginView");
}
async function loadMyRooms() {
  const { data, error } = await db.from("watch_rooms").select("id,name,invite_code,created_at").order("created_at", { ascending: false });
  if (error) { notify(error.message); return; }
  const list = $("roomsList");
  list.replaceChildren();
  if (!data?.length) {
    const empty = document.createElement("div");
    empty.className = "muted-panel";
    empty.textContent = "No rooms yet. Create one above to start your first screening.";
    list.append(empty); return;
  }
  data.forEach((room) => {
    const card = document.createElement("button");
    card.type = "button"; card.className = "room-card";
    card.innerHTML = '<div class="room-card-icon"><span>▣</span><span>↗</span></div>';
    const name = document.createElement("h3"); name.textContent = room.name;
    const date = document.createElement("p"); date.textContent = "Private screening · " + new Date(room.created_at).toLocaleDateString();
    card.append(name, date);
    card.addEventListener("click", () => openRoom(room.id));
    list.append(card);
  });
}
async function dashboard() {
  await leaveRoom();
  clearRoute();
  show("dashboardView");
  await loadMyRooms();
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
async function loadVideos() {
  if (!state.room) return;
  const roomId = state.room.id;
  const { data, error } = await db.from("watch_videos").select("*").eq("room_id", roomId).order("created_at", { ascending: false });
  if (error) { notify(error.message); return; }
  if (!state.room || state.room.id !== roomId) return;
  state.videos = data || [];
  renderVideos();
}
function renderVideos() {
  const list = $("videosList"); list.replaceChildren();
  $("videoCount").textContent = String(state.videos.length);
  if (!state.videos.length) {
    const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "No videos yet. Upload one below."; list.append(empty); return;
  }
  state.videos.forEach((video) => {
    const item = document.createElement("button"); item.type = "button";
    item.className = "video-item" + (state.room?.video_id === video.id ? " selected" : "");
    const ico = document.createElement("span"); ico.className = "video-item-icon"; ico.textContent = "▶";
    const body = document.createElement("span"); body.className = "video-item-main";
    const title = document.createElement("strong"); title.textContent = video.title;
    const detail = document.createElement("small"); detail.textContent = (video.file_size / (1024 * 1024)).toFixed(1) + " MB";
    body.append(title,detail);
    const arrow = document.createElement("span"); arrow.className = "play-small"; arrow.textContent = state.room?.video_id === video.id ? "●" : "↗";
    item.append(ico,body,arrow);
    item.addEventListener("click", () => sendControl(video.id, 0, false));
    list.append(item);
  });
}
async function uploadVideo(event) {
  const input = event.target;
  const file = input.files?.[0];
  if (!file || !state.room) return;
  input.value = "";
  const type = file.type || (file.name.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4");
  if (!["video/mp4","video/webm"].includes(type)) return notify("Only MP4 and WebM videos are supported.");
  if (file.size > MAX_FILE_BYTES) return notify("This project currently supports videos up to 50 MB.");
  if (!file.size) return notify("That file is empty.");
  const roomId = state.room.id;
  const path = roomId + "/" + state.user.id + "/" + crypto.randomUUID() + (type === "video/webm" ? ".webm" : ".mp4");
  $("uploadStatus").textContent = "Uploading " + file.name + "… Please keep this tab open.";
  input.disabled = true;
  try {
    const { error: uploadError } = await db.storage.from("watch-videos").upload(path, file, { contentType: type, upsert: false });
    if (uploadError) throw uploadError;
    const title = file.name.replace(/\.[^.]+$/, "").slice(0, 180) || "Untitled video";
    const { data, error: rowError } = await db.from("watch_videos")
      .insert({ room_id: roomId, uploaded_by: state.user.id, object_path: path, title, mime_type: type, file_size: file.size })
      .select("*").single();
    if (rowError) throw rowError;
    if (state.room?.id === roomId) {
      await loadVideos();
      if (!state.room.video_id) await sendControl(data.id, 0, false);
    }
    $("uploadStatus").textContent = "Upload complete ✓";
    notify("Video uploaded to your private room.");
  } catch (err) {
    $("uploadStatus").textContent = "Upload failed: " + (err.message || "Unknown error");
    notify(err.message || "Upload failed");
  } finally { input.disabled = false; }
}
async function sendControl(videoId, position, playing) {
  if (!state.room || !videoId) return;
  const id = state.room.id;
  const safePosition = Math.min(864000, Math.max(0, Number(position) || 0));
  const { error } = await db.rpc("control_watch_room", {
    p_room_id: id, p_video_id: videoId, p_position: safePosition, p_is_playing: !!playing
  });
  if (error) { notify(error.message); return; }
  // Read after write as a fallback if the websocket is slow or reconnecting.
  const { data } = await db.from("watch_rooms").select("*").eq("id", id).single();
  if (data && state.room?.id === id && data.revision >= state.room.revision) await applyPlayback(data);
}
async function applyPlayback(incoming) {
  if (!state.room || incoming.id !== state.room.id) return;
  if (incoming.revision < state.lastAppliedRevision) return;
  state.room = incoming;
  state.lastAppliedRevision = incoming.revision;
  $("syncStatus").innerHTML = '<span class="dot"></span> In sync';
  $("playPauseBtn").disabled = !incoming.video_id;
  $("seekBar").disabled = !incoming.video_id;
  renderVideos();
  if (!incoming.video_id) {
    $("playerEmpty").hidden = false; player.hidden = true;
    $("nowPlayingTitle").textContent = "No video selected"; return;
  }
  let video = state.videos.find((v) => v.id === incoming.video_id);
  if (!video) {
    await loadVideos();
    video = state.videos.find((v) => v.id === incoming.video_id);
    if (!video) return;
  }
  $("nowPlayingTitle").textContent = video.title;
  $("playerEmpty").hidden = true;
  player.hidden = false;
  if (state.sourceVideoId !== incoming.video_id) {
    const token = ++state.applyToken;
    state.sourceVideoId = incoming.video_id;
    player.pause(); player.removeAttribute("src");
    $("joinPlaybackBtn").hidden = true;
    const { data, error } = await db.storage.from("watch-videos").createSignedUrl(video.object_path, 3600);
    if (token !== state.applyToken || state.room?.video_id !== incoming.video_id) return;
    if (error || !data?.signedUrl) {
      state.sourceVideoId = null;
      notify(error?.message || "Couldn't load private video"); return;
    }
    player.src = data.signedUrl;
    player.load();
    player.addEventListener("loadedmetadata", () => syncPlayerToRoom(), { once: true });
  } else {
    syncPlayerToRoom();
  }
}
function syncPlayerToRoom() {
  const room = state.room;
  if (!room?.video_id || !player.src || player.readyState < 1) return;
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const target = Math.min(duration || 864000, Math.max(0, expectedPosition(room)));
  if (Math.abs(player.currentTime - target) > 1.25 && !state.scrubbing) {
    try { player.currentTime = target; } catch (_) {}
  }
  if (room.is_playing && (!duration || target < duration - .15)) {
    const promise = player.play();
    if (promise && typeof promise.catch === "function") {
      promise.then(() => { $("joinPlaybackBtn").hidden = true; })
        .catch(() => { $("joinPlaybackBtn").hidden = false; });
    }
  } else { player.pause(); $("joinPlaybackBtn").hidden = true; }
  $("playPauseBtn").textContent = room.is_playing ? "Ⅱ" : "▶";
  $("playPauseBtn").setAttribute("aria-label", room.is_playing ? "Pause for everyone" : "Play for everyone");
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
      await channel.track({ userId: state.user.id, name: displayName(state.user), avatar: avatarUrl(state.user) });
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
  $("loginBtn").addEventListener("click", signIn);
  $("heroLoginBtn").addEventListener("click", signIn);
  $("logoutBtn").addEventListener("click", signOut);
  $("createForm").addEventListener("submit", createRoom);
  $("joinForm").addEventListener("submit", joinForm);
  $("refreshRoomsBtn").addEventListener("click", loadMyRooms);
  $("backBtn").addEventListener("click", dashboard);
  $("leaveSeatBtn").addEventListener("click", leaveSeat);
  $("videoFile").addEventListener("change", uploadVideo);
  $("copyInviteBtn").addEventListener("click", () => {
    if (state.room) copyText(location.origin + location.pathname + "?join=" + encodeURIComponent(state.room.invite_code));
  });
  $("copyCodeBtn").addEventListener("click", () => { if (state.room) copyText(state.room.invite_code); });
  $("playPauseBtn").addEventListener("click", () => {
    if (!state.room?.video_id) return;
    if (!state.room.is_playing) player.play().catch(() => {});
    sendControl(state.room.video_id, player.currentTime || expectedPosition(state.room), !state.room.is_playing);
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
    if (state.room?.video_id) {
      player.currentTime = target;
      sendControl(state.room.video_id, target, state.room.is_playing);
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
  player.addEventListener("error", () => { if (player.getAttribute("src")) notify("Unable to play this video. Try an H.264 MP4 or WebM."); });
  player.addEventListener("ended", () => {
    if (state.room?.is_playing && state.room.video_id) sendControl(state.room.video_id, player.duration || 0, false);
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
    if (state.room?.video_id && document.visibilityState === "visible" && player.readyState >= 1) {
      // Correct drift, but never send a network write during this local adjustment.
      const target = expectedPosition(state.room);
      if (Math.abs(player.currentTime - target) > 2.5) syncPlayerToRoom();
    }
  }, 5000);
  db.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") { state.user = null; show("loginView"); }
  });
  const { data: { user }, error } = await db.auth.getUser();
  if (error && error.name !== "AuthSessionMissingError") console.warn(error.message);
  if (!user) { show("loginView"); return; }
  state.user = user;
  $("userName").textContent = displayName(user);
  $("guestName").value = displayName(user);
  const img = $("userAvatar"); safeAvatar(img, avatarUrl(user), displayName(user));
  show("dashboardView");
  const params = new URLSearchParams(location.search);
  if (params.has("join")) await joinByCode(params.get("join"));
  else if (params.has("room")) await openRoom(params.get("room"));
  else await loadMyRooms();
}
boot().catch((err) => notify(err.message || "Something went wrong."));
