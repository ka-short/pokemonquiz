/* ====== Constants ====== */
const TYPE_IDS = {
  normal: 1, fighting: 2, flying: 3, poison: 4, ground: 5, rock: 6,
  bug: 7, ghost: 8, steel: 9, fire: 10, water: 11, grass: 12,
  electric: 13, psychic: 14, ice: 15, dragon: 16, dark: 17, fairy: 18,
};
const TYPE_NAMES = Object.keys(TYPE_IDS);

const TYPE_COLORS = {
  normal: "#9099a1", fighting: "#ce4069", flying: "#8fa8dd", poison: "#ab6ac8",
  ground: "#d97746", rock: "#c7b78b", bug: "#90c12c", ghost: "#5269ac",
  steel: "#5a8ea1", fire: "#ff9d55", water: "#4d90d5", grass: "#63bb5b",
  electric: "#f4d23c", psychic: "#f97176", ice: "#74cec0", dragon: "#0b6dc3",
  dark: "#5a5366", fairy: "#ec8fe6",
};

const SPRITE = (id) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;
const TYPE_IMG = (name) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/types/generation-viii/sword-shield/${TYPE_IDS[name]}.png`;

const MIN_ANSWERS = 1;          // combos must have at least this many valid Pokémon
const CACHE_KEY = "pkmn-dual-data-v3";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Forms with id >= 10000 are alternate forms. We include regional forms (Alolan etc)
const REGION_TAGS = ["alola", "galar", "hisui", "paldea"];
const REGION_LABELS = { alola: "Alolan", galar: "Galarian", hisui: "Hisuian", paldea: "Paldean" };

// Notable signature / battle forms (beyond regional + mega/primal). Many change their typinng
const NOTABLE_FORMS = new Set([
  "rotom-heat", "rotom-wash", "rotom-frost", "rotom-fan", "rotom-mow",
  "wormadam-sandy", "wormadam-trash",
  "darmanitan-zen",
  "calyrex-ice", "calyrex-shadow",
  "necrozma-dawn", "necrozma-dusk", "necrozma-ultra",
  "kyurem-black", "kyurem-white",
  "tornadus-therian", "thundurus-therian", "landorus-therian", "enamorus-therian",
  "shaymin-sky",
  "giratina-origin", "dialga-origin", "palkia-origin",
  "hoopa-unbound",
  "meloetta-pirouette",
  "zygarde-complete",
  "aegislash-blade",
  "ursaluna-bloodmoon",
  "zacian-crowned", "zamazenta-crowned",
]);

function isIncluded(name, id) {
  if (id < 10000) return true;              // base species
  if (name.includes("totem")) return false; 
  if (NOTABLE_FORMS.has(name)) return true;
  const parts = name.split("-");
  if (parts.includes("mega") || parts.includes("primal")) return true;
  return REGION_TAGS.some((r) => parts.includes(r));
}

/* ====== State ====== */
let pokemonToTypes = {};  // name -> [type, type]
let pokemonId = {};       // name -> dex id
let simpleToName = {};    // normalized alias -> canonical name
let nameDisplay = {};     // canonical name -> pretty display label
let searchItems = [];     // [{ name, display, id, types, keys }] for autocomplete
let combos = {};          // "typeA|typeB" -> [names]
let monos = {};           // type -> [names] for pure single-type Pokémon
let comboKeys = [];       // playable dual-type combo keys
let monoKeys = [];        // playable pure single-type keys (for solo mono rounds)
let current = null;       // { types: [a,b], answers: Set }
let answered = false;     // locked until "Next"
let activeSuggestion = -1;
let gameMode = "solo";    // "solo" | "duel" | "mp" (lobby/setup/pick screens)

/* ====== Helpers ====== */
const $ = (id) => document.getElementById(id);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const titleCase = (s) =>
  s.split(/[-\s]/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

// Turn an API name into a human label.
function displayName(name) {
  const parts = name.split("-");
  if (parts.includes("primal")) {
    return "Primal " + titleCase(parts.filter((p) => p !== "primal").join(" "));
  }
  if (parts.includes("mega")) {
    const i = parts.indexOf("mega");
    const species = titleCase(parts.slice(0, i).join(" "));
    const tail = parts.slice(i + 1).map((t) => t.toUpperCase()).join(" "); // X/Y/Z
    return ("Mega " + species + (tail ? " " + tail : "")).trim();
  }
  for (let i = 0; i < parts.length; i++) {
    if (REGION_LABELS[parts[i]]) {
      const species = titleCase(parts.slice(0, i).join(" "));
      const extra = parts.slice(i + 1).filter((e) => e !== "breed" && e !== "standard");
      let label = REGION_LABELS[parts[i]] + " " + species;
      if (extra.length) label += " (" + titleCase(extra.join(" ")) + ")";
      return label.trim();
    }
  }
  // Other alternate forms (id >= 10000) -> "Species (Form)", e.g. "Rotom (Heat)".
  // Base species (id < 10000) keep their plain name, incl. hyphenated ones (Ho-Oh).
  if ((pokemonId[name] || 0) >= 10000 && parts.length > 1) {
    return `${titleCase(parts[0])} (${titleCase(parts.slice(1).join(" "))})`;
  }
  return titleCase(name);
}

/* ====== Data loading ====== */
async function loadData() {
  const cached = loadCache();
  if (cached) return cached;

  let done = 0;
  const fetches = TYPE_NAMES.map((t) =>
    fetch(`https://pokeapi.co/api/v2/type/${t}`)
      .then((r) => r.json())
      .then((d) => {
        done++;
        $("loader-text").textContent = `Loading Pokémon data… (${done}/${TYPE_NAMES.length})`;
        return d;
      })
  );
  const results = await Promise.all(fetches);

  const p2t = {};
  const pid = {};
  results.forEach((data) => {
    const tname = data.name;
    data.pokemon.forEach((entry) => {
      const name = entry.pokemon.name;
      const id = parseInt(entry.pokemon.url.split("/").filter(Boolean).pop(), 10);
      if (!isIncluded(name, id)) return; // keep base + regional + mega/primal only
      (p2t[name] = p2t[name] || []).push(tname);
      pid[name] = id;
    });
  });

  const data = { pokemonToTypes: p2t, pokemonId: pid };
  saveCache(data);
  return data;
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.t > CACHE_TTL) return null;
    return { pokemonToTypes: obj.pokemonToTypes, pokemonId: obj.pokemonId };
  } catch {
    return null;
  }
}
function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), ...data }));
  } catch {
    /* storage full / disabled — fine */
  }
}

/* ====== Build indexes ====== */
function buildIndexes() {
  simpleToName = {};
  nameDisplay = {};
  searchItems = [];

  Object.keys(pokemonToTypes).sort().forEach((n) => {
    const display = displayName(n);
    nameDisplay[n] = display;
    // index by both the API spelling and the pretty label so that e.g.
    // "growlithe hisui", "hisuian growlithe", "charizard mega x" all match.
    const aliases = [norm(n), norm(display)];
    // also index the reversed token order so "heat rotom" / "black kyurem" hit.
    if ((pokemonId[n] || 0) >= 10000) {
      aliases.push(norm(n.split("-").reverse().join("")));
    }
    const keys = Array.from(new Set(aliases));
    keys.forEach((k) => { if (!(k in simpleToName)) simpleToName[k] = n; });
    searchItems.push({ name: n, display, id: pokemonId[n], types: pokemonToTypes[n], keys });
  });

  combos = {};
  monos = {};
  for (const [name, types] of Object.entries(pokemonToTypes)) {
    if (types.length === 1) {
      (monos[types[0]] = monos[types[0]] || []).push(name);
    } else if (types.length === 2) {
      const key = [...types].sort().join("|");
      (combos[key] = combos[key] || []).push(name);
    }
  }
  comboKeys = Object.keys(combos).filter((k) => combos[k].length >= MIN_ANSWERS);
  monoKeys = Object.keys(monos).filter((t) => monos[t].length >= MIN_ANSWERS);
}

// Pokémon whose typing is exactly {a, b} — or exactly {a} when a === b (pure mono).
// Used by both the validity check and the answer set for a duel round.
function answersFor(a, b) {
  if (a === b) return monos[a] || [];
  return combos[[a, b].sort().join("|")] || [];
}

/* ====== Streak ====== */
function getBest() {
  return parseInt(localStorage.getItem("pkmn-best") || "0", 10);
}
function setStreak(n) {
  $("streak").textContent = n;
  if (n > getBest()) {
    localStorage.setItem("pkmn-best", n);
    $("best").textContent = n;
  }
}
let streak = 0;

/* ====== Game flow ====== */
// Render the "Type + Type" (or single Type) challenge cards into a container.
function renderTypes(container, types) {
  container.innerHTML = "";
  types.forEach((t, i) => {
    if (i > 0) {
      const plus = document.createElement("span");
      plus.className = "type-plus";
      plus.textContent = "+";
      container.appendChild(plus);
    }
    const card = document.createElement("div");
    card.className = "type-card";
    card.style.background = `linear-gradient(160deg, ${TYPE_COLORS[t]}, ${shade(TYPE_COLORS[t], -25)})`;
    const img = document.createElement("img");
    img.src = TYPE_IMG(t);
    img.alt = t;
    img.onerror = () => { img.style.display = "none"; };
    const label = document.createElement("span");
    label.className = "type-name";
    label.textContent = t;
    card.append(img, label);
    container.appendChild(card);
  });
} 

// Roughly 1 in 4 solo rounds is a pure single-type ("mono") challenge.
const MONO_CHANCE = 0.10;

// Swap the solo prompt between the dual-type and pure single-type wording.
function setSoloPrompt(types) {
  const el = document.querySelector("#screen-solo .prompt");
  if (!el) return;
  el.innerHTML = types.length === 1
    ? `Name a Pokémon that is <strong>purely</strong> this type:`
    : `Name a Pokémon that is <strong>both</strong> of these types:`;
}

function newChallenge() {
  answered = false;

  let types, answers;
  if (monoKeys.length && Math.random() < MONO_CHANCE) {
    const t = monoKeys[Math.floor(Math.random() * monoKeys.length)];
    types = [t];
    answers = new Set(monos[t]);
  } else {
    const key = comboKeys[Math.floor(Math.random() * comboKeys.length)];
    types = key.split("|");
    answers = new Set(combos[key]);
  }
  current = { types, answers };

  setSoloPrompt(types);
  renderTypes($("types"), types);

  // reset input
  const input = $("guess");
  input.value = "";
  input.disabled = false;
  $("feedback").innerHTML = "";
  hidePopup();
  hideSuggestions();
  input.focus();
}

// Normalize raw user text to a canonical Pokémon name (or undefined if unknown).
function resolveName(raw) {
  return simpleToName[norm(raw)];
}
// Is `name` a valid answer for the given answers Set?
function isCorrect(name, answersSet) {
  return answersSet.has(name);
}

function submitGuess() {
  if (answered) return;
  const raw = $("guess").value.trim();
  if (!raw) return;
  hideSuggestions();

  // In a duel, hand off to the multiplayer module (its own validation + netcode).
  if (gameMode === "duel") {
    window.Duel?.submit(raw);
    return;
  }

  const name = resolveName(raw);
  if (!name) {
    showInline(`"${raw}" isn't a Pokémon I recognize.`);
    return;
  }
  if (isCorrect(name, current.answers)) {
    onCorrect(name);
  } else {
    onWrong(name);
  }
}

function onCorrect(name) {
  answered = true;
  streak++;
  setStreak(streak);
  $("guess").disabled = true;

  const fb = $("feedback");
  fb.innerHTML = "";
  const card = document.createElement("div");
  card.className = "result-card correct";
  card.innerHTML = `
    <div class="big">Correct! ✓</div>
    <img src="${SPRITE(pokemonId[name])}" alt="${name}" />
    <div class="sub">${nameDisplay[name]}</div>
  `;
  const next = document.createElement("button");
  next.className = "btn next";
  next.textContent = "Next →";
  next.onclick = newChallenge;
  card.appendChild(next);
  showPopup(card);
}

function showPopup(card) {
  const ov = $("overlay");
  ov.innerHTML = "";
  ov.appendChild(card);
  ov.hidden = false;
}
function hidePopup() {
  const ov = $("overlay");
  ov.hidden = true;
  ov.innerHTML = "";
}

function onWrong(name) {
  // wrong guess breaks nothing yet — just inform + add side card
  streak = 0;
  setStreak(0);
  addWrongCard(name);
  const msg = current.types.length === 1
    ? `${nameDisplay[name]} isn't a pure ${titleCase(current.types[0])} type. Try again!`
    : `${nameDisplay[name]} isn't both of those types. Try again!`;
  showInline(msg, true);
}

function showInline(msg, bad = true) {
  const fb = $("feedback");
  fb.innerHTML = `<div class="inline-msg ${bad ? "bad" : ""}">${msg}</div>`;
}

function addWrongCard(name) {
  const list = $("wrong-list");
  $("sidebar-hint").style.display = "none";

  // de-dupe: if already shown, move to top
  const existing = list.querySelector(`[data-name="${name}"]`);
  if (existing) {
    list.prepend(existing);
    existing.style.animation = "none";
    void existing.offsetWidth;
    existing.style.animation = "";
    return;
  }

  const types = pokemonToTypes[name];
  const card = document.createElement("div");
  card.className = "wrong-card";
  card.dataset.name = name;
  card.innerHTML = `
    <button class="wrong-close" type="button" aria-label="Dismiss" title="Dismiss">X</button>
    <img src="${SPRITE(pokemonId[name])}" alt="${name}" />
    <div>
      <div class="wc-name">${nameDisplay[name]}</div>
      <div class="wc-types">
        ${types.map((t) => `<span class="mini-type" style="background:${TYPE_COLORS[t]}">${t}</span>`).join("")}
      </div>
    </div>`;
  card.querySelector(".wrong-close").addEventListener("click", () => {
    card.remove();
    if (!list.children.length) $("sidebar-hint").style.display = "";
  });
  list.prepend(card);
}

function giveUp() {
  if (answered) return;
  answered = true;
  streak = 0;
  setStreak(0);
  $("guess").disabled = true;

  const answers = [...current.answers].sort();
  const sample = answers.slice(0, 8).map((n) => nameDisplay[n]).join(", ");
  const more = answers.length > 8 ? `, +${answers.length - 8} more` : "";

  const fb = $("feedback");
  fb.innerHTML = "";
  const card = document.createElement("div");
  card.className = "result-card reveal";
  card.innerHTML = `
    <div class="big">Answers</div>
    <div class="answers">${sample}${more}</div>
  `;
  const next = document.createElement("button");
  next.className = "btn next";
  next.textContent = "Next →";
  next.onclick = newChallenge;
  card.appendChild(next);
  showPopup(card);
}

/* ====== Autocomplete ====== */
function updateSuggestions() {
  if (answered) return;
  const q = norm($("guess").value);
  const box = $("suggestions");
  if (q.length < 1) return hideSuggestions();

  const starts = [];
  const contains = [];
  for (const item of searchItems) {
    if (item.keys.some((k) => k.startsWith(q))) starts.push(item);
    else if (item.keys.some((k) => k.includes(q))) contains.push(item);
  }
  const matches = starts.concat(contains).slice(0, 8);
  if (!matches.length) return hideSuggestions();

  activeSuggestion = -1;
  box.innerHTML = matches
    .map(
      (it) => `
      <li data-name="${it.name}">
        <img src="${SPRITE(it.id)}" alt="" loading="lazy" />
        <span class="s-name">${it.display}</span>
      </li>`
    )
    .join("");
  box.hidden = false;

  box.querySelectorAll("li").forEach((li) => {
    li.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus
      $("guess").value = nameDisplay[li.dataset.name];
      submitGuess();
    });
  });
}

function hideSuggestions() {
  const box = $("suggestions");
  box.hidden = true;
  box.innerHTML = "";
  activeSuggestion = -1;
}

function moveSuggestion(dir) {
  const items = [...$("suggestions").querySelectorAll("li")];
  if (!items.length) return;
  items.forEach((li) => li.classList.remove("active"));
  activeSuggestion = (activeSuggestion + dir + items.length) % items.length;
  const li = items[activeSuggestion];
  li.classList.add("active");
  li.scrollIntoView({ block: "nearest" });
}

/* ====== Small color util ====== */
function shade(hex, percent) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + percent;
  let g = ((n >> 8) & 0xff) + percent;
  let b = (n & 0xff) + percent;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/* ====== Screens ====== */
const SCREENS = ["solo", "setup", "lobby", "pick", "duel"];
function showScreen(name) {
  SCREENS.forEach((s) => {
    const el = $("screen-" + s);
    if (el) el.hidden = s !== name;
  });
  const duelBtn = $("to-duel");
  if (duelBtn) duelBtn.hidden = name !== "solo";
  const streaks = document.querySelector(".streaks");
  if (streaks) streaks.hidden = name !== "solo";
  gameMode = name === "solo" ? "solo" : name === "duel" ? "duel" : "mp";
  // The guess input + autocomplete is one shared element; move it to the active
  // screen so its listeners (autocomplete, Enter handling) keep working as-is.
  if (name === "duel") moveInput("duel-input-slot");
  else if (name === "solo") moveInput("solo-input-slot");
}
function moveInput(slotId) {
  const slot = $(slotId);
  const wrap = $("input-wrap");
  if (slot && wrap && wrap.parentNode !== slot) slot.appendChild(wrap);
}

/* ====== Wire up ====== */
function attachEvents() {
  $("submit").onclick = submitGuess;
  $("skip").onclick = () => { if (!answered) newChallenge(); };
  $("giveup").onclick = giveUp;

  const input = $("guess");
  input.addEventListener("input", updateSuggestions);
  input.addEventListener("focus", updateSuggestions);
  input.addEventListener("blur", () => setTimeout(hideSuggestions, 120));

  input.addEventListener("keydown", (e) => {
    const open = !$("suggestions").hidden;
    if (e.key === "ArrowDown") { e.preventDefault(); moveSuggestion(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggestion(-1); }
    else if (e.key === "Escape") { hideSuggestions(); }
    else if (e.key === "Enter") {
      // Adopt the highlighted suggestion, or the first one if none is highlighted,
      // so typing "luca" + Enter submits "Lucario" rather than the raw text.
      if (open) {
        const items = $("suggestions").querySelectorAll("li");
        if (items.length) {
          const idx = activeSuggestion >= 0 ? activeSuggestion : 0;
          input.value = nameDisplay[items[idx].dataset.name];
        }
      }
      // Don't let this same Enter bubble to the popup's advance handler
      // (that would instantly skip the Correct! popup we're about to open).
      e.preventDefault();
      e.stopPropagation();
      submitGuess();
    }
  });

  // While a SOLO result popup is open, Enter / Space advances to the next
  // challenge. In a duel the host controls advancing, so don't hijack keys.
  document.addEventListener("keydown", (e) => {
    if (gameMode !== "solo") return;
    if ($("overlay").hidden) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      newChallenge();
    }
  });
}

/* ====== Init ====== */
(async function init() {
  $("best").textContent = getBest();
  try {
    const data = await loadData();
    pokemonToTypes = data.pokemonToTypes;
    pokemonId = data.pokemonId;
    buildIndexes();
    attachEvents();
    showScreen("solo");
    newChallenge();
    $("loader").classList.add("hide");
    // Let the multiplayer module know the Pokémon indexes are ready.
    // Leave a flag too: on the cached path this callback can fire in the
    // microtask gap *before* multiplayer.js has run and defined onDataReady,
    // so the flag lets that script catch up when it loads.
    window.pkmnDataReady = true;
    window.onDataReady?.();
  } catch (err) {
    $("loader-text").textContent = "Couldn't load Pokémon data. Check your connection and refresh.";
    console.error(err);
  }
})();
