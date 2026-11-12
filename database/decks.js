/* database/decks.js - LOGISTIC (DECK) LISTS. Written by the game's deck builder.
   One line per card: <copies> <exact card name>. The key is the deck name. */
const DECK_MIN = 40
  , DECK_MAX_COPIES = 4;
const DECK_LISTS = {
    Veyrani: `
    4 Blood Siphon
    4 Sqietch Device
    4 Sqietch Resupply
    4 Veriel, Scout Leader
    4 Veyr Beacon
    4 Qarseem, Sand Warden
    4 Shaqari, Caravan Elder
    4 Sqietch Reservoir
    4 Thareq, Wormrider Elder
    4 Grave Altar
    `,
    Vulkar: `
    4 Burn Forward
    4 Dune Skirmisher
    4 Reprieve
    4 Grave Altar
    2 Ossuary
    4 Sahri Raider
    4 Solar Flare
    4 Glasshide Brute
    4 Dust Colossus
    4 Ember Lancer
    2 Factory Reset
    `,
    Veilbord: `
    4 Echo Drifter
    4 Rite Priest
    4 Grave Tapper
    4 Ashen Revenant
    4 Void Reaver
    4 Tithe
    4 Reprieve
    4 Blood Siphon
    4 Ossuary
    4 Grave Altar
    `,
    Caelor: `
    4 Reprieve
    4 Grave Altar
    2 Aurastelar
    2 Senatum Revisio
    2 Praedicolum
    3 Sinner
    2 Mobil the flota
    2 Aqualacum
    4 Oasiacustod, The Guard
    2 Phalanx Legate
    3 Vitagladium, The Lifeblade
    4 Praetorum, Aurelion Titan
    3 Rector Auresol
    3 Blood Siphon
    `,
    Astronav: `
    4 Ex-syn, The Recycler
    1 Blood Siphon
    4 Reprieve
    4 Theta, Prism Cutter
    2 Kry, The Calibrator
    3 Omnix, Vector Sentinel
    2 Ix, The Oracle Array
    2 Factory Reset
    4 Overcharge
    1 Archive Core
    2 Gravity Lock
    2 Decommission
    2 Synthetic Lume
    4 Recalculate
    3 Arkh, Lume Heart
    3 Synaxion, Path Navigator
    2 Biofuel Recycle
    `,
    Alliance: `
    4 Veyr Beacon
    2 Glasshide Brute
    3 Sahri Raider
    3 Grave Altar
    4 Reprieve
    3 Solar Flare
    2 Burn Forward
    3 Blood Siphon
    3 Dune Skirmisher
    1 Thareq, Wormrider Elder
    2 Oasiacustod, The Guard
    3 Senatum Revisio
    2 Vitagladium, The Lifeblade
    1 Rector Auresol
    2 Praetorum, Aurelion Titan
    2 Sinner
    `
};
