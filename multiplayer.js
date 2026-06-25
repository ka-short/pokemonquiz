/* ===================================================================
   Type Duel — 2-player real-time mode (PeerJS, host-authoritative).

   Loaded AFTER app.js, so it reads app.js's script-scope globals directly:
   showScreen, newChallenge, renderTypes, answersFor, resolveName, isCorrect,
   hideSuggestions, showPopup, hidePopup, SPRITE, TYPE_NAMES, TYPE_COLORS,
   TYPE_IMG, shade, titleCase, nameDisplay, pokemonId, and the mutable globals
   `answered` and `gameMode`. The host owns all game state and arbitrates the
   "first correct answer"; the guest sends actions and renders broadcast state.
   =================================================================== */
(function () {
  "use strict";

  // ----- code/peer config -----
  const PEER_PREFIX = "pkmndtq-"; // namespace on the public PeerJS broker
  const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L
  const CODE_LEN = 5;

  // ----- state -----
  let peer = null;
  let conn = null;
  let role = null;          // "host" | "guest"
  let active = false;       // in a live session (controls disconnect handling)
  let dataReady = false;    // app.js finished building indexes
  let myName = "Trainer";
  let oppName = "";
  let mode = "casual";      // "casual" | "competition"
  let target = 5;
  let scores = { host: 0, guest: 0 };
  let picks = { host: null, guest: null };
  let myPick = null;
  let round = null;         // { types:[...], answers:Set, resolved:bool }

  // app.js tells us the Pokémon indexes are ready.
  window.onDataReady = function () {
    dataReady = true;
    refreshLobbyStart();
  };

  // expose the only hook app.js needs
  window.Duel = { submit: duelSubmit };

  /* ---------------- helpers ---------------- */
  const byId = (id) => document.getElementById(id);
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }
  function setMsg(id, text) { const el = byId(id); if (el) el.textContent = text || ""; }
  function send(msg) { if (conn && conn.open) { try { conn.send(msg); } catch (e) { /* ignore */ } } }
  function genCode() {
    let s = "";
    for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return s;
  }
  function nameOr(fallback) {
    const v = (byId("mp-name").value || "").trim();
    return v || fallback;
  }
  function rememberName(n) { try { localStorage.setItem("pkmn-name", n); } catch (e) {} }
  function friendlyErr(err) {
    switch (err && err.type) {
      case "peer-unavailable": return "No game with that code (it may have ended).";
      case "unavailable-id": return "Couldn't create a lobby — try again.";
      case "network":
      case "server-error":
      case "socket-error": return "Connection problem. Check your internet and retry.";
      case "browser-incompatible": return "Your browser doesn't support peer-to-peer play.";
      default: return "Connection error. Please try again.";
    }
  }

  /* ---------------- setup screen ---------------- */
  function openSetup() {
    teardownPeer();
    active = false;
    setMsg("setup-msg", "");
    byId("mp-code").value = "";
    try {
      const saved = localStorage.getItem("pkmn-name");
      if (saved && !byId("mp-name").value) byId("mp-name").value = saved;
    } catch (e) {}
    showScreen("setup");
  }

  function currentMode() {
    const active = byId("mp-mode").querySelector(".seg-btn.active");
    return active ? active.dataset.mode : "casual";
  }
  function currentTarget() {
    const n = parseInt(byId("mp-target").value, 10);
    return Math.max(1, Math.min(20, isNaN(n) ? 5 : n));
  }
  function modeLabel() {
    return mode === "competition" ? `Competition · first to ${target}` : "Casual · endless";
  }

  /* ---------------- hosting ---------------- */
  function hostLobby() {
    if (!window.Peer) { setMsg("setup-msg", "Multiplayer library failed to load."); return; }
    myName = nameOr("Host"); rememberName(myName);
    mode = currentMode(); target = currentTarget();
    role = "host"; active = true;
    scores = { host: 0, guest: 0 };
    setMsg("setup-msg", "Creating lobby…");
    tryHost(0);
  }
  function tryHost(attempt) {
    const code = genCode();
    peer = new Peer(PEER_PREFIX + code);
    peer.on("open", () => {
      showScreen("lobby");
      byId("lobby-code").textContent = code;
      byId("lobby-host").textContent = myName;
      byId("lobby-guest").textContent = "…waiting";
      byId("lobby-mode").textContent = modeLabel();
      byId("lobby-start").hidden = false;
      setMsg("lobby-msg", "Share the code with a friend to begin.");
      refreshLobbyStart();
    });
    peer.on("connection", (c) => {
      if (conn) { try { c.close(); } catch (e) {} return; } // only one opponent
      conn = c;
      wireConn();
    });
    peer.on("error", (err) => {
      if (err.type === "unavailable-id" && attempt < 5) {
        try { peer.destroy(); } catch (e) {}
        tryHost(attempt + 1);
        return;
      }
      handleFatalError(err);
    });
    peer.on("disconnected", () => { /* broker drop; P2P link stays up */ });
  }

  /* ---------------- joining ---------------- */
  function joinLobby() {
    if (!window.Peer) { setMsg("setup-msg", "Multiplayer library failed to load."); return; }
    const code = (byId("mp-code").value || "").trim().toUpperCase();
    if (code.length < CODE_LEN) { setMsg("setup-msg", "Enter the full lobby code."); return; }
    myName = nameOr("Guest"); rememberName(myName);
    role = "guest"; active = true;
    setMsg("setup-msg", "Connecting…");
    peer = new Peer();
    peer.on("open", () => {
      conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      wireConn();
    });
    peer.on("error", (err) => {
      if (active && role === "guest" && !(conn && conn.open)) setMsg("setup-msg", friendlyErr(err));
      else handleFatalError(err);
    });
    peer.on("disconnected", () => {});
  }

  /* ---------------- connection wiring ---------------- */
  function wireConn() {
    conn.on("open", onConnOpen);
    conn.on("data", onConnData);
    conn.on("close", opponentLeft);
    conn.on("error", () => opponentLeft());
  }
  function onConnOpen() {
    if (role === "host") {
      send({ type: "config", mode, target, scores });
      send({ type: "hello", name: myName });
      refreshLobbyStart();
    } else {
      send({ type: "hello", name: myName });
    }
  }
  function onConnData(msg) {
    if (!msg || !msg.type) return;
    if (role === "host") handleHostMsg(msg);
    else handleGuestMsg(msg);
  }

  function handleHostMsg(msg) {
    switch (msg.type) {
      case "hello":
        oppName = msg.name || "Guest";
        byId("lobby-guest").textContent = oppName;
        refreshLobbyStart();
        break;
      case "pick":
        picks.guest = msg.type;
        if (picks.host) checkBothPicks();
        else setMsg("pick-status", "Opponent locked in — your turn!");
        break;
      case "correct-claim":
        hostRegisterCorrect("guest", msg.name);
        break;
      case "rematch":
        if (mode) { startMatch(); }
        break;
      case "leave":
        opponentLeft();
        break;
    }
  }

  function handleGuestMsg(msg) {
    switch (msg.type) {
      case "config":
        mode = msg.mode; target = msg.target; scores = msg.scores || { host: 0, guest: 0 };
        showScreen("lobby");
        byId("lobby-code").textContent = (byId("mp-code").value || "").trim().toUpperCase();
        byId("lobby-guest").textContent = myName;
        byId("lobby-mode").textContent = modeLabel();
        byId("lobby-start").hidden = true;
        setMsg("lobby-msg", "Waiting for the host to start…");
        break;
      case "hello":
        oppName = msg.name || "Host";
        byId("lobby-host").textContent = oppName;
        break;
      case "start":
        scores = msg.scores || { host: 0, guest: 0 };
        enterPick();
        break;
      case "invalid-repick":
        repick(msg.message || "That typing has no Pokémon — pick again.");
        break;
      case "go":
        beginRound(msg.types);
        break;
      case "round-result":
        applyRoundResult(msg);
        break;
      case "next":
        enterPick();
        break;
      case "match-over":
        showMatchResult(msg);
        break;
      case "leave":
        opponentLeft();
        break;
    }
  }

  /* ---------------- lobby ---------------- */
  function refreshLobbyStart() {
    if (role !== "host") return;
    const btn = byId("lobby-start");
    if (btn) btn.disabled = !(conn && conn.open && dataReady);
  }

  // Host starts (or restarts for a rematch): reset score and send everyone to pick.
  function startMatch() {
    scores = { host: 0, guest: 0 };
    send({ type: "start", scores });
    enterPick();
  }

  /* ---------------- pick phase ---------------- */
  function enterPick() {
    round = null; myPick = null; picks = { host: null, guest: null };
    answered = true; // no guessing yet
    hidePopup();
    showScreen("pick");
    renderScorebars();
    renderTypeGrid();
    setMsg("pick-status", "");
    const lock = byId("pick-lock");
    lock.disabled = true; lock.textContent = "Lock in";
  }

  function renderTypeGrid() {
    const grid = byId("type-grid");
    grid.innerHTML = "";
    TYPE_NAMES.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "type-pick";
      b.dataset.type = t;
      b.style.background = `linear-gradient(160deg, ${TYPE_COLORS[t]}, ${shade(TYPE_COLORS[t], -25)})`;
      b.innerHTML = `<img src="${TYPE_IMG(t)}" alt="" /><span>${t}</span>`;
      b.addEventListener("click", () => selectType(t, b));
      grid.appendChild(b);
    });
  }
  function selectType(t, btn) {
    if (btn.classList.contains("locked")) return;
    myPick = t;
    byId("type-grid").querySelectorAll(".type-pick").forEach((x) => x.classList.toggle("sel", x === btn));
    byId("pick-lock").disabled = false;
  }
  function setGridLocked(locked) {
    byId("type-grid").querySelectorAll(".type-pick").forEach((x) => x.classList.toggle("locked", locked));
  }

  function lockPick() {
    if (!myPick) return;
    setGridLocked(true);
    const lock = byId("pick-lock");
    lock.disabled = true; lock.textContent = "Locked";
    setMsg("pick-status", "Locked in — waiting for opponent…");
    if (role === "host") { picks.host = myPick; checkBothPicks(); }
    else { send({ type: "pick", type: myPick }); }
  }

  // HOST ONLY: both picks are in — validate the combined typing.
  function checkBothPicks() {
    if (!picks.host || !picks.guest) return;
    const a = picks.host, b = picks.guest;
    const ans = answersFor(a, b);
    if (!ans.length) {
      const message = a === b
        ? `No pure ${titleCase(a)} Pokémon exists — pick again!`
        : `No ${titleCase(a)}/${titleCase(b)} Pokémon exists — pick again!`;
      send({ type: "invalid-repick", message });
      repick(message);
      return;
    }
    const types = a === b ? [a] : [a, b].sort();
    send({ type: "go", types });
    beginRound(types);
  }

  function repick(message) {
    myPick = null; picks = { host: null, guest: null };
    showScreen("pick");
    renderScorebars();
    renderTypeGrid();
    const lock = byId("pick-lock");
    lock.disabled = true; lock.textContent = "Lock in";
    setMsg("pick-status", message);
  }

  /* ---------------- round / play ---------------- */
  function beginRound(types) {
    const ans = answersFor(types[0], types[1] || types[0]);
    round = { types, answers: new Set(ans), resolved: false };
    hidePopup();
    showScreen("duel");
    renderScorebars();
    renderTypes(byId("duel-types"), types);
    byId("duel-feedback").innerHTML = "";
    const input = byId("guess");
    input.value = "";
    input.disabled = true; // unlocked when the countdown hits GO
    hideSuggestions();
    runCountdown(() => {
      if (!round || round.resolved) return; // decided during the countdown
      answered = false;
      input.disabled = false;
      input.focus();
    });
  }

  function runCountdown(done) {
    const el = byId("countdown");
    el.hidden = false;
    answered = true; // lock input during 3-2-1
    let n = 3;
    el.textContent = n;
    el.classList.remove("go");
    const iv = setInterval(() => {
      n--;
      if (n > 0) { el.textContent = n; }
      else if (n === 0) { el.textContent = "GO!"; el.classList.add("go"); }
      else { clearInterval(iv); el.hidden = true; done(); }
    }, 700);
  }

  function duelFeedback(msg, bad) {
    byId("duel-feedback").innerHTML = `<div class="inline-msg ${bad ? "bad" : ""}">${msg}</div>`;
  }

  // Called by app.js submitGuess() when gameMode === "duel".
  function duelSubmit(raw) {
    if (!round || round.resolved || answered) return;
    const name = resolveName(raw);
    if (!name) { duelFeedback(`"${esc(raw)}" isn't a Pokémon I recognize.`, true); return; }
    if (!isCorrect(name, round.answers)) {
      duelFeedback(`${nameDisplay[name]} doesn't fit — keep going!`, true);
      return;
    }
    // correct locally
    if (role === "host") {
      hostRegisterCorrect("host", name);
    } else {
      answered = true; // lock my input pending the host's ruling
      hideSuggestions();
      send({ type: "correct-claim", name, t: Date.now() });
      duelFeedback("✓ Sent — waiting on the ref…", false);
    }
  }

  // HOST ONLY: first valid correct (its own or a guest claim) wins the round.
  function hostRegisterCorrect(who, name) {
    if (!round || round.resolved) return;
    if (!isCorrect(name, round.answers)) return; // re-validate guest claims
    round.resolved = true;
    if (who === "host") scores.host++; else scores.guest++;
    const result = { type: "round-result", winner: who, name, scores: { ...scores } };
    send(result);
    applyRoundResult(result);
  }

  function applyRoundResult(res) {
    if (round) round.resolved = true;
    answered = true;
    scores = res.scores || scores;
    renderScorebars();
    const youWon = res.winner === role;
    const card = document.createElement("div");
    card.className = "result-card " + (youWon ? "correct" : "reveal");
    const who = youWon ? "You got it!" : `${esc(oppName || "Opponent")} got it!`;
    card.innerHTML = `
      <div class="big">${who}</div>
      <img src="${SPRITE(pokemonId[res.name])}" alt="" />
      <div class="sub">${nameDisplay[res.name]}</div>
      <div class="answers">${scoreLine()}</div>`;
    if (role === "host") {
      const matchPoint = mode === "competition" && (scores.host >= target || scores.guest >= target);
      const next = document.createElement("button");
      next.className = "btn next";
      next.textContent = matchPoint ? "See result →" : "Next round →";
      next.addEventListener("click", hostNext);
      card.appendChild(next);
    } else {
      const note = document.createElement("div");
      note.className = "answers waiting";
      note.textContent = "Waiting for host…";
      card.appendChild(note);
    }
    showPopup(card);
  }

  function hostNext() {
    if (mode === "competition" && (scores.host >= target || scores.guest >= target)) {
      const winner = scores.host >= target ? "host" : "guest";
      const payload = { type: "match-over", winner, scores: { ...scores } };
      send(payload);
      showMatchResult(payload);
    } else {
      send({ type: "next" });
      enterPick();
    }
  }

  function showMatchResult(res) {
    scores = res.scores || scores;
    renderScorebars();
    answered = true;
    const youWon = res.winner === role;
    const card = document.createElement("div");
    card.className = "result-card " + (youWon ? "correct" : "reveal");
    card.innerHTML = `
      <div class="big">${youWon ? "🏆 You win!" : `${esc(oppName || "Opponent")} wins`}</div>
      <div class="answers">${scoreLine()}</div>`;
    const rematch = document.createElement("button");
    rematch.className = "btn next";
    rematch.textContent = "Rematch";
    rematch.addEventListener("click", () => {
      if (role === "host") { startMatch(); }
      else { send({ type: "rematch" }); rematch.disabled = true; rematch.textContent = "Asked…"; }
    });
    card.appendChild(rematch);
    const leave = document.createElement("button");
    leave.className = "btn ghost";
    leave.textContent = "Leave";
    leave.addEventListener("click", leaveMatch);
    card.appendChild(leave);
    showPopup(card);
  }

  /* ---------------- scoreboard ---------------- */
  function scoreLine() {
    const me = role === "host" ? scores.host : scores.guest;
    const opp = role === "host" ? scores.guest : scores.host;
    return `${esc(myName)} ${me} — ${opp} ${esc(oppName || "Opponent")}`;
  }
  function scoreboardHTML() {
    const me = role === "host" ? scores.host : scores.guest;
    const opp = role === "host" ? scores.guest : scores.host;
    const modeTxt = mode === "competition" ? `First to ${target}` : "Casual";
    return `<span class="sb-side"><b>${esc(myName)}</b> ${me}</span>
            <span class="sb-mode">${modeTxt}</span>
            <span class="sb-side">${opp} <b>${esc(oppName || "Opponent")}</b></span>`;
  }
  function renderScorebars() {
    const html = scoreboardHTML();
    ["scorebar-pick", "scorebar-duel"].forEach((id) => { const el = byId(id); if (el) el.innerHTML = html; });
  }

  /* ---------------- disconnect / teardown ---------------- */
  function notify(msg) {
    hidePopup();
    const card = document.createElement("div");
    card.className = "result-card reveal";
    card.innerHTML = `<div class="big">Heads up</div><div class="answers">${esc(msg)}</div>`;
    const ok = document.createElement("button");
    ok.className = "btn next"; ok.textContent = "OK";
    ok.addEventListener("click", hidePopup);
    card.appendChild(ok);
    showPopup(card);
  }

  function opponentLeft() {
    if (!active) return;
    active = false;
    teardownPeer();
    showScreen("solo");
    newChallenge();
    notify("Opponent left the game.");
  }

  function handleFatalError(err) {
    if (!active) return;
    active = false;
    teardownPeer();
    showScreen("solo");
    newChallenge();
    notify(friendlyErr(err));
  }

  function leaveMatch() {
    send({ type: "leave" });
    active = false;
    teardownPeer();
    hidePopup();
    showScreen("solo");
    newChallenge();
  }

  function teardownPeer() {
    try { if (conn) conn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    conn = null; peer = null; role = null;
    round = null; picks = { host: null, guest: null }; myPick = null;
    answered = false;
  }

  /* ---------------- wire up DOM ---------------- */
  function init() {
    byId("to-duel").addEventListener("click", openSetup);
    byId("setup-back").addEventListener("click", () => { teardownPeer(); active = false; showScreen("solo"); newChallenge(); });

    // mode segmented control
    byId("mp-mode").querySelectorAll(".seg-btn").forEach((b) => {
      b.addEventListener("click", () => {
        byId("mp-mode").querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
        byId("mp-target-field").hidden = b.dataset.mode !== "competition";
      });
    });

    byId("mp-host").addEventListener("click", hostLobby);
    byId("mp-join").addEventListener("click", joinLobby);
    byId("mp-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinLobby(); });

    byId("lobby-start").addEventListener("click", () => { if (role === "host") startMatch(); });
    byId("lobby-leave").addEventListener("click", leaveMatch);

    byId("pick-lock").addEventListener("click", lockPick);
    byId("pick-leave").addEventListener("click", leaveMatch);

    byId("duel-submit").addEventListener("click", () => submitGuess());
    byId("duel-leave").addEventListener("click", leaveMatch);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
