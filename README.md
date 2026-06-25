# Dual Type Pokémon Quiz

A browser quiz that shows you two Pokémon types and challenges you to name a
Pokémon that has **both** of them. Built as a single static site — no backend,
no build step, no API key.

![type challenge](https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/types/generation-viii/sword-shield/10.png)

## Features

- **Two-type challenges** generated from real Pokémon, so every prompt is solvable.
- **Autocomplete** with mini sprites as you type.
- **Instant local validation** — type data is fetched once and cached, so guesses
  don't hit the network.
- **Wrong-guess cards** showing the actual typing of whatever you guessed.
- **Streak + best streak** (best is saved across sessions).
- **Skip** and **Give up** (reveals the answers).
- **Alternate forms included**: Alolan / Galarian / Hisuian / Paldean regionals,
  every Mega Evolution & Primal (including the new *Pokémon Legends: Z-A* megas),
  and notable signature forms (Rotom appliances, Wormadam, Calyrex, Therian
  formes, Crowned Zacian/Zamazenta, and more). Purely cosmetic variants are left out.

## How it works

On load, the app fetches all 18 type lists from [PokéAPI](https://pokeapi.co),
builds a `Pokémon → types` map plus the set of valid dual-type combinations, and
caches the result in `localStorage` for 24h. Type badge images and Pokémon
sprites come from the [PokéAPI sprites](https://github.com/PokeAPI/sprites) repo.

## Credits

Data & sprites from [PokéAPI](https://pokeapi.co). This is a fan project and is
not affiliated with Nintendo, Game Freak, or The Pokémon Company.
