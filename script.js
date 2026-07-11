(function(){
  "use strict";

  // ---------- STANDALONE STORAGE FALLBACK ----------
  // Inside Claude, window.storage is provided automatically and syncs to your account.
  // If this file is downloaded and opened directly in a browser (Windows, phone, etc.),
  // window.storage won't exist — so we polyfill it with the browser's own localStorage.
  // Everything else in the app is unchanged either way.
  if(!window.storage){
    window.storage = {
      async get(key, shared){
        const raw = localStorage.getItem((shared?"shared:":"")+key);
        if(raw === null) throw new Error("key not found: "+key);
        return { key, value: raw, shared: !!shared };
      },
      async set(key, value, shared){
        localStorage.setItem((shared?"shared:":"")+key, value);
        return { key, value, shared: !!shared };
      },
      async delete(key, shared){
        localStorage.removeItem((shared?"shared:":"")+key);
        return { key, deleted:true, shared: !!shared };
      },
      async list(prefix, shared){
        const pre = (shared?"shared:":"")+(prefix||"");
        const keys = [];
        for(let i=0;i<localStorage.length;i++){
          const k = localStorage.key(i);
          if(k.startsWith(pre)) keys.push(shared ? k.slice(7) : k);
        }
        return { keys, prefix, shared: !!shared };
      }
    };
  }

  // ---------- STORAGE ----------
  const STORAGE_KEY = "tempo-data";
  const defaultData = () => ({
    tasks: [],           // {id,name,date,time,cat,createdAt}
    completions: {},      // { "YYYY-MM-DD": [taskId,...] }
    stats: { totalTasksCompleted:0, totalTimersCompleted:0, currentStreak:0, longestStreak:0, lastCompletionDate:null },
    awardsUnlocked: {}    // { badgeId: isoTimestamp }
  });
  let data = defaultData();

  const syncDotEl = document.getElementById("syncDot");
  const syncTextEl = document.getElementById("syncText");
  function markSaving(){
    syncDotEl.className = "dot saving";
    syncTextEl.textContent = "Saving…";
  }
  function markSaved(){
    syncDotEl.className = "dot";
    const now = new Date();
    syncTextEl.textContent = "Saved " + now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  }
  function markSaveError(){
    syncDotEl.className = "dot err";
    syncTextEl.textContent = "Save failed — retrying";
  }

  async function loadData(){
    try{
      const res = await window.storage.get(STORAGE_KEY, false);
      if(res && res.value){
        const parsed = JSON.parse(res.value);
        data = Object.assign(defaultData(), parsed);
        data.stats = Object.assign(defaultData().stats, parsed.stats||{});
        // migrate old tasks that don't have a date yet — anchor them to today
        data.tasks.forEach(t=>{ if(!t.date) t.date = t.createdAt || todayStr(); });
      }
      markSaved();
    }catch(e){
      // key doesn't exist yet — use defaults, then persist them
      try{ await window.storage.set(STORAGE_KEY, JSON.stringify(data), false); markSaved(); }
      catch(e2){ markSaveError(); }
    }
  }

  // Saves happen immediately (no debounce) — this is server-side persistent storage tied
  // to your account, not browser localStorage, so it survives closing the tab, restarting
  // the browser, or shutting down the device entirely, as long as the request completed.
  let saveSeq = 0, retryTimer = null;
  async function saveData(){
    clearTimeout(retryTimer);
    const mySeq = ++saveSeq;
    markSaving();
    try{
      await window.storage.set(STORAGE_KEY, JSON.stringify(data), false);
      if(mySeq === saveSeq) markSaved();
    }catch(e){
      console.error("Save failed", e);
      markSaveError();
      retryTimer = setTimeout(saveData, 1500);
    }
  }

  // ---------- HELPERS ----------
  function todayStr(){ return dateToStr(new Date()); }
  function dateToStr(d){
    return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  }
  function addDaysStr(dateStr, n){
    const d = new Date(dateStr+"T00:00:00");
    d.setDate(d.getDate()+n);
    return dateToStr(d);
  }
  function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
  const catColors = {Work:"#E8A33D", Health:"#4FD1C5", Personal:"#D98B9A", Learning:"#8A93A6", Other:"#8890A0"};

  document.getElementById("todaylabel").textContent = new Date().toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'});

  // ---------- NAV ----------
  document.querySelectorAll(".nav .tab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".nav .tab").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
      document.getElementById("view-"+btn.dataset.view).classList.add("active");
    });
  });

  // ---------- TASKS ----------
  let selectedDate = todayStr();
  const selectedDateInput = document.getElementById("selectedDateInput");
  const taskDateInput = document.getElementById("taskDate");
  selectedDateInput.value = selectedDate;
  taskDateInput.value = selectedDate;

  function addTask(){
    const nameEl = document.getElementById("taskName");
    const dateEl = document.getElementById("taskDate");
    const timeEl = document.getElementById("taskTime");
    const catEl = document.getElementById("taskCat");
    const name = nameEl.value.trim();
    if(!name) { nameEl.focus(); return; }
    data.tasks.push({ id: uid(), name, date: dateEl.value || selectedDate, time: timeEl.value || "09:00", cat: catEl.value, createdAt: todayStr() });
    nameEl.value = "";
    saveData();
    renderTasks();
  }
  document.getElementById("addTaskBtn").addEventListener("click", addTask);
  document.getElementById("taskName").addEventListener("keydown", e=>{ if(e.key==="Enter") addTask(); });

  function toggleTask(id){
    const task = data.tasks.find(t=>t.id===id);
    if(!task) return;
    const d = task.date;
    if(!data.completions[d]) data.completions[d] = [];
    const list = data.completions[d];
    const idx = list.indexOf(id);
    if(idx === -1){
      list.push(id);
      data.stats.totalTasksCompleted++;
      updateStreak(d);
    } else {
      list.splice(idx,1);
      data.stats.totalTasksCompleted = Math.max(0, data.stats.totalTasksCompleted-1);
      // if no tasks left completed on that day, and streak was counted for that day, roll it back
      if(list.length === 0 && data.stats.lastCompletionDate === d){
        data.stats.currentStreak = Math.max(0, data.stats.currentStreak-1);
        data.stats.lastCompletionDate = null;
      }
    }
    saveData();
    checkAwards();
    renderTasks();
    renderAwardsView();
  }
  function deleteTask(id){
    data.tasks = data.tasks.filter(t=>t.id!==id);
    Object.keys(data.completions).forEach(d=>{
      data.completions[d] = data.completions[d].filter(x=>x!==id);
    });
    saveData();
    renderTasks();
  }

  function updateStreak(dateStr){
    const s = data.stats;
    if(s.lastCompletionDate === dateStr) return; // already counted this day
    if(s.lastCompletionDate){
      const prev = new Date(s.lastCompletionDate+"T00:00:00");
      const cur = new Date(dateStr+"T00:00:00");
      const diffDays = Math.round((cur-prev)/86400000);
      if(diffDays === 1){ s.currentStreak += 1; }
      else if(diffDays > 1 || diffDays < 0){ s.currentStreak = 1; }
      else { s.currentStreak = s.currentStreak || 1; }
    } else {
      s.currentStreak = 1;
    }
    s.lastCompletionDate = dateStr;
    s.longestStreak = Math.max(s.longestStreak, s.currentStreak);
  }

  function fmtDayLabel(dateStr){
    const d = new Date(dateStr+"T00:00:00");
    if(dateStr === todayStr()) return "Today · " + d.toLocaleDateString(undefined,{month:'short', day:'numeric'});
    if(dateStr === addDaysStr(todayStr(),-1)) return "Yesterday · " + d.toLocaleDateString(undefined,{month:'short', day:'numeric'});
    if(dateStr === addDaysStr(todayStr(),1)) return "Tomorrow · " + d.toLocaleDateString(undefined,{month:'short', day:'numeric'});
    return d.toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric'});
  }

  document.getElementById("prevDayBtn").addEventListener("click", ()=>{ setSelectedDate(addDaysStr(selectedDate,-1)); });
  document.getElementById("nextDayBtn").addEventListener("click", ()=>{ setSelectedDate(addDaysStr(selectedDate,1)); });
  document.getElementById("todayBtn").addEventListener("click", ()=>{ setSelectedDate(todayStr()); });
  selectedDateInput.addEventListener("change", ()=>{ if(selectedDateInput.value) setSelectedDate(selectedDateInput.value); });
  function setSelectedDate(d){
    selectedDate = d;
    selectedDateInput.value = d;
    taskDateInput.value = d;
    renderTasks();
  }

  function renderTasks(){
    const listEl = document.getElementById("taskList");
    document.getElementById("daynavLabel").textContent = fmtDayLabel(selectedDate);
    const doneOnDay = data.completions[selectedDate] || [];
    const sorted = data.tasks.filter(t=>t.date===selectedDate).sort((a,b)=> a.time.localeCompare(b.time));
    listEl.innerHTML = "";
    if(sorted.length === 0){
      listEl.innerHTML = '<div class="empty">Nothing scheduled for this day yet.</div>';
    } else {
      sorted.forEach(task=>{
        const done = doneOnDay.includes(task.id);
        const row = document.createElement("div");
        row.className = "task" + (done ? " done" : "");
        row.innerHTML = `
          <button class="check ${done?'on':''}" aria-label="Mark ${task.name} complete">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
          <span class="time">${task.time}</span>
          <span class="catdot" style="background:${catColors[task.cat]||'#8890A0'}"></span>
          <span class="name">${escapeHtml(task.name)}</span>
          <button class="del" aria-label="Delete task">&times;</button>
        `;
        row.querySelector(".check").addEventListener("click", ()=>toggleTask(task.id));
        row.querySelector(".del").addEventListener("click", ()=>deleteTask(task.id));
        listEl.appendChild(row);
      });
    }
    document.getElementById("streakNum").textContent = data.stats.currentStreak;
  }
  function escapeHtml(s){
    return s.replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  // ---------- TIMER (DIAL) ----------
  const ticksG = document.getElementById("ticks");
  for(let i=0;i<60;i++){
    const angle = i*6;
    const major = i % 5 === 0;
    const len = major ? 12 : 6;
    const r1 = 118 - 14/2 - 4, r2 = r1 - len;
    const rad = (angle-90) * Math.PI/180;
    const x1 = 140 + r1*Math.cos(rad), y1 = 140 + r1*Math.sin(rad);
    const x2 = 140 + r2*Math.cos(rad), y2 = 140 + r2*Math.sin(rad);
    const line = document.createElementNS("http://www.w3.org/2000/svg","line");
    line.setAttribute("x1",x1); line.setAttribute("y1",y1);
    line.setAttribute("x2",x2); line.setAttribute("y2",y2);
    line.setAttribute("stroke", major ? "#3A4656" : "#232C38");
    line.setAttribute("stroke-width", major ? 2.5 : 1.5);
    ticksG.appendChild(line);
  }

  const RING_R = 118, RING_C = 2*Math.PI*RING_R;
  const progressRing = document.getElementById("progressRing");
  const knob = document.getElementById("knob");
  progressRing.style.strokeDasharray = RING_C;

  let dialMinutes = 25; // 0-59, minute portion set via dial/presets
  let dialHours = 0;    // extra hours
  let running = false, paused = false;
  let endTime = null, remainingAtPause = null, totalDurationMs = 25*60*1000;
  let tickInterval = null, wakeLockRef = null, audioCtx = null, alarmInterval = null;

  function totalSetMs(){ return (dialHours*3600 + dialMinutes*60) * 1000; }

  function setDialFromMinutes(min){
    dialMinutes = Math.max(0, Math.min(59, Math.round(min)));
    updateDialVisual();
  }

  function updateDialVisual(){
    const frac = dialMinutes/60;
    const angle = frac*360;
    const rad = (angle-90)*Math.PI/180;
    const kx = 140 + RING_R*Math.cos(rad), ky = 140 + RING_R*Math.sin(rad);
    knob.setAttribute("cx", kx); knob.setAttribute("cy", ky);
    progressRing.style.strokeDashoffset = RING_C*(1-frac);
    const totalSec = dialHours*3600 + dialMinutes*60;
    document.getElementById("digits").textContent = fmt(totalSec);
    document.getElementById("hourChip").textContent = "+" + dialHours + " h";
    document.getElementById("dialSubLbl").textContent = "minutes set";
    totalDurationMs = totalSec*1000;
  }
  function fmt(totalSeconds){
    totalSeconds = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(totalSeconds/3600);
    const m = Math.floor((totalSeconds%3600)/60);
    const s = totalSeconds%60;
    if(h>0) return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
    return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
  }

  // dial dragging
  const dialbox = document.getElementById("dialbox");
  let dragging = false;
  function angleToMinutes(clientX, clientY){
    const rect = dialbox.getBoundingClientRect();
    const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
    let angle = Math.atan2(clientY-cy, clientX-cx)*180/Math.PI + 90;
    if(angle < 0) angle += 360;
    return (angle/360)*60;
  }
  function onDragStart(e){
    if(running && !paused) return;
    dragging = true;
    const p = e.touches ? e.touches[0] : e;
    setDialFromMinutes(angleToMinutes(p.clientX, p.clientY));
    clearPresetActive();
  }
  function onDragMove(e){
    if(!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    setDialFromMinutes(angleToMinutes(p.clientX, p.clientY));
    e.preventDefault();
  }
  function onDragEnd(){ dragging = false; }
  dialbox.addEventListener("mousedown", onDragStart);
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);
  dialbox.addEventListener("touchstart", onDragStart, {passive:true});
  window.addEventListener("touchmove", onDragMove, {passive:false});
  window.addEventListener("touchend", onDragEnd);

  document.getElementById("hourChip").addEventListener("click", ()=>{
    if(running && !paused) return;
    dialHours = (dialHours+1) % 4;
    updateDialVisual();
  });

  function clearPresetActive(){
    document.querySelectorAll("#presets .chip").forEach(c=>c.classList.remove("active"));
  }
  document.querySelectorAll("#presets .chip").forEach(chip=>{
    chip.addEventListener("click", ()=>{
      if(running && !paused) return;
      clearPresetActive();
      chip.classList.add("active");
      dialHours = 0;
      setDialFromMinutes(parseInt(chip.dataset.min,10));
    });
  });

  updateDialVisual();

  // controls
  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const resetBtn = document.getElementById("resetBtn");
  const statusEl = document.getElementById("timerStatus");

  async function requestWakeLock(){
    try{
      if("wakeLock" in navigator){
        wakeLockRef = await navigator.wakeLock.request("screen");
      }
    }catch(e){ /* not available/allowed — silently continue */ }
  }
  function releaseWakeLock(){
    if(wakeLockRef){ try{ wakeLockRef.release(); }catch(e){} wakeLockRef = null; }
  }
  document.addEventListener("visibilitychange", ()=>{
    if(document.visibilityState === "visible" && running && !paused){
      requestWakeLock();
      tickCheck(); // catch up immediately
    }
  });

  function startTimer(){
    if(totalDurationMs <= 0) return;
    if("Notification" in window && Notification.permission === "default"){
      try{ Notification.requestPermission(); }catch(e){}
    }
    if(!audioCtx){
      try{ audioCtx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){}
    }
    if(paused && remainingAtPause != null){
      endTime = Date.now() + remainingAtPause;
    } else {
      endTime = Date.now() + totalDurationMs;
    }
    running = true; paused = false;
    startBtn.textContent = "Running…";
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    requestWakeLock();
    tickInterval = setInterval(tickCheck, 250);
    statusEl.innerHTML = "Timer is running — keep this tab open. It'll catch up automatically if the screen dims.";
  }
  function pauseTimer(){
    if(!running) return;
    paused = true; running = false;
    remainingAtPause = Math.max(0, endTime - Date.now());
    clearInterval(tickInterval);
    releaseWakeLock();
    startBtn.textContent = "Resume";
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    document.getElementById("digits").textContent = fmt(remainingAtPause/1000);
  }
  function resetTimer(){
    running = false; paused = false; remainingAtPause = null; endTime = null;
    clearInterval(tickInterval);
    releaseWakeLock();
    startBtn.textContent = "Start";
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    updateDialVisual();
    statusEl.innerHTML = "Sound plays when the timer ends. For best results while the screen is off, keep this tab open — <b>Screen Wake Lock</b> will try to keep the display on automatically while a timer runs.";
  }
  function tickCheck(){
    if(!running) return;
    const remain = endTime - Date.now();
    if(remain <= 0){
      clearInterval(tickInterval);
      running = false;
      document.getElementById("digits").textContent = "00:00";
      startBtn.textContent = "Start";
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      releaseWakeLock();
      onTimerComplete();
      return;
    }
    document.getElementById("digits").textContent = fmt(remain/1000);
    const frac = Math.max(0, remain/totalDurationMs);
    progressRing.style.strokeDashoffset = RING_C*(1-frac);
  }
  startBtn.addEventListener("click", ()=>{
    if(paused) startTimer();
    else if(!running) startTimer();
  });
  pauseBtn.addEventListener("click", pauseTimer);
  resetBtn.addEventListener("click", resetTimer);

  function beep(){
    if(!audioCtx) return;
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.28, t0+0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0+0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0+0.4);
  }

  function onTimerComplete(){
    data.stats.totalTimersCompleted++;
    saveData();
    checkAwards();
    renderAwardsView();
    const label = document.getElementById("timerLabel").value.trim() || "Focus session";
    document.getElementById("alarmLabel").textContent = label + " — time's up";
    document.getElementById("alarmOverlay").classList.add("show");
    if(document.hidden && "Notification" in window && Notification.permission === "granted"){
      try{ new Notification("TEMPO — " + label, { body: "Time's up." }); }catch(e){}
    }
    if(audioCtx && audioCtx.state === "suspended"){ audioCtx.resume().catch(()=>{}); }
    beep();
    alarmInterval = setInterval(beep, 900);
  }
  document.getElementById("stopAlarmBtn").addEventListener("click", ()=>{
    clearInterval(alarmInterval);
    document.getElementById("alarmOverlay").classList.remove("show");
    resetTimer();
  });

  // ---------- MODE SWITCH (Countdown / Stopwatch) ----------
  const countdownModeEl = document.getElementById("countdownMode");
  const stopwatchModeEl = document.getElementById("stopwatchMode");
  const timerHintEl = document.getElementById("timerHint");
  const HINTS = {
    countdown: "Drag the dial or tap a preset to set minutes. Runs on real elapsed time, so it stays accurate even if the tab was in the background.",
    stopwatch: "Track elapsed time freely and drop laps as you go. Also timestamp-based, so it keeps counting accurately in the background."
  };
  document.querySelectorAll(".modebtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".modebtn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.mode;
      countdownModeEl.style.display = mode==="countdown" ? "flex" : "none";
      stopwatchModeEl.style.display = mode==="stopwatch" ? "flex" : "none";
      timerHintEl.textContent = HINTS[mode];
    });
  });

  // ---------- STOPWATCH ----------
  const swRing = document.getElementById("swRing");
  swRing.style.strokeDasharray = RING_C;
  swRing.style.strokeDashoffset = RING_C;
  const swDigitsEl = document.getElementById("swDigits");
  const swStartBtn = document.getElementById("swStartBtn");
  const swLapBtn = document.getElementById("swLapBtn");
  const swResetBtn = document.getElementById("swResetBtn");
  const lapListEl = document.getElementById("lapList");

  let swRunning = false, swStartTs = null, swAccum = 0, swInterval = null, swLaps = [];

  function swElapsedMs(){ return swAccum + (swRunning ? Date.now()-swStartTs : 0); }
  function fmtStopwatch(ms){
    ms = Math.max(0, ms);
    const cs = Math.floor((ms%1000)/10);
    const totalSec = Math.floor(ms/1000);
    const h = Math.floor(totalSec/3600);
    const m = Math.floor((totalSec%3600)/60);
    const s = totalSec%60;
    const pad = (n)=>String(n).padStart(2,"0");
    return (h>0 ? pad(h)+":" : "") + pad(m)+":"+pad(s)+"."+pad(cs);
  }
  function swTick(){
    const ms = swElapsedMs();
    swDigitsEl.textContent = fmtStopwatch(ms);
    const secFrac = (ms/1000) % 60 / 60;
    swRing.style.strokeDashoffset = RING_C*(1-secFrac);
  }
  function swUpdateButtons(){
    swStartBtn.textContent = swRunning ? "Pause" : (swAccum>0 ? "Resume" : "Start");
    swLapBtn.disabled = !swRunning;
  }
  function swStartPause(){
    if(swRunning){
      swAccum += Date.now()-swStartTs;
      swRunning = false;
      clearInterval(swInterval);
      swTick();
    } else {
      swRunning = true;
      swStartTs = Date.now();
      swInterval = setInterval(swTick, 31);
    }
    swUpdateButtons();
  }
  function swLap(){
    if(!swRunning) return;
    const total = swElapsedMs();
    const prevTotal = swLaps.length ? swLaps[swLaps.length-1].total : 0;
    swLaps.push({ n: swLaps.length+1, split: total-prevTotal, total });
    renderLaps();
  }
  function swReset(){
    swRunning = false;
    swAccum = 0;
    swLaps = [];
    clearInterval(swInterval);
    swTick();
    renderLaps();
    swUpdateButtons();
  }
  function renderLaps(){
    if(swLaps.length === 0){
      lapListEl.innerHTML = '<div class="laps-empty">Laps will show up here once you start.</div>';
      return;
    }
    lapListEl.innerHTML = [...swLaps].reverse().map(l=>`
      <div class="lapitem">
        <span class="ln">Lap ${l.n}</span>
        <span class="lsplit">+${fmtStopwatch(l.split)}</span>
        <span class="ltotal">${fmtStopwatch(l.total)}</span>
      </div>`).join("");
  }
  swStartBtn.addEventListener("click", swStartPause);
  swLapBtn.addEventListener("click", swLap);
  swResetBtn.addEventListener("click", swReset);
  swTick();

  // ---------- AWARDS ----------
  const ICONS = {
    check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9"/></svg>',
    flame: '<svg viewBox="0 0 24 24"><path d="M12 2c1 4-3 5-3 9a5 5 0 0 0 10 0c0-2-1-3-2-4 0 2-1 3-2 2 1-3-1-5-3-7z"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6 6.6.7-5 4.5 1.4 6.5L12 16.9 6.1 20.2l1.4-6.5-5-4.5 6.6-.7z"/></svg>',
    crown: '<svg viewBox="0 0 24 24"><path d="M3 8l4 3 5-6 5 6 4-3-2 11H5z"/><path d="M5 19h14"/></svg>'
  };

  const LADDERS = [
    { key:"tasks", label:"Tasks completed", metric:()=>data.stats.totalTasksCompleted, tiers:[
      {n:1,   name:"First Step",     icon:"check"},
      {n:5,   name:"Getting Going",  icon:"check"},
      {n:10,  name:"Momentum",       icon:"check"},
      {n:25,  name:"Quarter Century",icon:"check"},
      {n:50,  name:"Half Century",   icon:"check"},
      {n:100, name:"Centurion",      icon:"check"},
      {n:250, name:"Relentless",     icon:"check"},
      {n:500, name:"Task Machine",   icon:"star"},
      {n:1000,name:"Legend",         icon:"star"},
    ]},
    { key:"timers", label:"Timers finished", metric:()=>data.stats.totalTimersCompleted, tiers:[
      {n:1,   name:"First Focus",  icon:"clock"},
      {n:5,   name:"Timekeeper",   icon:"clock"},
      {n:10,  name:"Clockwork",    icon:"clock"},
      {n:25,  name:"Deep Focus",   icon:"clock"},
      {n:50,  name:"Marathoner",   icon:"clock"},
      {n:100, name:"Iron Focus",   icon:"clock"},
      {n:200, name:"Timeless",     icon:"star"},
    ]},
    { key:"streak", label:"Streak (days in a row)", metric:()=>data.stats.longestStreak, live:()=>data.stats.currentStreak, tiers:[
      {n:2,   name:"Spark",           icon:"flame"},
      {n:3,   name:"Triad",           icon:"flame"},
      {n:5,   name:"Five Alive",      icon:"flame"},
      {n:7,   name:"Full Week",       icon:"flame"},
      {n:14,  name:"Fortnight Flame", icon:"flame"},
      {n:21,  name:"Habit Formed",    icon:"flame"},
      {n:30,  name:"Thirty Strong",   icon:"flame"},
      {n:60,  name:"Two Months",      icon:"flame"},
      {n:100, name:"Triple Digit",    icon:"flame"},
      {n:180, name:"Half Year Hero",  icon:"crown"},
      {n:365, name:"Full Circle",     icon:"crown"},
    ]}
  ];

  const TIER_STOPS = ["#C58A4B","#B9C4D0","#E8A33D","#4FD1C5","#B79CFF"]; // bronze -> silver -> gold -> platinum -> diamond
  function hexToRgb(h){ h=h.replace('#',''); return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; }
  function rgbToHex(r,g,b){ return '#'+[r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join(''); }
  function tierColor(index, total){
    const pos = total<=1 ? 0 : index/(total-1);
    const scaled = pos*(TIER_STOPS.length-1);
    const seg = Math.min(TIER_STOPS.length-2, Math.floor(scaled));
    const t = scaled-seg;
    const c1 = hexToRgb(TIER_STOPS[seg]), c2 = hexToRgb(TIER_STOPS[seg+1]);
    return rgbToHex(c1[0]+(c2[0]-c1[0])*t, c1[1]+(c2[1]-c1[1])*t, c1[2]+(c2[2]-c1[2])*t);
  }
  function hexToRgba(hex, a){ const [r,g,b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

  function badgeId(catKey, n){ return catKey+"-"+n; }

  function checkAwards(){
    let changed = false;
    LADDERS.forEach(cat=>{
      const val = cat.metric();
      cat.tiers.forEach(tier=>{
        const id = badgeId(cat.key, tier.n);
        if(!data.awardsUnlocked[id] && val>=tier.n){
          data.awardsUnlocked[id] = new Date().toISOString();
          changed = true;
        }
      });
    });
    if(changed) saveData();
  }

  function renderAwardsView(){
    document.getElementById("statCurrent").textContent = data.stats.currentStreak;
    document.getElementById("statLongest").textContent = data.stats.longestStreak;
    document.getElementById("statTasks").textContent = data.stats.totalTasksCompleted;
    document.getElementById("statTimers").textContent = data.stats.totalTimersCompleted;

    const wrap = document.getElementById("badgeSections");
    wrap.innerHTML = "";

    LADDERS.forEach(cat=>{
      const val = cat.metric();
      const liveVal = cat.live ? cat.live() : val;
      const unlockedCount = cat.tiers.filter(t=>!!data.awardsUnlocked[badgeId(cat.key,t.n)]).length;
      const nextTier = cat.tiers.find(t=>val < t.n);

      const section = document.createElement("div");
      section.className = "catsection";

      let progressHtml = "";
      if(nextTier){
        const prevN = [...cat.tiers].reverse().find(t=>t.n<nextTier.n)?.n || 0;
        const span = nextTier.n - prevN;
        const progressed = Math.max(0, liveVal - prevN);
        const frac = Math.max(0, Math.min(1, progressed/span));
        const col = tierColor(cat.tiers.indexOf(nextTier), cat.tiers.length);
        progressHtml = `
          <div class="progwrap">
            <div class="progtrack"><div class="progfill" style="width:${(frac*100).toFixed(1)}%;background:${col};"></div></div>
            <div class="progtext">${liveVal} / ${nextTier.n} toward "${nextTier.name}"</div>
          </div>`;
      } else {
        progressHtml = `<div class="progwrap"><div class="progtext">All tiers unlocked in this ladder 🎉</div></div>`;
      }

      const medals = cat.tiers.map((t,i)=>{
        const id = badgeId(cat.key, t.n);
        const unlocked = !!data.awardsUnlocked[id];
        const col = tierColor(i, cat.tiers.length);
        const style = unlocked
          ? `border-color:${col};background:${hexToRgba(col,0.14)};box-shadow:0 0 10px ${hexToRgba(col,0.35)};`
          : "";
        const iconColor = unlocked ? col : "";
        return `
          <div class="medal ${unlocked?'unlocked':'locked'}" title="${t.name} — reach ${t.n}">
            <div class="circ" style="${style}">
              ${svgWithColor(ICONS[t.icon], unlocked?col:null)}
              ${unlocked ? "" : `<div class="lockdot"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></div>`}
            </div>
            <div class="mn">${t.name}</div>
            <div class="mv">${t.n}${cat.key==='streak' ? 'd' : ''}</div>
          </div>`;
      }).join("");

      section.innerHTML = `
        <div class="catsection-head">
          <h3>${cat.label}</h3>
          <span class="catcount">${unlockedCount}/${cat.tiers.length}</span>
        </div>
        ${progressHtml}
        <div class="medalrow">${medals}</div>
      `;
      wrap.appendChild(section);
    });
  }
  function svgWithColor(svgStr, color){
    if(!color) return svgStr.replace('<svg viewBox', '<svg fill="none" stroke="currentColor" viewBox');
    return svgStr.replace('<svg viewBox', `<svg fill="none" stroke="${color}" viewBox`);
  }

  // ---------- INIT ----------
  (async function init(){
    await loadData();
    renderTasks();
    checkAwards();
    renderAwardsView();
    document.getElementById("streakNum").textContent = data.stats.currentStreak;
  })();

})();
