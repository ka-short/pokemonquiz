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

const MIN_ANSWERS = 2;          // combos must have at least this many valid Pokémon
const CACHE_KEY = "pkmn-dual-data-v3";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Forms with id >= 10000 are alternate forms. We include regional forms (Alolan/
// Galarian/Hisuian/Paldean) and every Mega / Primal. Note: Pokémon Legends: Z-A
// (2025) made nearly all Mega Evolutions canon — including the Johto starters
// (Mega Meganium etc.) and "Mega X/Y/Z" variants — so a simple Mega/Primal rule
// is now correct. We skip only purely cosmetic forms (sizes, colors, builds,
// Gigantamax, totem duplicates), which never change typing.
const REGION_TAGS = ["alola", "galar", "hisui", "paldea"];
const REGION_LABELS = { alola: "Alolan", galar: "Galarian", hisui: "Hisuian", paldea: "Paldean" };

// Notable signature / battle forms (beyond regional + mega/primal). Many change
// typing (Rotom appliances, Wormadam, Darmanitan Zen, Calyrex, Crowned Zacian…);
// a few keep their typing but are iconic alternate forms worth including. Pure
// cosmetic variants (colors, sizes, costumes, builds, Gigantamax) are left out.
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
  if (name.includes("totem")) return false; // cosmetic totem duplicates
  if (NOTABLE_FORMS.has(name)) return true;
  const parts = name.split("-");
  if (parts.includes("mega") || parts.includes("primal")) return true; // all canon
  return REGION_TAGS.some((r) => parts.includes(r));
}

/* ====== State ====== */
let pokemonToTypes = {};  // name -> [type, type]
let pokemonId = {};       // name -> dex id
let simpleToName = {};    // normalized alias -> canonical name
let nameDisplay = {};     // canonical name -> pretty display label
let searchItems = [];     // [{ name, display, id, types, keys }] for autocomplete
let combos = {};          // "typeA|typeB" -> [names]
let comboKeys = [];       // playable combo keys
let current = null;       // { types: [a,b], answers: Set }
let answered = false;     // locked until "Next"
let activeSuggestion = -1;

/* ====== Helpers ====== */
const $ = (id) => document.getElementById(id);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const titleCase = (s) =>
  s.split(/[-\s]/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

// Turn an API name into a human label: "growlithe-hisui" -> "Hisuian Growlithe",
// "charizard-mega-x" -> "Mega Charizard X", "groudon-primal" -> "Primal Groudon".
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
  for (const [name, types] of Object.entries(pokemonToTypes)) {
    if (types.length !== 2) continue;
    const key = [...types].sort().join("|");
    (combos[key] = combos[key] || []).push(name);
  }
  comboKeys = Object.keys(combos).filter((k) => combos[k].length >= MIN_ANSWERS);
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
function newChallenge() {
  answered = false;
  const key = comboKeys[Math.floor(Math.random() * comboKeys.length)];
  const types = key.split("|");
  current = { types, answers: new Set(combos[key]) };

  // render type cards
  const wrap = $("types");
  wrap.innerHTML = "";
  types.forEach((t, i) => {
    if (i > 0) {
      const plus = document.createElement("span");
      plus.className = "type-plus";
      plus.textContent = "+";
      wrap.appendChild(plus);
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
    wrap.appendChild(card);
  });

  // reset input
  const input = $("guess");
  input.value = "";
  input.disabled = false;
  $("feedback").innerHTML = "";
  hideSuggestions();
  input.focus();
}

function submitGuess() {
  if (answered) return;
  const raw = $("guess").value.trim();
  if (!raw) return;
  hideSuggestions();

  const name = simpleToName[norm(raw)];
  if (!name) {
    showInline(`"${raw}" isn't a Pokémon I recognize.`);
    return;
  }

  if (current.answers.has(name)) {
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
  fb.appendChild(card);
  next.focus();
}

function onWrong(name) {
  // wrong guess breaks nothing yet — just inform + add side card
  streak = 0;
  setStreak(0);
  addWrongCard(name);
  showInline(`${nameDisplay[name]} isn't both of those types. Try again!`, true);
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
    <img src="${SPRITE(pokemonId[name])}" alt="${name}" />
    <div>
      <div class="wc-name">${nameDisplay[name]}</div>
      <div class="wc-types">
        ${types.map((t) => `<span class="mini-type" style="background:${TYPE_COLORS[t]}">${t}</span>`).join("")}
      </div>
    </div>`;
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
  fb.appendChild(card);
  next.focus();
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
      if (open && activeSuggestion >= 0) {
        const li = $("suggestions").querySelectorAll("li")[activeSuggestion];
        input.value = nameDisplay[li.dataset.name];
      }
      submitGuess();
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
    newChallenge();
    $("loader").classList.add("hide");
  } catch (err) {
    $("loader-text").textContent = "Couldn't load Pokémon data. Check your connection and refresh.";
    console.error(err);
  }
})();
