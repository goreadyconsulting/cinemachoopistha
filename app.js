import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.0/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const db=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
const BUCKET="cinema-library";
// Current collection gets immediately-available artwork; new titles can resolve
// through Wikipedia's public PageImages API (no private API keys in GitHub).
const CURATED_POSTERS={
  antesundaraniki:"https://assets.gadgets360cdn.com/pricee/assets/product/202203/Ante-Sundharaniki-Poster_1648055227.jpg",
  walle:"https://filmartgallery.com/cdn/shop/files/WALL-E-Vintage-Movie-Poster-Original_af15a6df.jpg?v=1741753990",
  dc:"https://fr.web.img5.acsta.net/img/b1/6a/b16a65e4c8f1f36aaa2ab321fdae9f5e.jpg"
};
const WIKIPEDIA_PAGES={
  antesundaraniki:"Ante Sundaraniki",
  walle:"WALL-E",
  dc:"DC (film)"
};
const posterLookupCache=new Map();
const FALLBACK_POSTER="./cinema-night.svg";
const $=(id)=>document.getElementById(id);
const player=$("player");
const state={ user:null,persona:null,selectedPersona:null,room:null,channel:null,movies:[],status:null,
  sourcePath:null,token:0,revision:-1,scrubbing:false,joining:false,heartbeat:false,
  pendingPlay:false,subtitleNames:[],chatOpen:false,chatUnread:0,chatLastId:0,
  chatSeenIds:new Set(),chatSending:false,chatLoading:false,skipBusy:false,
  mode:null,lobby:null,lobbyRenderKey:"",lobbyEntering:false,lobbyPolling:false,
  soloLastSaved:0 };
let toastTimer=null;

function inform(message){
  $("toast").textContent=message;
  $("toast").hidden=false;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>$("toast").hidden=true,4400);
}
function show(view){
  for(const id of ["loadingView","loginView","modeView","lobbyView","homeView","watchView"])
    $(id).hidden=id!==view;
  $("topActions").hidden=view==="loginView"||view==="loadingView";
  document.body.dataset.screen=view;
  document.body.dataset.mode=state.mode||"";
  if(view==="watchView")resetPlayerControls();
  else clearPlayerControlsTimer();
  if(state.persona){
    $("signedInName").textContent=state.persona;
    $("switchProfileBtn").textContent=state.persona.charAt(0);
    $("switchProfileBtn").style.background=state.persona==="Kittu"
      ?"linear-gradient(145deg,#bd4967,#5b3457)"
      :"linear-gradient(145deg,#8975b9,#435278)";
  }
  window.scrollTo({top:0,behavior:"auto"});
}

let controlsHideTimer=null;
let controlsPointerDown=false;
let keyboardFocusControls=false;
let keyboardNavigation=false;

function updatePlayerIndicators(){
  const cc=Array.from(player.textTracks||[]).some(track=>
    (track.kind==="subtitles"||track.kind==="captions")&&track.mode==="showing"
  );
  const muted=player.muted||player.volume===0;
  const pip=!!document.pictureInPictureElement;
  const fullscreen=!!document.fullscreenElement||!!player.webkitDisplayingFullscreen;
  const captions=$("captionsBtn"),mute=$("muteBtn"),pipButton=$("pipBtn"),full=$("fullscreenBtn");
  captions.classList.toggle("active",cc);
  captions.setAttribute("aria-pressed",String(cc));
  captions.setAttribute("aria-label",cc?"Turn subtitles off":"Turn subtitles on");
  mute.classList.toggle("active",muted);
  mute.setAttribute("aria-pressed",String(muted));
  mute.setAttribute("aria-label",muted?"Unmute":"Mute");
  mute.querySelector(".sound-on").hidden=muted;
  mute.querySelector(".sound-off").hidden=!muted;
  pipButton.classList.toggle("active",pip);
  pipButton.setAttribute("aria-pressed",String(pip));
  full.classList.toggle("active",fullscreen);
  full.setAttribute("aria-pressed",String(fullscreen));
  full.setAttribute("aria-label",fullscreen?"Exit fullscreen":"Fullscreen");
}
function updatePlayPauseIndicator(isPlaying){
  // The shared room is authoritative, rather than the local video element.
  const btn=$("playPauseBtn");
  const playing=Boolean(isPlaying);
  btn.querySelector(".music-icon-play").hidden=playing;
  btn.querySelector(".music-icon-pause").hidden=!playing;
  btn.classList.toggle("active",playing);
  btn.setAttribute("aria-pressed",String(playing));
  btn.setAttribute("aria-label",playing?"Pause movie":"Play movie");
  btn.title=playing?"Pause":"Play";
}
function playerControlsPinned(){
  return !$("watchView").hidden && (
    !state.room?.library_path || !state.room.is_playing ||
    player.paused || state.scrubbing ||
    !$("loadingVideo").hidden || !$("localPlayBtn").hidden ||
    controlsPointerDown || keyboardFocusControls
  );
}
function clearPlayerControlsTimer(){
  if(controlsHideTimer!==null){
    clearTimeout(controlsHideTimer);
    controlsHideTimer=null;
  }
}
function revealPlayerControls(){
  clearPlayerControlsTimer();
  const shell=$("playerShell");
  if($("watchView").hidden)return;
  shell.classList.add("controls-visible");
  if(!playerControlsPinned()){
    controlsHideTimer=setTimeout(()=>{
      controlsHideTimer=null;
      if(!playerControlsPinned())shell.classList.remove("controls-visible");
    },3000);
  }
}
function refreshPlayerControls(){
  if($("watchView").hidden)return;
  revealPlayerControls();
}
function resetPlayerControls(){
  clearPlayerControlsTimer();
  controlsPointerDown=false;
  keyboardFocusControls=false;
  keyboardNavigation=false;
  $("playerShell").classList.add("controls-visible");
}

function formatTime(n){
  const s=Math.max(0,Math.floor(Number.isFinite(n)?n:0));
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=String(s%60).padStart(2,"0");
  return h? h+":"+String(m).padStart(2,"0")+":"+sec:m+":"+sec;
}
function formatSize(n){
  const size=Number(n)||0;
  return size>=1024**3?(size/1024**3).toFixed(1)+" GB":Math.round(size/1024**2)+" MB";
}
function fileTitle(name){
  const clean=name.replace(/\.(mp4|mkv|webm)$/i,"").replace(/[._-]+/g," ").replace(/\s+/g," ").trim();
  const named=clean.match(/^(.*?)\s+((?:19|20)\d{2})(?:\s|$)/);
  if(named && named[1].trim())return named[1].trim()+" ("+named[2]+")";
  const raw=clean.replace(/\s+(1080p|720p|2160p|HEVC|WEB DL|BluRay|x264|x265|DDP5).*$/i,"").trim();
  if(/^wall\s*e$/i.test(raw))return "WALL·E (2008)";
  if(/^dc$/i.test(raw))return "DC (2026)";
  return raw||"Untitled movie";
}
function posterKey(movie){
  return (movie?.title||"").replace(/\((?:19|20)\d{2}\)/g,"")
    .toLowerCase().replace(/[^a-z0-9]/g,"");
}
function coverUrl(movie){
  return movie?.posterUrl||CURATED_POSTERS[posterKey(movie)]||FALLBACK_POSTER;
}
function wikipediaPosterUrl(url){
  try {
    const parsed=new URL(url);
    // Restrict auto-sourced artwork to Wikimedia image CDNs.
    if(parsed.protocol==="https:"&&(
      parsed.hostname==="upload.wikimedia.org"||
      parsed.hostname==="commons.wikimedia.org"
    ))return parsed.href;
  }catch(_){}
  return null;
}
async function findWikipediaPoster(movie){
  const key=posterKey(movie);
  if(!key || key.length<3 && key!=="dc")return null;
  const page=WIKIPEDIA_PAGES[key];
  let request;
  const params=new URLSearchParams({
    action:"query",format:"json",origin:"*",
    prop:"pageimages",piprop:"thumbnail",
    pithumbsize:"640",pilicense:"any"
  });
  if(page){
    params.set("titles",page);
    request="https://en.wikipedia.org/w/api.php?"+params;
  }else{
    const name=movie.title.replace(/\((?:19|20)\d{2}\)/g,"").trim();
    const year=movie.title.match(/\b(19\d{2}|20\d{2})\b/)?.[1]||"";
    // Give search enough context to distinguish films from songs/TV entries.
    params.set("generator","search");
    params.set("gsrsearch",name+" "+year+" film");
    params.set("gsrlimit","8");
    request="https://en.wikipedia.org/w/api.php?"+params;
  }
  const response=await fetch(request,{mode:"cors",credentials:"omit"});
  if(!response.ok)throw Error("Poster lookup failed");
  const result=await response.json();
  const pages=Object.values(result?.query?.pages||{}).filter(p=>p.thumbnail?.source);
  if(page)return wikipediaPosterUrl(pages.find(p=>p.title.toLowerCase()===page.toLowerCase())?.thumbnail?.source||
    pages[0]?.thumbnail?.source);
  const norm=(s)=>s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g,"");
  const wanted=norm(movie.title.replace(/\((?:19|20)\d{2}\)/g,""));
  const year=movie.title.match(/\b(19\d{2}|20\d{2})\b/)?.[1]||"";
  if(wanted.length<4)return null;
  const candidates=pages.filter(p=>{
    const title=norm(p.title);
    if(!title.startsWith(wanted))return false;
    const statedYear=p.title.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
    if(year && statedYear && year!==statedYear)return false;
    return /film|movie|\b(?:19|20)\d{2}\b/i.test(p.title);
  });
  candidates.sort((a,b)=>{
    const ay=year && a.title.includes(year)?1:0;
    const by=year && b.title.includes(year)?1:0;
    return by-ay;
  });
  return wikipediaPosterUrl(candidates[0]?.thumbnail?.source);
}
function lookupPoster(movie){
  if(movie?.localPosterUrl)return Promise.resolve(movie.localPosterUrl);
  const key=(movie?.title||"").toLowerCase();
  if(!posterLookupCache.has(key)){
    posterLookupCache.set(key,findWikipediaPoster(movie).catch(()=>null));
  }
  return posterLookupCache.get(key);
}
function setPoster(img,movie){
  // Local artwork in the private Supabase bucket always takes precedence.
  // A curated poster covers known films; Wikipedia helps new ones.
  const source=coverUrl(movie);
  const isFeature=img.id==="featurePoster";
  img.onload=()=>{
    if(isFeature && state.movies[0]?.path===movie?.path){
      $("featureBackdrop").style.backgroundImage="url("+JSON.stringify(img.src)+")";
    }
  };
  img.onerror=()=>{
    img.onerror=null;
    if(source===FALLBACK_POSTER){return;}
    // If a hotlinked image goes away, try a different verified source.
    if(movie && !movie.localPosterUrl){
      lookupPoster(movie).then(found=>{
        if(!img.isConnected)return;
        if(found && found!==img.src){img.onerror=()=>{img.onerror=null;img.src=FALLBACK_POSTER;};img.src=found;}
        else img.src=FALLBACK_POSTER;
      });
    }else img.src=FALLBACK_POSTER;
  };
  img.src=source;
}
function makeMovieImage(movie){
  const img=document.createElement("img");
  img.loading="lazy";img.decoding="async";
  img.alt=movie.title+" poster";
  img.dataset.posterPath=movie.path;
  setPoster(img,movie);
  return img;
}
function refreshResolvedPosters(){
  for(const img of document.querySelectorAll("[data-poster-path]")){
    const movie=state.movies.find(m=>m.path===img.dataset.posterPath);
    if(movie)setPoster(img,movie);
  }
  if(state.movies[0])setPoster($("featurePoster"),state.movies[0]);
}
function loadAutomaticPosters(movies){
  for(const movie of movies){
    if(movie.localPosterUrl || CURATED_POSTERS[posterKey(movie)])continue;
    lookupPoster(movie).then(url=>{
      if(!url || !state.movies.some(m=>m.path===movie.path))return;
      movie.posterUrl=url;
      refreshResolvedPosters();
    });
  }
}
function currentMovie(){
  const path=state.room?.library_path;
  if(!path)return null;
  return state.movies.find(m=>m.path===path)||
    {path,title:fileTitle(path),size:0,mkv:isMkv(path)};
}
function wantedPosition(room){
  if(!room)return 0;
  const elapsed=room.is_playing?Math.max(0,(Date.now()-Date.parse(room.playback_updated_at))/1000):0;
  return Math.max(0,Number(room.position_seconds||0)+elapsed);
}
function isMkv(name){return /\.mkv$/i.test(name||"");}

async function readMovies(){
  const {data,error}=await db.storage.from(BUCKET).list("",{limit:100,sortBy:{column:"name",order:"asc"}});
  if(error)throw error;
  const entries=(data||[]).filter(f=>f.id && /\.(mp4|webm|mkv)$/i.test(f.name||""))
    .map(f=>({path:f.name,title:fileTitle(f.name),size:Number(f.metadata?.size||0),mkv:isMkv(f.name)}));
  const byTitle=new Map();
  for(const movie of entries){
    const key=movie.title.toLowerCase();
    const prior=byTitle.get(key);
    if(!prior||prior.mkv&&!movie.mkv)byTitle.set(key,movie);
  }
  const movies=[...byTitle.values()].sort((a,b)=>a.title.localeCompare(b.title));
  const imageNames=new Set((data||[]).filter(f=>f.id&&/\.(jpe?g|png|webp)$/i.test(f.name||""))
    .map(f=>f.name));
  await Promise.all(movies.map(async movie=>{
    const base=movie.path.replace(/\.(mp4|webm|mkv)$/i,"");
    const candidates=[".poster.jpg",".poster.jpeg",".poster.png",".poster.webp",
      ".jpg",".jpeg",".png",".webp"];
    const match=candidates.map(ext=>base+ext).find(name=>imageNames.has(name));
    if(!match)return;
    const {data:signed,error:signError}=await db.storage.from(BUCKET).createSignedUrl(match,21600);
    if(!signError && signed?.signedUrl){
      movie.localPosterUrl=signed.signedUrl;movie.posterUrl=signed.signedUrl;
    }
  }));
  return movies;
}
async function refreshMovies(){
  try{
    const movies=await readMovies();
    state.movies=movies;
    renderHome(movies);
    renderWatchShelf(movies);
    loadAutomaticPosters(movies);
    if(state.room?.library_path)updatePlayingTitle();
    return movies;
  }catch(err){
    inform("Couldn't open the movie library. "+(err?.message||"Try refreshing."));
    $("movieGrid").replaceChildren();
    const p=document.createElement("p");p.className="empty-library";p.textContent="Movies couldn't load. Try Refresh.";
    $("movieGrid").append(p);
    return state.movies;
  }
}
function filmCard(movie){
  const card=document.createElement("button");
  card.className="movie-card";card.type="button";
  card.setAttribute("aria-label","Watch "+movie.title);
  const cover=document.createElement("span");cover.className="movie-card-cover";
  cover.append(makeMovieImage(movie));
  const name=document.createElement("span");name.className="movie-title";name.textContent=movie.title;
  const format=document.createElement("span");format.className="movie-format";
  format.textContent=movie.mkv?"MKV · may not play":formatSize(movie.size);
  card.append(cover,name,format);
  card.addEventListener("click",()=>startSolo(movie).catch(err=>inform(err.message)));
  return card;
}
function renderHome(movies){
  const grid=$("movieGrid");grid.replaceChildren();
  if(!movies.length){
    const p=document.createElement("p");p.className="empty-library";
    p.textContent="No movies in the library yet.";grid.append(p);
  } else for(const movie of movies)grid.append(filmCard(movie));
  const featured=movies[0]||null;
  $("featureTitle").textContent=featured?.title||"Movie night";
  $("featureMeta").textContent=featured
    ?(featured.title.match(/\((\d{4})\)/)?.[1]||"Movie")+"  ·  "+formatSize(featured.size)
    :"Just the two of us";
  $("featureDescription").textContent=featured
    ?"Pick a film and enjoy your own private screening.":"Add a movie to start your private screening.";
  setPoster($("featurePoster"),featured);
  $("featureBackdrop").style.backgroundImage="url("+JSON.stringify(FALLBACK_POSTER)+")";
  $("watchTogetherBtn").disabled=!featured;
}
function renderWatchShelf(movies){
  const grid=$("watchMovieGrid");grid.replaceChildren();
  for(const movie of movies){
    const item=document.createElement("button");item.className="watch-movie-item";item.type="button";
    if(movie.path===state.room?.library_path)item.classList.add("selected");
    item.setAttribute("aria-label","Play "+movie.title);
    const img=makeMovieImage(movie);
    const detail=document.createElement("span");detail.textContent=movie.title;
    if(movie.mkv){
      const note=document.createElement("small");note.className="movie-mkv";note.textContent=" · MKV";
      detail.append(note);
    }
    item.append(img,detail);
    item.addEventListener("click",()=>selectMovie(movie));
    grid.append(item);
  }
}
async function readStatus(){
  const {data,error}=await db.rpc("get_cinema_status");
  if(error)throw error;
  state.status=data;
  updateHomePresence();
  if(!$("watchView").hidden)updatePresence(data.active||[]);
  return data;
}
function updateHomePresence(){
  const s=state.status;
  const active=s?.active||[];
  const other=active.find(p=>p!==state.persona);
  const progress=Number(s?.position_seconds||0);
  $("watchTogetherText").textContent="Play movie";
  $("homePresence").textContent=other?other+" is watching now.":"";
}
function updatePresence(names){
  for(const name of ["Kittu","Subbu"]){
    const node=$("presence"+name);
    node.classList.toggle("online",(names||[]).includes(name));
    node.setAttribute("title",(names||[]).includes(name)?name+" is here":name+" hasn't joined");
  }
}
async function showHome({release=true}={}){
  if(release && state.room)await leaveCinema();
  if(release){
    try{sessionStorage.removeItem("cinema-solo-path");}catch(_){}
  }
  state.mode="solo";
  try{sessionStorage.setItem("cinema-intent","solo");}catch(_){}
  show("homeView");
  await refreshMovies();
}
function choosePersona(persona){
  if(!["Kittu","Subbu"].includes(persona))return;
  state.selectedPersona=persona;
  $("profilePicker").hidden=true;
  $("pinStage").hidden=false;
  $("pinProfileName").textContent=persona;
  $("pinInitial").textContent=persona.charAt(0);
  $("pinAvatar").className="profile-avatar pin-avatar "+(persona==="Kittu"?"avatar-kittu":"avatar-subbu");
  $("pinInput").value="";
  $("entryMessage").textContent="";
  $("pinInput").focus();
}
function backToProfiles(){
  state.selectedPersona=null;
  $("pinInput").value="";
  $("pinStage").hidden=true;
  $("profilePicker").hidden=false;
  $("entryMessage").textContent="";
  $("chooseKittu").focus();
}
async function submitPin(event){
  event.preventDefault();
  if(state.joining || !state.selectedPersona)return;
  const value=$("pinInput").value.trim();
  if(!/^[0-9]{4}$/.test(value)){
    $("entryMessage").textContent="Enter your four-digit PIN.";
    return;
  }
  state.joining=true;
  $("pinSubmitBtn").disabled=true;
  $("pinSubmitBtn").textContent="Checking…";
  $("entryMessage").textContent="";
  try{
    let {data:{user}}=await db.auth.getUser();
    if(!user){
      const {data,error}=await db.auth.signInAnonymously();
      if(error)throw error;
      user=data.user;
    }
    const {data:approved,error:pinError}=await db.rpc("verify_cinema_pin",{
      p_persona:state.selectedPersona,
      p_pin:value
    });
    if(pinError)throw pinError;
    if(!approved){
      $("entryMessage").textContent="Incorrect PIN or temporarily locked. Please try again.";
      $("pinInput").value="";
      $("pinInput").focus();
      return;
    }
    state.user=user;
    state.persona=state.selectedPersona;
    state.selectedPersona=null;
    $("pinInput").value="";
    $("pinStage").hidden=true;
    $("profilePicker").hidden=false;
    showExperienceChooser();
  }catch(err){
    $("entryMessage").textContent=err?.message||"Couldn't sign in.";
  }finally{
    state.joining=false;
    $("pinSubmitBtn").disabled=false;
    $("pinSubmitBtn").innerHTML='Continue <span aria-hidden="true">→</span>';
  }
}
async function switchProfile(){
  if(state.room)await leaveCinema();
  if(state.mode==="together")await leaveLobby(true);
  const {error}=await db.auth.signOut();
  if(error){inform(error.message);return;}
  state.user=null;state.persona=null;state.selectedPersona=null;state.status=null;
  state.mode=null;state.lobby=null;
  try{sessionStorage.removeItem("cinema-intent");sessionStorage.removeItem("cinema-solo-path");}catch(_){} 
  $("pinInput").value="";
  $("pinStage").hidden=true;
  $("profilePicker").hidden=false;
  show("loginView");$("entryMessage").textContent="";
}

function showExperienceChooser(){
  state.mode=null;
  state.lobby=null;
  state.lobbyRenderKey="";
  try{
    sessionStorage.removeItem("cinema-intent");
    sessionStorage.removeItem("cinema-solo-path");
    sessionStorage.removeItem("cinema-open-watch");
  }catch(_){}
  $("modeGreeting").textContent="Hi "+(state.persona||"there")+" — what are we watching tonight?";
  show("modeView");
}
async function returnToChoices(){
  if(state.room)await leaveCinema();
  if(state.mode==="together")await leaveLobby(true);
  showExperienceChooser();
}
function soloSaveKey(path=state.room?.library_path){
  return "cinema-solo-progress-"+(state.persona||"guest")+"-"+encodeURIComponent(path||"");
}
function storeSoloProgress(force=false){
  if(state.mode!=="solo"||!state.room?.library_path)return;
  if(!force && Date.now()-state.soloLastSaved<5000)return;
  state.soloLastSaved=Date.now();
  try{
    localStorage.setItem(soloSaveKey(),JSON.stringify({
      path:state.room.library_path,
      position:player.readyState>=1?player.currentTime:
        Number(state.room.position_seconds||0)
    }));
  }catch(_){}
}
async function startSolo(movie){
  if(!movie?.path)return;
  if(state.room)await leaveCinema();
  state.mode="solo";
  state.sourcePath=null;
  state.revision=-1;
  state.soloLastSaved=0;
  let startingAt=0;
  try{
    const progress=JSON.parse(localStorage.getItem(soloSaveKey(movie.path))||"null");
    if(progress?.path===movie.path && Number.isFinite(Number(progress.position)))
      startingAt=Math.max(0,Number(progress.position));
    sessionStorage.setItem("cinema-intent","solo");
    sessionStorage.setItem("cinema-solo-path",movie.path);
  }catch(_){}
  state.room={
    id:"solo",library_path:movie.path,position_seconds:startingAt,
    is_playing:false,revision:0,playback_updated_at:new Date().toISOString()
  };
  show("watchView");
  $("backHomeBtn").textContent="← Movies";
  $("playingTitle").textContent=movie.title;
  $("playerNote").hidden=true;
  updatePlayerIndicators();
  await applyRoom({...state.room});
}


let lobbyQueue=Promise.resolve();
async function callLobby(action="status",movie=null){
  const request=async()=>{
    const {data,error}=await db.rpc("cinema_lobby_action",{
      p_action:action,p_movie:movie
    });
    if(error)throw error;
    return data;
  };
  const task=lobbyQueue.then(request,request);
  lobbyQueue=task.catch(()=>{});
  return task;
}
function findLobbyMovie(path){
  return state.movies.find(m=>m.path===path)||
    (path?{path,title:fileTitle(path),size:0,mkv:isMkv(path)}:null);
}
function renderLobby(){
  const lobby=state.lobby;
  if(!lobby||state.mode!=="together")return;
  const partner=state.persona==="Kittu"?"Subbu":"Kittu";
  const together=!!lobby.kittu_here&&!!lobby.subbu_here;
  $("lobbyKittu").classList.toggle("present",!!lobby.kittu_here);
  $("lobbySubbu").classList.toggle("present",!!lobby.subbu_here);
  $("lobbyKittuStatus").textContent=lobby.kittu_here?"Here with you":"Not here yet";
  $("lobbySubbuStatus").textContent=lobby.subbu_here?"Here with you":"Not here yet";
  if(!together){
    $("lobbyTitle").textContent="Waiting for "+partner+"…";
    $("lobbyHint").textContent="You're here. When "+partner+
      " joins, you'll each suggest a film and decide together.";
  }else if(lobby.phase==="watching"){
    $("lobbyTitle").textContent="It's a movie night ♥";
    $("lobbyHint").textContent="You both chose the same film. Opening your cinema…";
  }else{
    $("lobbyTitle").textContent="You're both here ♥";
    $("lobbyHint").textContent="Each pick a movie, then agree on your final choice.";
  }
  $("lobbyRecommendSection").hidden=!together||lobby.phase==="watching";
  $("lobbyVotingSection").hidden=!together||lobby.phase==="watching"||
    !lobby.kittu_pick||!lobby.subbu_pick;
  const yourPick=state.persona==="Kittu"?lobby.kittu_pick:lobby.subbu_pick;
  const yourVote=state.persona==="Kittu"?lobby.kittu_vote:lobby.subbu_vote;
  const theirVote=state.persona==="Kittu"?lobby.subbu_vote:lobby.kittu_vote;
  $("lobbyYourPick").textContent=yourPick
    ?"Your recommendation: "+(findLobbyMovie(yourPick)?.title||yourPick)+". Tap another poster to change it."
    :"Choose a film you'd love to watch.";
  if(!together||lobby.phase==="watching")return;
  const key=JSON.stringify({
    k:lobby.kittu_pick,s:lobby.subbu_pick,kv:lobby.kittu_vote,
    sv:lobby.subbu_vote,me:state.persona,paths:state.movies.map(m=>m.path)
  });
  if(state.lobbyRenderKey===key)return;
  state.lobbyRenderKey=key;
  const grid=$("lobbyMovieGrid");
  grid.replaceChildren();
  for(const movie of state.movies){
    const card=document.createElement("button");
    card.type="button";card.className="movie-card";
    if(yourPick===movie.path)card.classList.add("selected");
    card.setAttribute("aria-pressed",String(yourPick===movie.path));
    card.setAttribute("aria-label","Recommend "+movie.title);
    const cover=document.createElement("span");cover.className="movie-card-cover";
    cover.append(makeMovieImage(movie));
    const title=document.createElement("span");title.className="movie-title";
    title.textContent=movie.title;
    card.append(cover,title);
    card.addEventListener("click",()=>chooseLobbyMovie("propose",movie.path));
    grid.append(card);
  }
  const opts=$("lobbyVoteOptions");
  opts.replaceChildren();
  if(lobby.kittu_pick&&lobby.subbu_pick){
    const options=[...new Set([lobby.kittu_pick,lobby.subbu_pick])];
    for(const path of options){
      const movie=findLobbyMovie(path);
      const card=document.createElement("button");
      card.type="button";card.className="lobby-vote-card";
      if(yourVote===path)card.classList.add("chosen");
      card.setAttribute("aria-pressed",String(yourVote===path));
      const img=makeMovieImage(movie);
      img.alt="";img.loading="lazy";
      const detail=document.createElement("span");detail.className="lobby-vote-card-info";
      const title=document.createElement("strong");title.textContent=movie.title;
      const nominated=document.createElement("small");
      nominated.textContent=(lobby.kittu_pick===path&&lobby.subbu_pick===path)
        ?"Recommended by both":lobby.kittu_pick===path?"Kittu's pick":"Subbu's pick";
      const votes=document.createElement("small");
      votes.textContent="Votes: "+(lobby.kittu_vote===path?"Kittu ✓ ":"")+
        (lobby.subbu_vote===path?"Subbu ✓":"");
      detail.append(title,nominated,votes);
      card.append(img,detail);
      card.addEventListener("click",()=>chooseLobbyMovie("vote",path));
      opts.append(card);
    }
  }
  $("lobbyVoteNotice").textContent=yourVote&&theirVote&&yourVote!==theirVote
    ?"Different choices! Pick the same film to begin."
    :yourVote&&!theirVote?"Your choice is in. Waiting for "+partner+" to agree…"
    :!yourVote&&theirVote?partner+" has voted. Your turn!"
    :!lobby.kittu_pick||!lobby.subbu_pick?"Waiting for both recommendations."
    :"Both recommendations are in. Choose the one you'd like to watch.";
}
async function receiveLobby(data){
  if(state.mode!=="together")return;
  state.lobby=data;
  renderLobby();
  if(data?.phase==="watching"&&data?.joined&&
     !$("lobbyView").hidden&&!state.joining){
    await enterCinema();
  }else if(data?.phase!=="watching"&&!$("watchView").hidden&&state.room){
    await leaveCinema();
    show("lobbyView");
    renderLobby();
    inform("Your partner left the screening. Waiting in the lobby.");
  }
}
async function enterLobby(){
  if(state.lobbyEntering)return;
  state.lobbyEntering=true;
  state.mode="together";
  try{sessionStorage.setItem("cinema-intent","together");}catch(_){}
  show("lobbyView");
  $("lobbyTitle").textContent="Opening your movie-night lobby…";
  try{
    await refreshMovies();
    await receiveLobby(await callLobby("join"));
  }catch(err){
    inform(err?.message||"Unable to join the lobby.");
    showExperienceChooser();
  }finally{state.lobbyEntering=false;}
}
async function chooseLobbyMovie(action,path){
  if(state.mode!=="together"||$("lobbyView").hidden)return;
  try{
    await receiveLobby(await callLobby(action,path));
  }catch(err){inform(err?.message||"Couldn't update your choice.");}
}
async function leaveLobby(silent=false){
  if(state.lobby?.joined){
    try{await callLobby("leave");}
    catch(err){if(!silent)inform(err?.message||"Couldn't leave the lobby.");}
  }
  state.lobby=null;
  state.lobbyRenderKey="";
}
async function pollLobby(heartbeat=false){
  if(state.mode!=="together"||state.lobbyPolling||state.joining||
    ($("watchView").hidden && $("lobbyView").hidden))return;
  state.lobbyPolling=true;
  try{
    const data=await callLobby(heartbeat?"heartbeat":"status");
    if(!data?.joined && !$("lobbyView").hidden){
      await receiveLobby(await callLobby("join"));
    }else if(!data?.joined&&!$("watchView").hidden){
      await leaveCinema();
      show("lobbyView");
      await receiveLobby(await callLobby("join"));
    }else await receiveLobby(data);
  }catch(err){
    console.warn("Movie lobby:",err?.message||err);
  }finally{state.lobbyPolling=false;}
}

async function fetchRoom(id){
  const {data,error}=await db.from("watch_rooms").select("*").eq("id",id).single();
  if(error)throw error;
  return data;
}

async function enterCinema(){
  if(state.mode!=="together"||state.joining)return;
  state.joining=true;
  try{
    // A private, server-approved selection is required before joining the screen.
    const lobby=await callLobby("status");
    if(!lobby?.joined||lobby.phase!=="watching"||!lobby.selected_path)
      throw Error("Both of you must agree on a movie first.");
    state.lobby=lobby;
    const {data:id,error}=await db.rpc("enter_shared_cinema");
    if(error)throw error;
    const room=await fetchRoom(id);
    if(room.library_path!==lobby.selected_path)
      throw Error("The selected film changed. Return to the lobby.");
    state.room=room;state.revision=-1;state.sourcePath=null;
    try{sessionStorage.setItem("cinema-open-watch","1");}catch(_){}
    show("watchView");
    $("backHomeBtn").textContent="← Leave screening";
    updatePlayerIndicators();
    await refreshMovies();
    await applyRoom({...room});
    setChatOpen(false);
    await loadChatHistory(id);
    await subscribeCinema(id);
    await loadNewChat(id);
  }catch(err){
    inform(err?.message||"Couldn't open the cinema.");
    if(state.room)await leaveCinema();
    show("lobbyView");
    renderLobby();
  }finally{state.joining=false;}
}
async function leaveCinema(){
  if(state.mode==="solo")storeSoloProgress(true);
  resetPlayerControls();
  try{sessionStorage.removeItem("cinema-open-watch");}catch(_){}
  setChatOpen(false);
  resetChat();
  const wasThere=!!state.room;
  ++state.token;
  if(state.channel){
    const channel=state.channel;state.channel=null;
    try{await db.removeChannel(channel);}catch(err){console.warn(err);}
  }
  player.pause();player.removeAttribute("src");player.load();
  state.sourcePath=null;state.revision=-1;state.room=null;
  $("localPlayBtn").hidden=true;$("loadingVideo").hidden=true;
  if(wasThere && state.mode==="together"){
    const {error}=await db.rpc("leave_shared_cinema");
    if(error)console.warn("Could not release seat:",error.message);
  }
}
async function updateSharedPlayback(path,seconds,playing){
  if(!state.room)return;
  const secondsSafe=Math.max(0,Math.min(864000,Number(seconds)||0));
  if(state.mode==="solo"){
    const updated={...state.room,library_path:path,
      position_seconds:secondsSafe,is_playing:!!playing,
      playback_updated_at:new Date().toISOString(),
      revision:state.room.revision+1};
    if(updated.library_path!==state.room.library_path)state.sourcePath=null;
    await applyRoom(updated);
    storeSoloProgress(true);
    return;
  }
  const roomId=state.room.id;
  const {error}=await db.rpc("control_watch_library",{
    p_room_id:roomId,p_object_path:path,p_position:secondsSafe,p_is_playing:Boolean(playing)
  });
  if(error){inform(error.message);return;}
  // Read-after-write is also a fallback for Realtime connection delays.
  const latest=await fetchRoom(roomId);
  if(state.room?.id===roomId)await applyRoom(latest);
}
async function selectMovie(movie){
  if(!state.room)return;
  if(state.mode==="solo"){await startSolo(movie);return;}
  if(state.room.library_path===movie.path)return;
  if(state.room.is_playing && !window.confirm("Change the movie for both of you?"))return;
  await updateSharedPlayback(movie.path,0,false);
}
function updatePlayingTitle(){
  const movie=currentMovie();
  $("playingTitle").textContent=movie?.title||fileTitle(state.room?.library_path||"Our cinema");
  $("playerNote").hidden=!movie?.mkv;
  $("playerNote").textContent=movie?.mkv
    ?"This MKV may not play here. An H.264/AAC MP4 works best.":"";
  renderWatchShelf(state.movies);
}
async function applyRoom(incoming){
  if(!state.room || incoming?.id!==state.room.id)return;
  if(incoming.revision<state.revision)return;
  const playbackChanged=incoming.revision!==state.revision;
  const oldPath=state.room?.library_path;
  state.room=incoming;state.revision=incoming.revision;
  updatePlayingTitle();
  const path=incoming.library_path;
  $("playPauseBtn").disabled=!path;
  $("skipBackBtn").disabled=!path || state.skipBusy;
  $("skipForwardBtn").disabled=!path || state.skipBusy;
  $("seekBar").disabled=!path;
  updatePlayPauseIndicator(incoming.is_playing);
  if(playbackChanged)refreshPlayerControls();
  if(!path){
    player.pause();player.removeAttribute("src");player.load();
    state.sourcePath=null;
    $("playerEmpty").hidden=false;
    $("loadingVideo").hidden=true;
    return;
  }
  $("playerEmpty").hidden=true;
  if(path!==state.sourcePath){
    const token=++state.token;
    state.sourcePath=path;
    player.pause();player.removeAttribute("src");player.load();
    $("localPlayBtn").hidden=true;
    $("loadingVideo").hidden=false;
    const {data,error}=await db.storage.from(BUCKET).createSignedUrl(path,21600);
    if(token!==state.token || state.room?.library_path!==path)return;
    if(error||!data?.signedUrl){
      state.sourcePath=null;
      $("loadingVideo").hidden=true;
      inform(error?.message||"Couldn't load the movie.");
      return;
    }
    player.src=data.signedUrl;
    player.load();
    await attachSubtitles(path,token);
    if(token===state.token){
      if(player.readyState>=1)syncPlayback();
      else player.addEventListener("loadedmetadata",syncPlayback,{once:true});
    }
  }else if(oldPath===path && playbackChanged){
    // A new room revision represents a real playback command (play, pause, seek
    // or skip); honor it, including intentional backward seeks.
    // Repeated polling of an unchanged revision must not seek the movie backward.
    syncPlayback();
  }
}
async function attachSubtitles(path,token){
  for(const old of player.querySelectorAll("track"))old.remove();
  $("captionsBtn").hidden=true;
  updatePlayerIndicators();
  // Optional WebVTT sidecars in the same bucket, e.g. Film.en.vtt or Film.vtt.
  const base=path.replace(/\.(mp4|mkv|webm)$/i,"");
  const {data,error}=await db.storage.from(BUCKET).list("",{limit:100});
  if(error||token!==state.token)return;
  const tracks=(data||[]).filter(f=>f.id&&(f.name===base+".vtt"||f.name.startsWith(base+".")&&/\.vtt$/i.test(f.name))).slice(0,4);
  for(let i=0;i<tracks.length;i++){
    const f=tracks[i];
    const {data:signed,error:signError}=await db.storage.from(BUCKET).createSignedUrl(f.name,21600);
    if(signError || !signed?.signedUrl || token!==state.token)continue;
    const label=f.name.match(/\.([a-z]{2,3})\.vtt$/i)?.[1]||"English";
    const tr=document.createElement("track");tr.kind="subtitles";
    tr.label=label.toUpperCase();tr.srclang=/^[a-z]{2,3}$/i.test(label)?label.toLowerCase():"en";
    tr.src=signed.signedUrl;tr.default=i===0;
    tr.addEventListener("load",updatePlayerIndicators);
    player.append(tr);
  }
  $("captionsBtn").hidden=player.querySelectorAll("track").length===0;
  updatePlayerIndicators();
}
function syncPlayback({forwardOnly=false}={}){
  const room=state.room;
  if(!room?.library_path || !player.src || player.readyState<1)return;
  const target=wantedPosition(room);
  const duration=Number.isFinite(player.duration)?player.duration:0;
  const bounded=Math.max(0,Math.min(duration||864000,target));
  const drift=bounded-player.currentTime;
  // Explicit shared commands may seek in either direction; drift healing may
  // only catch up forward, and only when local playback is actually running.
  const shouldSeek=forwardOnly?drift>10:Math.abs(drift)>1.5;
  if(!state.scrubbing && !player.seeking && shouldSeek &&
     (!forwardOnly||(!player.paused && player.readyState>=3))){
    try{player.currentTime=bounded;}catch(err){console.warn(err);}
  }
  if(room.is_playing && (!duration || bounded<duration-.2)){
    const outcome=player.play();
    if(outcome?.catch)outcome.then(()=>$("localPlayBtn").hidden=true)
      .catch(()=>$("localPlayBtn").hidden=false);
  }else{player.pause();$("localPlayBtn").hidden=true;}
  updateClock();
}
function updateClock(){
  const length=Number.isFinite(player.duration)?player.duration:0;
  const position=Number.isFinite(player.currentTime)?player.currentTime:0;
  if(!state.scrubbing){
    $("seekBar").value=length?String(Math.max(0,Math.min(1000,position/length*1000))):"0";
    $("currentTime").textContent=formatTime(position);
  }
  $("duration").textContent=formatTime(length);
  $("seekBar").setAttribute("aria-valuetext",formatTime(position)+(length?" of "+formatTime(length):""));
}
async function subscribeCinema(id){
  const {data:{session}}=await db.auth.getSession();
  if(!session?.access_token)throw Error("Guest session expired.");
  await db.realtime.setAuth(session.access_token);
  const channel=db.channel("watch:"+id,{config:{private:true,presence:{key:state.user.id}}});
  channel
    .on("postgres_changes",{event:"UPDATE",schema:"public",table:"watch_rooms",filter:"id=eq."+id},
      ({new:incoming})=>applyRoom(incoming).catch(console.error))
    .on("postgres_changes",{event:"INSERT",schema:"public",table:"watch_chat_messages",filter:"room_id=eq."+id},
      ({new:message})=>{if(state.room?.id===id)appendChatMessage(message);})
    .on("presence",{event:"sync"},()=>{
      const found=new Map();
      Object.values(channel.presenceState()||{}).flat().forEach(p=>{if(p.persona)found.set(p.persona,p)});
      updatePresence([...found.keys()]);
    });
  state.channel=channel;
  channel.subscribe(async (status,error)=>{
    if(state.channel!==channel)return;
    if(status==="SUBSCRIBED"){
      await channel.track({id:state.user.id,persona:state.persona});
      $("connectionState").classList.add("connected");
      $("connectionText").textContent="In sync";
      try{await applyRoom(await fetchRoom(id));}catch(err){console.warn(err);}
      loadNewChat(id).catch(err=>console.warn("Chat refresh:",err));
    }else if(status==="CHANNEL_ERROR"||status==="TIMED_OUT"){
      $("connectionState").classList.remove("connected");
      $("connectionText").textContent="Reconnecting…";
      console.warn("Realtime:",error?.message);
    }
  });
}

// One chat per persistent room. History and incoming messages use the same RLS-protected table.
function setChatOpen(open){
  state.chatOpen=!!open;
  $("chatPanel").hidden=!state.chatOpen;
  $("chatToggleBtn").setAttribute("aria-expanded",String(state.chatOpen));
  $("chatToggleBtn").setAttribute("aria-label",state.chatOpen?"Collapse chat":"Open chat");
  if(state.chatOpen){
    state.chatUnread=0;
    updateUnread();
    const list=$("chatMessages");
    requestAnimationFrame(()=>{list.scrollTop=list.scrollHeight;});
  }
}
function updateUnread(){
  const pill=$("chatUnread");
  pill.hidden=!state.chatUnread;
  pill.textContent=state.chatUnread>99?"99+":String(state.chatUnread);
}
function resetChat(){
  state.chatSeenIds.clear();
  state.chatLastId=0;
  state.chatUnread=0;
  state.chatLoading=false;
  state.chatSending=false;
  $("chatInput").value="";
  $("chatSendBtn").disabled=false;
  $("chatMessages").replaceChildren();
  const empty=document.createElement("p");
  empty.className="chat-empty";
  empty.textContent="Say hello ♡";
  $("chatMessages").append(empty);
  updateUnread();
}
function appendChatMessage(message,{initial=false}={}){
  if(!message||!state.room || message.room_id!==state.room.id)return;
  const id=Number(message.id);
  if(!Number.isSafeInteger(id)||state.chatSeenIds.has(id))return;
  const list=$("chatMessages");
  const shouldScroll=list.scrollHeight-list.scrollTop-list.clientHeight<85;
  state.chatSeenIds.add(id);
  state.chatLastId=Math.max(state.chatLastId,id);
  list.querySelector(".chat-empty")?.remove();
  const mine=message.sender_user_id===state.user?.id;
  const item=document.createElement("div");
  item.className="chat-message "+(mine?"mine":"theirs");
  item.dataset.id=String(id);
  const label=document.createElement("span");
  label.className="chat-message-label";
  const time=new Date(message.created_at).toLocaleTimeString([],{
    hour:"numeric",minute:"2-digit"
  });
  label.textContent=(mine?"You":message.sender_persona||"Guest")+" · "+time;
  const bubble=document.createElement("div");
  bubble.className="chat-bubble";
  bubble.textContent=String(message.body||"");
  item.append(label,bubble);
  list.append(item);
  if(list.children.length>150){
    const oldest=list.firstElementChild;
    if(oldest?.dataset?.id)state.chatSeenIds.delete(Number(oldest.dataset.id));
    oldest?.remove();
  }
  if(!initial && !mine && (!state.chatOpen||!shouldScroll)){
    state.chatUnread++;
    updateUnread();
  }
  if(initial||shouldScroll){
    requestAnimationFrame(()=>{if(item.isConnected)list.scrollTop=list.scrollHeight;});
  }
}
async function loadChatHistory(roomId){
  if(!state.room || state.room.id!==roomId)return;
  const {data,error}=await db.from("watch_chat_messages")
    .select("id,room_id,sender_user_id,sender_persona,body,created_at")
    .eq("room_id",roomId).order("id",{ascending:false}).limit(100);
  if(error){inform("Chat couldn't load. "+error.message);return;}
  if(state.room?.id!==roomId)return;
  for(const message of (data||[]).reverse())appendChatMessage(message,{initial:true});
}
async function loadNewChat(roomId){
  if(!state.room || state.room.id!==roomId || state.chatLoading)return;
  state.chatLoading=true;
  try{
    const {data,error}=await db.from("watch_chat_messages")
      .select("id,room_id,sender_user_id,sender_persona,body,created_at")
      .eq("room_id",roomId).gt("id",state.chatLastId).order("id",{ascending:true}).limit(100);
    if(error)throw error;
    if(state.room?.id!==roomId)return;
    for(const message of data||[])appendChatMessage(message);
  }finally{state.chatLoading=false;}
}
async function sendChatMessage(event){
  event.preventDefault();
  if(state.chatSending||!state.room)return;
  const roomId=state.room.id;
  const message=$("chatInput").value.trim();
  if(!message||message.length>500)return;
  state.chatSending=true;
  $("chatSendBtn").disabled=true;
  try{
    const {error}=await db.rpc("send_cinema_chat",{
      p_room_id:roomId,p_message:message
    });
    if(error)throw error;
    if(state.room?.id===roomId){
      $("chatInput").value="";
      await loadNewChat(roomId);
      $("chatInput").focus();
    }
  }catch(err){inform(err?.message||"Couldn't send message.");}
  finally{state.chatSending=false;$("chatSendBtn").disabled=false;}
}
async function skipSeconds(delta){
  if(state.skipBusy||!state.room?.library_path)return;
  if(state.mode==="solo"){
    const at=player.readyState>=1?player.currentTime:wantedPosition(state.room);
    const limit=Number.isFinite(player.duration)&&player.duration>0?player.duration:864000;
    const next=Math.max(0,Math.min(limit,at+delta));
    await updateSharedPlayback(state.room.library_path,next,state.room.is_playing);
    return;
  }
  const roomId=state.room.id;
  state.skipBusy=true;
  $("skipBackBtn").disabled=true;
  $("skipForwardBtn").disabled=true;
  try{
    const duration=Number.isFinite(player.duration)&&player.duration>0
      ? player.duration : null;
    const {error}=await db.rpc("skip_cinema_seconds",{
      p_delta:delta,p_duration:duration
    });
    if(error)throw error;
    const fresh=await fetchRoom(roomId);
    if(state.room?.id===roomId)await applyRoom(fresh);
  }catch(err){inform(err?.message||"Couldn't move playback.");}
  finally{
    state.skipBusy=false;
    const enabled=!!state.room?.library_path;
    $("skipBackBtn").disabled=!enabled;
    $("skipForwardBtn").disabled=!enabled;
  }
}

async function keepWatching(){
  if(state.mode!=="together"||!state.room||state.heartbeat)return;
  state.heartbeat=true;
  try{
    const {data:alive,error}=await db.rpc("keep_watch_seat",{p_room_id:state.room.id});
    if(error||!alive){
      const {error:rejoinError}=await db.rpc("enter_shared_cinema");
      if(rejoinError)throw rejoinError;
    }
  }catch(err){
    inform(err?.message||"Connection lost. Rejoin to keep watching.");
    if(state.room)await leaveCinema();
    show("lobbyView");
    renderLobby();
  }finally{state.heartbeat=false;}
}
async function updatePresenceFromStatus(){
  if(!state.user)return;
  try{await readStatus();}catch(err){console.warn(err);}
}
function bindEvents(){
  $("chooseKittu").addEventListener("click",()=>choosePersona("Kittu"));
  $("chooseSubbu").addEventListener("click",()=>choosePersona("Subbu"));
  $("pinBackBtn").addEventListener("click",backToProfiles);
  $("pinForm").addEventListener("submit",submitPin);
  $("pinInput").addEventListener("input",()=>{
    $("pinInput").value=$("pinInput").value.replace(/\D/g,"").slice(0,4);
    $("entryMessage").textContent="";
  });
  $("switchProfileBtn").addEventListener("click",switchProfile);
  $("soloModeBtn").addEventListener("click",()=>showHome().catch(err=>inform(err.message)));
  $("togetherModeBtn").addEventListener("click",()=>enterLobby().catch(err=>inform(err.message)));
  $("soloBackBtn").addEventListener("click",()=>returnToChoices().catch(err=>inform(err.message)));
  $("leaveLobbyBtn").addEventListener("click",()=>returnToChoices().catch(err=>inform(err.message)));
  $("watchTogetherBtn").addEventListener("click",()=>{
    if(state.movies[0])startSolo(state.movies[0]).catch(err=>inform(err.message));
  });
  $("backHomeBtn").addEventListener("click",async()=>{
    try{
      if(state.mode==="solo")await showHome();
      else await returnToChoices();
    }catch(err){inform(err?.message||"Couldn't leave screening.");}
  });
  $("refreshLibraryBtn").addEventListener("click",refreshMovies);
  $("refreshWatchBtn").addEventListener("click",refreshMovies);
  $("chatToggleBtn").addEventListener("click",()=>{
    setChatOpen(!state.chatOpen);
    if(state.chatOpen)$("chatInput").focus();
  });
  $("chatCloseBtn").addEventListener("click",()=>setChatOpen(false));
  $("chatForm").addEventListener("submit",sendChatMessage);
  $("chatMessages").addEventListener("scroll",()=>{
    const list=$("chatMessages");
    if(state.chatOpen && list.scrollHeight-list.scrollTop-list.clientHeight<45){
      state.chatUnread=0;
      updateUnread();
    }
  });
  $("skipBackBtn").addEventListener("click",()=>skipSeconds(-10));
  $("skipForwardBtn").addEventListener("click",()=>skipSeconds(10));
  $("playPauseBtn").addEventListener("click",()=>{
    const r=state.room;
    if(!r?.library_path)return;
    if(!r.is_playing)player.play().catch(()=>{});
    const position=player.readyState>=1?player.currentTime:wantedPosition(r);
    updateSharedPlayback(r.library_path,position,!r.is_playing).catch(console.error);
  });
  $("localPlayBtn").addEventListener("click",()=>{
    revealPlayerControls();
    player.play().then(()=>{
      $("localPlayBtn").hidden=true;
      refreshPlayerControls();
    }).catch(()=>inform("Tap Play again once the movie is ready."));
  });
  $("seekBar").addEventListener("input",e=>{
    state.scrubbing=true;
    revealPlayerControls();
    const d=Number.isFinite(player.duration)?player.duration:0;
    $("currentTime").textContent=formatTime(d*Number(e.target.value)/1000);
  });
  $("seekBar").addEventListener("change",e=>{
    const d=Number.isFinite(player.duration)?player.duration:0;
    const pos=d*Number(e.target.value)/1000;
    state.scrubbing=false;
    refreshPlayerControls();
    if(state.room?.library_path){
      if(player.readyState>=1)player.currentTime=pos;
      updateSharedPlayback(state.room.library_path,pos,state.room.is_playing).catch(console.error);
    }
  });
  $("captionsBtn").addEventListener("click",()=>{
    const textTracks=Array.from(player.textTracks||[]).filter(t=>t.kind==="subtitles"||t.kind==="captions");
    if(!textTracks.length)return;
    const turningOn=textTracks.every(t=>t.mode!=="showing");
    for(const t of textTracks)t.mode=turningOn?"showing":"disabled";
    updatePlayerIndicators();
    revealPlayerControls();
  });
  $("muteBtn").addEventListener("click",()=>{
    if(player.muted || player.volume===0){
      if(player.volume===0)player.volume=1;
      player.muted=false;
    }else player.muted=true;
    updatePlayerIndicators();
    revealPlayerControls();
  });
  $("fullscreenBtn").addEventListener("click",()=>{
    revealPlayerControls();
    if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
    else if($("playerShell").parentElement.requestFullscreen){
      $("playerShell").parentElement.requestFullscreen().catch(()=>inform("Fullscreen isn't supported here."));
    }else if(player.webkitEnterFullscreen)player.webkitEnterFullscreen();
    else inform("Fullscreen isn't available on this device.");
  });
  if(!document.pictureInPictureEnabled || !player.requestPictureInPicture)$("pipBtn").hidden=true;
  $("pipBtn").addEventListener("click",async()=>{
    revealPlayerControls();
    try{
      if(document.pictureInPictureElement)await document.exitPictureInPicture();
      else await player.requestPictureInPicture();
    }catch(err){inform("Picture-in-picture isn't available here.");}
  });
  const shell=$("playerShell"),controlBar=$("playerControls");
  shell.addEventListener("pointermove",event=>{
    if(event.pointerType==="mouse"||event.pointerType==="pen")revealPlayerControls();
  });
  shell.addEventListener("pointerdown",event=>{
    keyboardNavigation=false;
    keyboardFocusControls=false;
    const insideControls=!!event.target.closest?.("#playerControls");
    if(insideControls){
      revealPlayerControls();
      return;
    }
    if(event.pointerType==="touch"||event.pointerType==="pen"){
      if(shell.classList.contains("controls-visible")&&!playerControlsPinned()){
        clearPlayerControlsTimer();
        shell.classList.remove("controls-visible");
      }else revealPlayerControls();
    }else revealPlayerControls();
  });
  controlBar.addEventListener("pointerdown",()=>{
    controlsPointerDown=true;
    revealPlayerControls();
  });
  const releaseControls=()=>{
    controlsPointerDown=false;
    refreshPlayerControls();
  };
  controlBar.addEventListener("pointerup",releaseControls);
  controlBar.addEventListener("pointercancel",releaseControls);
  // Release a captured pointer that is lifted outside of the control bar.
  document.addEventListener("pointerup",()=>{
    if(controlsPointerDown)releaseControls();
  });
  document.addEventListener("keydown",event=>{
    if(event.key==="Tab"||event.key.startsWith("Arrow"))keyboardNavigation=true;
  });
  controlBar.addEventListener("focusin",()=>{
    if(keyboardNavigation){
      keyboardFocusControls=true;
      revealPlayerControls();
    }
  });
  controlBar.addEventListener("focusout",event=>{
    if(!controlBar.contains(event.relatedTarget)){
      keyboardFocusControls=false;
      refreshPlayerControls();
    }
  });
  controlBar.addEventListener("keydown",event=>{
    if(event.key==="Escape"){
      keyboardFocusControls=false;
      event.target.blur?.();
      refreshPlayerControls();
    }
  });
  player.addEventListener("volumechange",updatePlayerIndicators);
  if(player.textTracks?.addEventListener)
    player.textTracks.addEventListener("change",updatePlayerIndicators);
  player.addEventListener("enterpictureinpicture",updatePlayerIndicators);
  player.addEventListener("leavepictureinpicture",updatePlayerIndicators);
  document.addEventListener("fullscreenchange",()=>{
    updatePlayerIndicators();
    refreshPlayerControls();
  });
  player.addEventListener("webkitbeginfullscreen",updatePlayerIndicators);
  player.addEventListener("webkitendfullscreen",updatePlayerIndicators);
  player.addEventListener("play",refreshPlayerControls);
  player.addEventListener("pause",()=>{
    refreshPlayerControls();
    storeSoloProgress(true);
  });
  player.addEventListener("seeking",refreshPlayerControls);
  player.addEventListener("timeupdate",()=>{
    updateClock();
    storeSoloProgress();
  });
  player.addEventListener("loadedmetadata",()=>{$("loadingVideo").hidden=true;syncPlayback();refreshPlayerControls();});
  player.addEventListener("canplay",()=>{$("loadingVideo").hidden=true;refreshPlayerControls();});
  player.addEventListener("waiting",()=>{if(state.room?.is_playing){$("loadingVideo").hidden=false;refreshPlayerControls();}});
  player.addEventListener("playing",()=>{$("loadingVideo").hidden=true;refreshPlayerControls();});
  player.addEventListener("error",()=>{
    if(!player.getAttribute("src"))return;
    $("loadingVideo").hidden=true;
    refreshPlayerControls();
    const movie=currentMovie();
    $("playerNote").hidden=false;
    $("playerNote").textContent=movie?.mkv
      ?"This MKV isn't supported by your browser. Use an H.264/AAC MP4."
      :"This file couldn't play. Try an H.264/AAC MP4.";
  });
  player.addEventListener("ended",()=>{
    refreshPlayerControls();
    storeSoloProgress(true);
    if(state.room?.library_path && state.room.is_playing)
      updateSharedPlayback(state.room.library_path,player.duration||0,false).catch(console.error);
  });
  setInterval(()=>{
    if(!$("watchView").hidden&&state.mode==="together")keepWatching();
    if(state.mode==="together"&&(!$("lobbyView").hidden||!$("watchView").hidden))
      pollLobby(true).catch(console.warn);
  },20000);
  setInterval(()=>{
    if(state.mode==="together"&&(!$("lobbyView").hidden||!$("watchView").hidden))
      pollLobby(false).catch(console.warn);
  },4000);
  setInterval(()=>{
    if(state.mode==="together"&&!$("watchView").hidden && state.room)
      loadNewChat(state.room.id).catch(err=>console.warn("Chat reconnect:",err));
  },6000);
  setInterval(async()=>{
    if(state.mode==="together"&&!$("watchView").hidden && state.room){
      try{
        const room=await fetchRoom(state.room.id);
        if(state.room?.id===room.id)await applyRoom(room);
        // Network buffering can stop local video time while room time advances.
        // Only catch UP when well behind, after playback has resumed; never
        // rewind an already-playing movie because of routine polling/clock skew.
        if(state.room?.is_playing && player.readyState>=3 &&
           !player.paused && !player.seeking && !state.scrubbing &&
           wantedPosition(state.room)-player.currentTime>10){
          syncPlayback({forwardOnly:true});
        }
      }catch(err){console.warn("Cinema check:",err);}
    }
  },7000);
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible"&&state.mode==="together"){
      if(!$("watchView").hidden)keepWatching().catch(console.error);
      pollLobby(true).catch(console.error);
    }
    if(document.visibilityState==="hidden")storeSoloProgress(true);
  });
  db.auth.onAuthStateChange(event=>{
    if(event==="SIGNED_OUT" && state.user){
      state.user=null;state.persona=null;state.room=null;show("loginView");
    }
  });
}
async function boot(){
  bindEvents();
  show("loadingView");
  const {data:{user},error}=await db.auth.getUser();
  if(error&&error.name!=="AuthSessionMissingError")console.warn(error.message);
  if(!user){show("loginView");return;}
  const {data:alias,error:aliasError}=await db.from("watch_aliases")
    .select("persona").eq("user_id",user.id).maybeSingle();
  if(aliasError)console.warn(aliasError.message);
  if(!alias?.persona){show("loginView");return;}
  const {error:verificationError}=await db.rpc("get_cinema_status");
  if(verificationError){show("loginView");return;}
  state.user=user;state.persona=alias.persona;
  let intent="",soloPath="";
  try{
    intent=sessionStorage.getItem("cinema-intent")||"";
    soloPath=sessionStorage.getItem("cinema-solo-path")||"";
  }catch(_){}
  if(intent==="together"){
    await enterLobby();
  }else if(intent==="solo"){
    await showHome({release:false});
    const movie=state.movies.find(m=>m.path===soloPath);
    if(movie)await startSolo(movie);
  }else showExperienceChooser();
}
boot().catch(err=>{
  console.warn("Cinema startup:",err);
  inform(err?.message||"Something went wrong.");
  if(state.user)showExperienceChooser();
  else show("loginView");
});
