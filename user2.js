/* database/user.js - PLAYER PROFILE DATA.
   Everything about the player lives here: starting values, the saved username and tag, and the match history
   (Recently Played + profile stats). index.html only draws it.
   Saved in this browser's localStorage; edit USER_DEFAULT to change the placeholder values. */

const USER_DEFAULT = {
    name: 'DuneMaster',   /* username until the player changes it (3-16 characters) */
    gold: 20,           /* gold in the top bar */
    lume: 0,              /* Lume shards in the top bar */
    masteryLevel: 1,      /* Profile > Progression > Mastery */
    avatar: {
        name: 'Dune Master',
        desc: 'A caravan scout who reads the wind before the sand moves. Avatar details are a placeholder for now.'
    }
};

/* ---- match rewards + wallet ----
   Every finished Versus AI match pays GOLD (shown in the top bar, #hmGold). A Ranked match (for now also played against the AI) pays LUME instead (#hmLume).
   Spectating AI vs AI pays nothing. The wallet starts at USER_DEFAULT.gold / USER_DEFAULT.lume and is saved in this browser.
   Edit the numbers below to change the rewards. */
const REWARD = {
    normal: { gold: { win: 10, loss: 5, draw: 5 } },   /* Versus AI: gold per result */
    ranked: { lume: { win: 3, loss: 1, draw: 1 } }     /* Ranked:    Lume per result */
};
const WALLET_KEY = 'aetheris.wallet.v1';
let walletMem = null;
function loadWallet() {
    let w = null;
    try {
        w = JSON.parse(localStorage.getItem(WALLET_KEY) || 'null')
    } catch (e) {
        w = walletMem
    }
    w = w && typeof w == 'object' ? w : walletMem || {};
    const n = (v, d) => isFinite(+v) && v != null ? Math.max(0, Math.floor(+v)) : d;
    return { gold: n(w.gold, USER_DEFAULT.gold), lume: n(w.lume, USER_DEFAULT.lume) }
}
function saveWallet(w) {
    walletMem = w;
    try {
        localStorage.setItem(WALLET_KEY, JSON.stringify(w))
    } catch (e) {}
}
/* pays the reward of one finished match: ranked = true pays Lume, otherwise Gold. Returns what was paid, e.g. { gold: 10, lume: 0 } */
function addReward(ranked, res) {
    const tb = (REWARD[ranked ? 'ranked' : 'normal'] || {}), r = { gold: 0, lume: 0 };
    ['gold', 'lume'].forEach(k => {
        const t = tb[k];
        r[k] = t ? Math.max(0, Math.floor(+(t[res] != null ? t[res] : t.draw) || 0)) : 0
    });
    const w = loadWallet();
    w.gold += r.gold;
    w.lume += r.lume;
    saveWallet(w);
    return r
}

/* ---- username + tag (saved under PROF_KEY) ---- */
const PROF_KEY = 'aetheris.profile.v1'
  , PROF_DEF = USER_DEFAULT.name;
let profMem = {};
function loadProf() {
    try {
        const p = JSON.parse(localStorage.getItem(PROF_KEY) || '{}');
        return p && typeof p == 'object' ? p : {}
    } catch (e) {
        return profMem
    }
}
function saveProf(p) {
    profMem = p;
    try {
        localStorage.setItem(PROF_KEY, JSON.stringify(p))
    } catch (e) {}
}
function cleanName(v) {
    return String(v || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16)
}
function profName() {
    return cleanName(loadProf().name) || PROF_DEF
}
function profTag() {
    const p = loadProf();
    if (!/^\d{5}$/.test(p.tag || '')) {
        p.tag = String(10000 + Math.floor(Math.random() * 90000));
        saveProf(p)
    }
    return '#' + p.tag
}

/* ---- match history: newest first, last MATCH_MAX matches ---- */
const MATCH_KEY = 'aetheris.matches.v1'
  , MATCH_MAX = 20;
let matchMem = [];
function loadMatches() {
    try {
        const a = JSON.parse(localStorage.getItem(MATCH_KEY) || '[]');
        return Array.isArray(a) ? a : []
    } catch (e) {
        return matchMem
    }
}
/* adds one finished match to the history */
function addMatch(m) {
    matchMem = [m, ...loadMatches()].slice(0, MATCH_MAX);
    try {
        localStorage.setItem(MATCH_KEY, JSON.stringify(matchMem))
    } catch (e) {}
}

/* ---- settings: the three volume sliders in Settings (0 to 1) ---- */
const SET_KEY = 'aetheris.settings.v1'
  , SET_DEFAULT = {
    main: .8,     /* master volume */
    music: .4,    /* ambient music */
    sfx: .7       /* sound effects */
};
let setMem = {};
function loadSettings() {
    let p = {};
    try {
        p = JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {}
    } catch (e) {
        p = setMem
    }
    const o = {};
    for (const k in SET_DEFAULT) {
        const v = +p[k];
        o[k] = p[k] != null && isFinite(v) ? Math.min(1, Math.max(0, v)) : SET_DEFAULT[k]
    }
    return o
}
function saveSettings(s) {
    setMem = s;
    try {
        localStorage.setItem(SET_KEY, JSON.stringify(s))
    } catch (e) {}
}
