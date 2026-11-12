/* =====================================================================
   engine.js   -   AETHERIS GAME ENGINE  (rules, effects, triggers, AI, card text, match log text)
   =====================================================================
   WHAT LIVES HERE (change this file for anything about how the GAME plays):
     - card database processing: CARD_DB -> cards (toCard / POOL), the CARD_DB checker, Logistic (deck) lists, the printed rules text of every card
     - the rules: state G, drawing, playing, triggers (fire / emit), effects (fx), combat resolution (resolve), turn flow (start / endT / check)
     - the AI: Omnius and Axiom (ai, axMain, axAttack..., axDef..., deck choice aiCounter)
     - the match log text (MLOG, mlog, mlTxt) that the UI saves as database/logs/logN.txt
   WHAT DOES NOT LIVE HERE (that is index.html): everything visual - DOM, CSS, animation, sound, deck editor, collection, profile, sleeves, home screen.

   LOAD ORDER (index.html):  database/cards.js, database/decks.js, user.js, database/sounds.js, engine.js, then the page script.
   engine.js only DEFINES things when it loads (plus the card / deck checks). It never touches the page, except through the UI hooks below.

   UI HOOKS: functions and values that index.html must provide. The engine calls them while the game runs (the page script defines them, so they
   exist by the time any match starts; a check at the end of this file reports a missing one in the console).
     render()        redraw the board from G                         VQ              array: the engine PUSHES visual events, the UI plays them
     snd(name, p)    play a sound event                              sfxDiff(a, b)   sounds for the changes between two snapshots
     flash(...)      screen flash                                    combat(a, at, pr, done)   the attack / block ANIMATION; it calls resolve() for the damage
     resetAnim()     clear running animations (new match)            mlReset()       forget the unsaved match log (new match)
     matchStarted()  a match begins (music, log bar)                 recordMatch()   store the finished match in the profile + save its log
     cardCue(c, p, kind)   a card is played ('play'), activated ('act') or one of its abilities triggers ('trig'): the UI shows the #zoom preview for a moment
   ===================================================================== */
const IC = {
    bolt: '<svg class="ic" viewBox="0 0 16 16"><path d="M9 1L3 9h4l-1 6 7-9H9z" fill="#ffd37a"/></svg>',
    gem: '<svg class="ic" viewBox="0 0 16 16"><path d="M8 1l6 7-6 7-6-7z" fill="#8fefff"/></svg>'
};

const TG0 = {
    self: 'this Unit',
    trigger: 'that Unit',
    allies: 'your Units',
    enemies: 'all enemy Units',
    pick: 'target enemy Unit',
    mypick: 'target Unit you control',
    anypick: 'target Unit',
    relic: 'target enemy Relic',
    myrelic: 'target Relic you control',
    anyrelic: 'target Relic',
    relics: 'every enemy Relic',
    myrelics: 'every Relic you control',
    allrelics: 'every Relic',
    others: 'your other Units',
    opp: 'the opponent',
    me: 'you',
    ctrl: 'its controller',
    hand: 'cards in your hand'
};

['u', 't', 'r', ''].forEach(k => {
    const w = {u: 'Units', t: 'Tacticals', r: 'Relics', '': 'cards'}[k];
    TG0[k + 'hand'] = `${w} in your hand`;
    TG0['e' + k + 'hand'] = `${w} in the enemy hand`;
    TG0['a' + k + 'hand'] = `${w} in both hands`
}
);

/* ---- FILTERS by faction / sub type ----
   condition  {tr:'extract', if: {sub:'elder'}, fx:[...]}      -> you control ANOTHER card (Unit or Relic) whose sub type contains 'elder'
              {tr:'play', if: {faction:'veyrani', n:2}, ...}   -> you control at least n OTHER Veyrani cards (n optional, default 1)
              {sub:'wormrider', faction:'veyrani'} combines both
   triggers   'anyplay' = whenever YOU play another card (Unit, Relic or Tactical), 'oanyplay' = whenever the OPPONENT plays any card; both accept  of: {faction/sub}
              several at once: tr: ['anyplay', 'oanyplay']  (= whenever any player plays a card)
   target     'sub:elder' | 'faction:veyrani'  -> your Units matching, usable in any effect: ['buff', 1, 'sub:elder']   */
/* ---- COUNTERS: named markers on a Unit. The plain name is the only identifier ('Dust', 'Frost', ...), compared without caps ---- */
const cn = s => String(s || '').trim().toLowerCase();

const ctrN = (u, name) => u && u.ctr && u.ctr[cn(name)] || 0;

const ctrName = k => String(k).replace(/\b\w/g, x => x.toUpperCase());

const aN = n => (/^[aeiou]/i.test(cn(n)) ? 'an ' : 'a ') + ctrName(cn(n));

const ownerIdx = u => G.p[0].front.includes(u) ? 0 : G.p[1].front.includes(u) ? 1 : -1;

/* the owner of a Unit (front row) OR a Relic (vault) */
const ownerAny = u => ownerIdx(u) >= 0 ? ownerIdx(u) : G.p[0].vault.includes(u) ? 0 : G.p[1].vault.includes(u) ? 1 : -1;

const cardMatch = (c, f) => {
    const d = c.fa ? [c.fa, (c.tok ? 'Token ' + TN[c.t] + ' ' : '') + (c.sb || '')] : FD[c.n] || [];
    return (!f.has || ctrN(c, f.has) > 0) && (!f.ehas || ctrN(c, f.ehas) > 0) && (!f.faction || d[0] == f.faction) && (!f.sub || (d[1] || '').toLowerCase().includes(String(f.sub).toLowerCase()))
}
;

const filterNoun = f => (f.faction ? FACTIONS[f.faction].name + ' ' : '') + (f.sub ? cap(String(f.sub)) : 'card');

const tgSpec = t => {
    const m = /^(sub|faction|has|ehas):(.+)$/.exec(t || '');
    return m ? {
        [m[1]]: m[2]
    } : null
}
;

const TG1 = new Proxy(TG0,{
    get: (o, k) => k in o ? o[k] : typeof k == 'string' && /^e?has:/.test(k) ? `${k[0] == 'e' ? 'enemy' : 'your'} Units with ${aN(k.replace(/^e?has:/, ''))} counter` : (typeof k == 'string' && tgSpec(k)) ? `your ${filterNoun(tgSpec(k)).replace(/ card$/, '')} Units` : undefined
});

/* a merged target 'ehand|enemies' (made by mergeTg for the card text) is printed as "cards in the enemy hand and all enemy Units" */
const TG = new Proxy(TG1,{
    get: (o, k) => typeof k == 'string' && k.includes('|') ? k.split('|').map(x => o[x]).join(' and ') : o[k]
});

const ifOk = (cond, p, s) => {
    if (!cond)
        return true;
    if (cond == 'ally')
        return G.p[p].front.includes(s) && G.p[p].front.length > 1;
    /* several conditions: if: [{var:'debt', min:10}, {var:'life', max:10}] -> ALL of them must be true */
    if (Array.isArray(cond))
        return cond.every(c => ifOk(c, p, s));
    /* {var: 'debt', min: 20}: a live number (any variable of the VARIABLES list) must be at least min and / or at most max */
    if (cond.var) {
        const n = numOf(p, s, cond.var);
        return typeof n == 'number' && (cond.min == null || n >= cond.min) && (cond.max == null || n <= cond.max)
    }
    if (cond.ctr)
        return ctrN(s, cond.ctr) >= (cond.n || 1);
    return [...G.p[p].front, ...G.p[p].vault].filter(c => c !== s && cardMatch(c, cond)).length >= (cond.n || 1)
}
;

const OF_TR = ['ally', 'enter', 'oenter', 'prepare', 'oprepare', 'standby', 'ostandby', 'rest', 'orest', 'return', 'oreturn', 'cast', 'ocast', 'discard', 'odiscard', 'aecho', 'oaecho', 'aact', 'oaact', 'anyplay', 'oanyplay', 'ablock', 'oablock', 'aattack', 'oattack', 'adefend', 'odefend'];

/* you + the opponent in ONE sentence (ability with tr: ['cast', 'ocast'] ...); a trigger not listed is printed as "A or B" */
const TWIN = {
    cast: 'Whenever a Tactical is played',
    anyplay: 'Whenever a card is played',
    discard: 'Whenever a card is discarded',
    aecho: 'Whenever a card is played using Echo',
    aact: "Whenever a card's ability is activated",
    draw: 'Whenever either player draws',
    enter: 'When another Unit enters',
    counter: 'When a counter is put on a Unit or Relic',
    prepare: 'When a Unit is set to Prepare',
    standby: 'When a Unit is set to Standby',
    rest: 'When a Unit is set to Rest',
    return: 'When a Unit is returned to a hand',
    ablock: 'Whenever a Unit blocks and survives',
    defend: 'When a Unit is declared as a blocker'
};

const trT0 = a => {
    if (a.trs) {
        /* several triggers, one sentence: "Whenever you mill a card of your Logistic or discard a card".
           Shorter when the triggers belong together: up + down ("When your Lume changes"), you + the opponent ("When either player's Lume increases", TWIN below) */
        const one = t => trT0({...a, tr: t, trs: null})
          , has = t => a.trs.includes(t)
          , items = [];
        const done = new Set();
        a.trs.forEach(t => {
            if (done.has(t))
                return;
            done.add(t);
            const m = /^(o?)(lume|life|debt)(up|down)$/.exec(t);
            /* up + down of the same resource and side: "changes" */
            if (m && has(m[1] + m[2] + (m[3] == 'up' ? 'down' : 'up'))) {
                done.add(m[1] + m[2] + (m[3] == 'up' ? 'down' : 'up'));
                items.push({k: m[1] + m[2] + 'chg', text: one(m[1] + m[2] + 'up').replace(/ (increases)$/, ' changes')});
            } else
                items.push({k: t, text: one(t)})
        });
        const out = [];
        items.forEach(it => {
            if (it.dead)
                return;
            const tw = it.k.replace(/^o/, '') == it.k ? 'o' + it.k : it.k.replace(/^o/, '')
              , o = items.find(x => x !== it && x.k == tw && !x.dead)
              , me = it.k.startsWith('o') ? o : it
              , opp = it.k.startsWith('o') ? it : o;
            if (o && me && opp) {
                const T = me.text.includes('your ') && opp.text.replace("the opponent's", 'your') == me.text ? me.text.replace('your ', "either player's ") : (!a.of && TWIN[me.k] || null);
                if (T) {
                    o.dead = 1;
                    out.push(T);
                    return
                }
            }
            out.push(it.text)
        });
        return out.map( (t, i) => i ? t.replace(/^When(ever)? /, '') : t).join(' or ')
    }
    if (a.ctr)
        return TR[a.tr].replace('a counter', aN(a.ctr) + ' counter');
    if (!a.of)
        return TR[a.tr];
    const nn = filterNoun(a.of).replace(/ card$/, '');
    if (a.tr == 'aecho' || a.tr == 'aact' || a.tr == 'anyplay')
        return TR[a.tr].replace('another card', `another ${nn} card`);
    if (a.tr == 'oaecho' || a.tr == 'oaact' || a.tr == 'oanyplay')
        return TR[a.tr].replace('a card', `a ${nn} card`);
    return TR[a.tr].replace('your Unit', a.tr == 'ally' ? `another ${nn} Unit` : `your ${nn} Unit`).replace('another of your Units', `another of your ${nn} Units`).replace('an enemy Unit', `an enemy ${nn} Unit`)
}
;

/* a whole number written as a word: 3 -> "three", 12 -> "twelve", 21 -> "twenty-one" (100 or more stays a digit string) */
const NUM_W = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
  , TENS_W = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
  , numW = n => n < 20 ? NUM_W[n] : n < 100 ? TENS_W[Math.floor(n / 10)] + (n % 10 ? '-' + NUM_W[n % 10] : '') : String(n);

/* THE per-turn limit is max: n (a whole number, 1 or more) on a triggered ability or an 'act' ability. There is no once: true any more (it was max: 1).
   The limit as printed on a card:   max: 1 -> "Once per turn"   max: 2 -> "Twice per turn"   max: 3 or more -> "Up to three times per turn" */
const perTurnT = a => {
    const n = Math.floor(a.max);
    return n >= 3 ? `Up to ${numW(n)} times per turn` : n == 2 ? 'Twice per turn' : 'Once per turn'
}
;

/* max: n on a triggered ability: "Whenever you draw" -> "Once per turn if you draw" (other openings: "Once per turn, at Extraction") */
/* what 'delta' means depends on the trigger of the ability whose text is being built (set by trT / fire) */
let TXT_TR = [];
const deltaT = () => {
    const all = L => TXT_TR.length && TXT_TR.every(t => L.includes(t));
    return all(['relog', 'orelog']) ? 'the number of cards returned to the Logistic' : all(['mill', 'omill']) ? 'the number of cards milled' : TXT_TR.length && !TXT_TR.some(t => /^o?(lume|life|debt)(up|down)$|^o?a?echo$|^oaecho$|^(mill|omill|relog|orelog)$/.test(t)) ? 'the number of times it triggered (1)' : 'the amount it changed by'
};

const trT = a => {
    TXT_TR = a.trs || [a.tr];
    const t = trT0(a);
    if (a.tr == 'act' || !(a.max > 0))
        return t;
    const pre = perTurnT(a);
    return /^When(ever)? /.test(t) ? t.replace(/^When(ever)? /, pre + ' if ') : pre + ', ' + t.charAt(0).toLowerCase() + t.slice(1)
}
;

/* {var: 'debt', min: 20} -> "if your Echo Debt is 20 or more, "   max only -> "is 5 or less"   both -> "is between 5 and 20" */
const ifVarT = c => {
    const v = parseVar(c.var)
      , d = v ? vDesc(v) : String(c.var)
      , lo = c.min != null
      , hi = c.max != null;
    return `if ${d} is ${lo && hi ? `between ${c.min} and ${c.max}` : lo ? `${c.min} or more` : `${c.max} or less`}, `
}
;

const ifT = c => !c ? '' : Array.isArray(c) ? c.map((x, i) => ifT(x).replace(/, $/, '').replace(i ? /^if / : /^$/, '')).join(' and ') + ', ' : c == 'ally' ? 'if you control another Unit, ' : c.var ? ifVarT(c) : c.ctr ? `if this Unit has ${(c.n || 1) > 1 ? c.n + ' or more ' + ctrName(cn(c.ctr)) + ' counters' : aN(c.ctr) + ' counter'}, ` : `if you control ${(c.n || 1) > 1 ? c.n + ' other' : 'another'} ${filterNoun(c)}${(c.n || 1) > 1 ? 's' : ''}, `;

const TR = {
    play: 'When enters',
    act: 'Activate',
    death: 'When destroyed',
    attack: 'When attacking',
    extract: 'At Extraction',
    end: 'At End Turn',
    cast: 'Whenever you play a Tactical',
    ocast: 'When the opponent plays a Tactical',
    anyplay: 'Whenever you play another card',
    oanyplay: 'Whenever the opponent plays a card',
    discard: 'Whenever you discard a card',
    odiscard: 'When the opponent discards a card',
    ally: 'Whenever your Unit is destroyed',
    echo: 'Whenever played using Echo',
    aecho: 'Whenever you play another card using Echo',
    oaecho: 'Whenever the opponent plays a card using Echo',
    aact: "Whenever you activate another card's ability",
    oaact: "Whenever the opponent activates a card's ability",
    draw: 'Whenever you draw',
    odraw: 'When the opponent draws',
    relog: 'When cards return to your Logistic',
    orelog: "When cards return to the opponent's Logistic",
    mill: 'When cards of your Logistic are milled',
    omill: "When cards of the opponent's Logistic are milled",
    enter: 'When another of your Units enters',
    oenter: 'When an enemy Unit enters',
    counter: 'When a counter is put on your Unit or Relic',
    ocounter: 'When a counter is put on an enemy Unit or Relic',
    lumeup: 'When your Lume increases',
    lumedown: 'When your Lume decreases',
    olumeup: "When the opponent's Lume increases",
    olumedown: "When the opponent's Lume decreases",
    lifeup: 'When your Life increases',
    lifedown: 'When your Life decreases',
    olifeup: "When the opponent's Life increases",
    olifedown: "When the opponent's Life decreases",
    debtup: 'When your Echo Debt increases',
    debtdown: 'When your Echo Debt decreases',
    odebtup: "When the opponent's Echo Debt increases",
    odebtdown: "When the opponent's Echo Debt decreases",
    prepare: 'When your Unit is set to Prepare',
    oprepare: 'When an enemy Unit is set to Prepare',
    standby: 'When your Unit is set to Standby',
    ostandby: 'When an enemy Unit is set to Standby',
    rest: 'When your Unit is set to Rest',
    orest: 'When an enemy Unit is set to Rest',
    return: 'When your Unit is returned to your hand',
    oreturn: "When an enemy Unit is returned to its owner's hand",
    block: 'When this Unit blocks and survives',
    ablock: 'Whenever another of your Units blocks and survives',
    aattack: 'Whenever another of your Units attacks',
    oattack: 'Whenever an enemy Unit attacks',
    oablock: 'Whenever an enemy Unit blocks and survives',
    defend: 'When this Unit is declared as a blocker',
    adefend: 'Whenever another of your Units is declared as a blocker',
    odefend: 'Whenever an enemy Unit is declared as a blocker'
};

/* ---- KEYWORDS: keyword: [['echo', 2], ['stomp'], ['swift']]   [name] or [name, n]; x:1 = the keyword needs a number n ---- */
const KWS = {
    echo: {
        n: 'Echo',
        x: 1,
        t: n => `Echo ${n}: costs ${n} less Lume, and you take ${n} Echo Debt` + (ECHO_PAYS_LIFE ? ' (at your next Payday every Echo Debt costs you 1 Life; your Lume does not pay it).' : '.')
    },
    drawdown: {
        n: 'Drawdown',
        x: 1,
        t: n => `Drawdown ${n}: this card costs ${n} less Lume to play.`
    },
    swift: {
        n: 'Swift',
        t: 'Swift: enters ready to attack.'
    },
    lifesteal: {
        n: 'Lifesteal',
        t: 'Lifesteal: combat damage heals you.'
    },
    tireless: {
        n: 'Tireless',
        t: 'Tireless: attacking does not make this Unit Rest.'
    },
    toxic: {
        n: 'Toxic',
        t: 'Toxic: a Unit paired with it, attacking or blocking, is always destroyed, whatever its ATK.'
    },
    stomp: {
        n: 'Stomp',
        t: 'Stomp: when blocked, its ATK also hits the opponent.'
    },
    evasion: {
        n: 'Evasion',
        t: 'Evasion: ignores the combat damage of the Unit it is paired with, attacking or blocking.'
    }
};

/* any accepted input -> clean list of [name] / [name, n] */
const kwList = v => {
    const out = [];
    (Array.isArray(v) ? v : v ? [v] : []).forEach(e => {
        const k = String(Array.isArray(e) ? e[0] : e)
          , n = Array.isArray(e) ? e[1] : undefined;
        if (KWS[k] && !out.some(o => o[0] == k))
            out.push(KWS[k].x ? [k, Math.max(1, Math.floor(+n || 1))] : [k])
    }
    );
    return out
}
;

/* a card's full keyword list (the old  echo: n  field still counts as keyword Echo n) */
const kwOf = d => {
    const l = kwList(d.keyword);
    if (d.echo && !l.some(x => x[0] == 'echo'))
        l.unshift(['echo', +d.echo]);
    return l
}
;

const kwNum = (l, k) => (l.find(x => x[0] == k) || [])[1];

/* validator: checks one keyword list from card data, pre = message prefix */
const kwCheck = (v, w, pre) => (Array.isArray(v) ? v : [v]).forEach(e => {
    const k = String(Array.isArray(e) ? e[0] : e)
      , n = Array.isArray(e) ? e[1] : undefined;
    if (!KWS[k])
        w(`${pre}unknown keyword "${k}" (use: ${Object.keys(KWS).join(', ')})`);
    else if (KWS[k].x && !(+n >= 1))
        w(`${pre}keyword "${k}" needs a number: ['${k}', 2]`);
    else if (!KWS[k].x && n !== undefined)
        w(`${pre}keyword "${k}" takes no number`)
}
);

/* DISABLED keywords (effect 'disable'): kd = for good, kdt = until end of turn, kdx = [keyword, owner] until the owner's next Extraction. 'all' = every keyword.
   A disabled keyword is off for the whole engine (hk is how the engine asks), and a later grant does not bring it back. */
const kOff = (c, k) => !!(c && ((c.kd && (c.kd.includes(k) || c.kd.includes('all'))) || (c.kdt && (c.kdt.includes(k) || c.kdt.includes('all'))) || (c.kdx && c.kdx.some(x => x[0] == k || x[0] == 'all'))));

const hk = (c, k) => !!(c && ((c.ks && c.ks.includes(k)) || (c.kg && c.kg.includes(k)) || (c.kt && c.kt.includes(k)) || (c.kx && c.kx.some(x => x[0] == k))) && !kOff(c, k));

/* summon payload -> a full token spec. Every field is optional:
   ['summon', [atk, hp]]                         (old form)
   ['summon', {atk, hp, faction, sub, keyword, abilities, name}]
   ['summon']  or  ['summon', {}]                -> factionless 1/1 Token, no sub type, keyword or rule text */
const tokSpec = n => {
    const o = Array.isArray(n) ? {
        atk: n[0],
        hp: n[1]
    } : n && typeof n == 'object' ? n : {}
      , num = (v, d) => v == null || v === '' || !Number.isFinite(+v) ? d : +v;
    return {
        atk: Math.max(0, num(o.atk, 1)),
        hp: Math.max(1, num(o.hp, 1)),
        faction: o.faction && FACTIONS[o.faction] ? o.faction : '',
        sub: o.sub ? String(o.sub) : '',
        keyword: kwList(o.keyword),
        abilities: Array.isArray(o.abilities) ? o.abilities.filter(a => a && a.tr && Array.isArray(a.fx)) : [],
        name: o.name ? String(o.name) : 'Token'
    }
}
;

/* printed text of an activated ability: "Discard 1 card, draw 1."   with max: n the limit opens the sentence: "Once per turn discard 1 card, draw 1." / "Twice per turn ..." / "Up to three times per turn ..." */
/* a text that already ends with a full stop (even if closing tags or spaces follow it, like the "Choose one" lines) gets no second one */
const dot = t => /\.(\s|<\/[a-z]+>)*$/i.test(t) ? t : t + '.';

const actT = a => {
    let b;
    if (hasX(a)) {
        /* cost and effects share one X:  "Pay X Lume, deal X damage to an enemy Unit, where X is the amount you choose to pay." */
        const C = costOf(a)
          , V = vSub(C.concat(normFx(a.fx || [])));
        b = V.text(fxJ0(V.list.slice(0, C.length), ' and ') + ', ' + fxJ0(V.list.slice(C.length)))
    } else
        b = costT(a) ? costT(a) + ', ' + fxJ(a.fx) : fxJ(a.fx);
    return a.max > 0 ? dot(`${perTurnT(a)} ${b.charAt(0).toLowerCase() + b.slice(1)}`) : dot(cap(b))
}
;

const tokRule = a => a.tr == 'passive' ? staticJ(a.fx).join(' ') : a.tr == 'act' ? actT(a) : dot(`${trT(a)}, ${ifT(a.if) + fxJ(a.fx)}`);

/* +2 / -1 ; "gets" for a single Unit, "get" for a group */
/* buff / hp / surge amounts are SIGNED: ['buff', 1, t] = +1 ATK, ['buff', -1, t] = -1 ATK, ['hp', -2, t] = -2 HP (a Unit at 0 HP is destroyed) */
/* a placeholder letter ('X' = the number of counters removed) is printed as it is: Math.abs('X') was NaN, so the text read "+NaN ATK" */
const sg = n => typeof n == 'string' ? (n[0] == '-' ? n : '+' + n) : (n < 0 ? '-' : '+') + Math.abs(n);

const vb = t => ['self', 'pick', 'mypick', 'anypick'].includes(t) ? 'gets' : 'get';

/* join a list of effects into one sentence; a buff and an hp on the SAME target are printed together:  "+1 ATK and +1 HP" */
/* several effects in one list are joined by a word, not a comma:
   the effects of an ability are joined with " then "  (draw 1 then gain 2 Lume)
   the effects of a COST are joined with " and "       (mill 1 card and discard 1 card) */
/* TEXT ONLY: neighbouring effects that differ only by their target are printed as one:
   [['disable', 'ehand', 'all', 'next'], ['disable', 'enemies', 'all', 'next']]  ->  "disable all keywords on cards in the enemy hand and all enemy Units until your next turn" */
const MERGE_TG = ['grant', 'disable', 'buff', 'hp', 'surge', 'rest', 'state', 'counter', 'uncounter', 'dmg'];

const mergeTg = list => {
    const out = [];
    list.forEach(f => {
        const l = out[out.length - 1];
        if (l && f[0] == l[0] && MERGE_TG.includes(f[0]) && typeof f[2] == 'string' && typeof l[2] == 'string' && !['me', 'opp'].includes(f[2]) && !['me', 'opp'].includes(l[2]) && f[2] != l[2] && !l[2].split('|').includes(f[2]) && !(l[2] == 'allies' && f[2] == 'others') && !(l[2] == 'others' && f[2] == 'allies') && JSON.stringify([f[1], f[3], f[4]]) == JSON.stringify([l[1], l[3], l[4]]))
            out[out.length - 1] = [l[0], l[1], l[2] + '|' + f[2], ...l.slice(3)];
        else
            out.push(f)
    });
    return out
};

const fxJ0 = (list, sep=' then ') => {
    list = mergeTg(list);
    const out = []
      , used = new Set();
    list.forEach( (f, i) => {
        if (used.has(i))
            return;
        if (f[0] == 'buff' || f[0] == 'hp') {
            const j = list.findIndex( (g, k) => k > i && !used.has(k) && (g[0] == 'buff' || g[0] == 'hp') && g[0] != f[0] && g[2] == f[2]);
            if (j >= 0) {
                used.add(j);
                const a = f[0] == 'buff' ? f : list[j]
                  , b = f[0] == 'hp' ? f : list[j];
                out.push(`${TG[f[2]]} ${vb(f[2])} ${sg(remT(a[1]))} ATK and ${sg(remT(b[1]))} HP`);
                return
            }
        }
        out.push(fxT(f))
    }
    );
    return out.join(sep) + (list.some(f => isRem(f[1])) ? ', where X is the number of counters removed' + ((list.map(f => remOf(f[1])).find(m => m && m.cap) || {}).cap ? ` (at most ${list.map(f => remOf(f[1])).find(m => m && m.cap).cap})` : '') : '')
}
;

const fxJ = (list, sep) => {
    const V = vSub(list);
    return V.text(fxJ0(V.list, sep))
}
;

/* VARIABLES - a number in an effect (2nd item) can be the NAME of something that is counted live when the effect runs, also in passive effects:
     ['draw', 'hand'] ['lume', '2*relics'] ['buff', '-hand', 'enemies'] ['heal', 'waste/2', 'me']
   name  = what to count (list below) | '-name' = negative | 'k*name' = times k | 'name/k' = divided by k, rounded down  (counter:Name takes a counter name) */
const VARS = {
    /* x = an amount the PLAYER (or the computer) chooses when it activates the ability. Only for activated abilities (tr: 'act'):
       cost: [['lume', '-x']], fx: [['dmg', 'x', 'enemies']]  =  "Pay X Lume, deal X damage ...".   'x:5' = X can be 5 at most.
       While nobody has chosen yet (greyed-out check, card text) X counts as 1 = the smallest legal choice. */
    x: {
        v: () => G.xv == null ? 1 : G.xv,
        t: a => 'the amount you choose' + (a ? ` (up to ${a})` : '')
    },
    hand: {
        v: P => P.hand.length,
        t: () => 'the number of cards in your hand'
    },
    ehand: {
        v: (P, O) => O.hand.length,
        t: () => "the number of cards in the opponent's hand"
    },
    deck: {
        v: P => P.deck.length,
        t: () => 'the number of cards in your Logistic'
    },
    edeck: {
        v: (P, O) => O.deck.length,
        t: () => "the number of cards in the opponent's Logistic"
    },
    waste: {
        v: P => P.waste.length,
        t: () => 'the number of cards in your Wasteland'
    },
    ewaste: {
        v: (P, O) => O.waste.length,
        t: () => "the number of cards in the opponent's Wasteland"
    },
    life: {
        v: P => P.life,
        t: () => 'your Life'
    },
    elife: {
        v: (P, O) => O.life,
        t: () => "the opponent's Life"
    },
    lume: {
        v: P => P.lume,
        t: () => 'your Lume'
    },
    elume: {
        v: (P, O) => O.lume,
        t: () => "the opponent's Lume"
    },
    debt: {
        v: P => P.debt,
        t: () => 'your Echo Debt'
    },
    delta: {
        v: () => G.evAmt == null ? 1 : G.evAmt,
        t: () => deltaT()
    },
    edebt: {
        v: (P, O) => O.debt,
        t: () => "the opponent's Echo Debt"
    },
    units: {
        v: P => P.front.length,
        t: () => 'the number of Units you control'
    },
    others: {
        v: (P, O, x) => Math.max(0, P.front.length - (P.front.includes(x) ? 1 : 0)),
        t: () => 'the number of other Units you control'
    },
    enemies: {
        v: (P, O) => O.front.length,
        t: () => 'the number of enemy Units'
    },
    relics: {
        v: P => P.vault.length,
        t: () => 'the number of Relics you control'
    },
    erelics: {
        v: (P, O) => O.vault.length,
        t: () => "the number of the opponent's Relics"
    },
    turn: {
        v: () => G.turn,
        t: () => 'the turn number'
    },
    counter: {
        v: (P, O, x, a) => x ? ctrN(x, a) : 0,
        t: a => 'the number of ' + ctrName(cn(a)) + ' counters on this card'
    },
    counters: {
        v: (P, O, x, a) => P.front.reduce( (q, y) => q + ctrN(y, a), 0),
        t: a => 'the number of ' + ctrName(cn(a)) + ' counters on your Units'
    },
    ecounters: {
        v: (P, O, x, a) => O.front.reduce( (q, y) => q + ctrN(y, a), 0),
        t: a => 'the number of ' + ctrName(cn(a)) + ' counters on enemy Units'
    }
};

const VAR_RE = /^(-)?(?:(\d+)\*)?([a-z]+)(?::(.+?))?(?:\/(\d+))?$/;

const parseVar = x => {
    const m = typeof x == 'string' && x.match(VAR_RE);
    return m && VARS[m[3]] ? {
        neg: !!m[1],
        mul: m[2] ? +m[2] : 1,
        key: m[3],
        arg: m[4] || '',
        div: m[5] ? +m[5] : 1
    } : null
}
;

/* the real number of an effect amount: a plain number stays, 'removed' / a variable is worked out now (p = who owns the effect, s = the card it belongs to) */
/* 'removed' = the number of counters the uncounter of this same ability just removed. '-removed' = minus that number (buff / hp / surge only).
   'removed:3' / '-removed:3' = the same, but at most 3 (the cap goes after the colon). remOf(x) = {neg, cap} or null if x is not one of these. */
const remOf = x => {
    const m = typeof x == 'string' ? /^(-?)removed(?::(\d+))?$/.exec(x) : null;
    return m ? {
        neg: !!m[1],
        cap: m[2] ? +m[2] : 0
    } : null
}
  , isRem = x => !!remOf(x)
  , remAmt = (x, r) => {
    const m = remOf(x)
      , v = m.cap ? Math.min(r, m.cap) : r;
    return m.neg ? -v : v
}
  , remT = x => remOf(x) ? remOf(x).neg ? '-X' : 'X' : x;
const numOf = (p, s, x) => {
    if (isRem(x))
        return remAmt(x, s && s.rm || 0);
    const v = parseVar(x);
    if (!v)
        return x;
    const val = Math.floor(VARS[v.key].v(G.p[p], G.p[1 - p], s, v.arg) * v.mul / v.div);
    return v.neg ? -val : val
}
;

/* rule text for a variable: *2 = "double", *3 = "triple", /2 = "half of ... , rounded down" (other numbers: "k times" / "divided by k") */
const vDesc = v => {
    const b = VARS[v.key].t(v.arg)
      , M = {
        2: 'double',
        3: 'triple'
    }
      , D = {
        2: 'half of',
        3: 'a third of',
        4: 'a quarter of'
    };
    if (v.mul > 1 && v.div > 1)
        return `${b} times ${v.mul}, divided by ${v.div}, rounded down`;
    if (v.mul > 1)
        return M[v.mul] ? `${M[v.mul]} ${b}` : `${v.mul} times ${b}`;
    if (v.div > 1)
        return (D[v.div] ? `${D[v.div]} ${b}` : `${b} divided by ${v.div}`) + ', rounded down';
    return b
}
;

/* TEXT: swap every variable for a placeholder number so the normal text builders can print it; then letters (X, Y, Z) and ", where X is ..." are added */
const vSub = list => {
    const keys = []
      , hasRem = list.some(f => isRem(f[1]))
      , L = hasRem ? ['Y', 'Z', 'W'] : ['X', 'Y', 'Z']
      , swapped = list.map(f => {
        const v = parseVar(f[1]);
        if (!v)
            return f;
        const b = `${v.mul}*${v.key}:${v.arg}/${v.div}`;
        let i = keys.findIndex(k => k.b == b);
        if (i < 0)
            i = keys.push({
                b,
                v
            }) - 1;
        return [f[0], (v.neg ? -1 : 1) * (99999 - i), ...f.slice(2)]
    }
    )
      , letter = m => L[99999 - m] || 'X';
    return {
        list: swapped,
        text: s => !keys.length ? s : s.replace(/9999[789]/g, letter) + (hasRem ? ' and ' : ', where ') + keys.map( (k, i) => `${L[i]} is ${vDesc(k.v)}`).join(' and '),
        sentence: s => {
            const used = [...new Set(s.match(/9999[789]/g) || [])];
            return !used.length ? s : s.replace(/9999[789]/g, letter).replace(/\.$/, `, where ${used.map(m => `${L[99999 - m]} is ${vDesc(keys[99999 - m].v)}`).join(' and ')}.`)
        }
    }
}
;

const PER = {
    others: 'other Unit you control',
    units: 'Unit you control',
    enemies: 'enemy Unit',
    relics: 'Relic you control',
    waste: 'card in your Wasteland'
};

const perT = per => PER[per] || (/^counter:/.test(per) ? ctrName(cn(per.slice(8))) + ' counter on it' : /^counters:/.test(per) ? ctrName(cn(per.slice(9))) + ' counter on your Units' : /^ecounters:/.test(per) ? ctrName(cn(per.slice(10))) + ' counter on enemy Units' : '');

const staticT = f => {
    const [ty,n,tg,per] = f;
    if (ty == 'hold')
        return `${cap(TG[tg] || 'this Unit')}${/ with /.test(TG[tg] || '') ? '' : ' with ' + aN(per) + ' counter'} do${tg == 'self' ? 'es' : ''} not wake at Extraction.`;
    return ty == 'buff' || ty == 'hp' ? `${cap(TG[tg] || 'this Unit')} ${tg == 'self' ? 'gets' : 'get'} ${n < 0 ? '-' : '+'}${Math.abs(n)} ${ty == 'hp' ? 'HP' : 'ATK'}${per && perT(per) ? ' for each ' + perT(per) : ''}.` : cap(fxT(f)) + '.'
}
;

const staticJ0 = list => {
    const out = []
      , used = new Set();
    list.forEach( (f, i) => {
        if (used.has(i))
            return;
        if (f[0] == 'buff' || f[0] == 'hp') {
            const j = list.findIndex( (g, k) => k > i && !used.has(k) && (g[0] == 'buff' || g[0] == 'hp') && g[0] != f[0] && g[2] == f[2] && (g[3] || '') == (f[3] || ''));
            if (j >= 0) {
                used.add(j);
                const a = f[0] == 'buff' ? f : list[j]
                  , b = f[0] == 'hp' ? f : list[j]
                  , per = f[3] && perT(f[3]) ? ' for each ' + perT(f[3]) : '';
                out.push(`${cap(TG[f[2]] || 'this Unit')} ${vb(f[2])} ${sg(a[1])} ATK and ${sg(b[1])} HP${per}.`);
                return
            }
        }
        out.push(staticT(f))
    }
    );
    return out
}
;

const staticJ = list => {
    const V = vSub(list);
    return staticJ0(V.list).map(V.sentence)
}
;

/* search spec (3rd item of ['search', n, spec]): an exact card NAME, or filters joined with '+':
   'type:unit' | 'type:relic' | 'type:tactical', 'sub:scout', 'faction:vulkar'  e.g. 'faction:vulkar+type:unit' */
const SEARCH_TYPES = {
    unit: ['U', 'Unit'],
    relic: ['R', 'Relic'],
    tactical: ['T', 'Tactical']
};

const searchSpec = tg => {
    const parts = String(tg || '').split('+').map(x => x.trim());
    if (!parts.every(x => /^(type|sub|faction):\S/i.test(x)))
        return null;
    const o = {
        err: null
    };
    parts.forEach(x => {
        const m = /^(type|sub|faction):(.+)$/i.exec(x)
          , k = m[1].toLowerCase()
          , v = m[2].trim();
        if (k == 'type') {
            if (SEARCH_TYPES[v.toLowerCase()])
                o.type = SEARCH_TYPES[v.toLowerCase()];
            else
                o.err = `unknown type "${v}" (type:unit, type:relic or type:tactical)`
        } else if (k == 'sub')
            o.sub = v;
        else if (FACTIONS[v.toLowerCase()])
            o.faction = v.toLowerCase();
        else
            o.err = `unknown faction "${v}" (${Object.keys(FACTIONS).join(', ')})`
    }
    );
    return o
}
;

const searchNoun = sp => [sp.faction ? FACTIONS[sp.faction].name : '', sp.sub ? cap(String(sp.sub)) : '', sp.type ? sp.type[1] : 'card'].filter(Boolean).join(' ');

/* destroying your OWN Unit / Relic is a sacrifice: target -> what is sacrificed */
const SAC = {
    self: 'this Unit',
    mypick: 'a Unit you control',
    allies: 'all your Units',
    others: 'all your other Units',
    myrelic: 'a Relic you control',
    myrelics: 'every Relic you control'
}
  , sacOwn = t => t in SAC || (!!tgSpec(t) && !/^ehas:/.test(t));

const FT = {
    /* what YOU give up is PAID (Life here, Lume in 'lume'), and what you destroy of your own is SACRIFICED (see SAC above) */
    dmg: (n, t) => t == 'me' ? `pay ${n} Life` : `deal ${n} damage to ${TG[t]}`,
    heal: (n, t) => t == 'me' ? `gain ${n} Life` : `restore ${n} to ${TG[t]}`,
    draw: n => `draw ${n}`,
    lume: n => n < 0 ? `pay ${-n} Lume` : `gain ${n} Lume`,
    buff: (n, t) => `${TG[t]} ${vb(t)} ${sg(n)} ATK`,
    hp: (n, t) => `${TG[t]} ${vb(t)} ${sg(n)} HP`,
    grant: (n, t, kw, mode) => `give ${TG[t]} ${KWS[String(kw)] ? KWS[String(kw)].n + (KWS[String(kw)].x && (n > 0 || n === 'X') ? ' ' + n : '') : kw}${mode == 'turn' ? ' until end of turn' : mode == 'next' ? ' until your next turn' : ''}`,
    disable: (n, t, kw, mode) => `disable ${String(kw) == 'all' ? 'all keywords' : KWS[String(kw)] ? KWS[String(kw)].n : kw} on ${TG[t]}${mode == 'turn' ? ' until end of turn' : mode == 'next' ? ' until your next turn' : ''}`,
    counter: (n, t, nm) => `put ${n} ${ctrName(cn(nm))} counter${n > 1 ? 's' : ''} on ${TG[t]}`,
    hold: (n, t, nm) => `keep ${TG[t]} with ${aN(nm)} counter from waking at Extraction`,
    uncounter: (n, t, nm) => `remove ${n == 'all' ? 'all' : n} ${ctrName(cn(nm))} counter${n == 'all' || n > 1 ? 's' : ''} from ${TG[t]}`,
    surge: (n, t) => `${TG[t]} ${vb(t)} ${sg(n)} ATK this turn`,
    rest: (n, t) => `set ${TG[t]} to Rest`,
    state: (n, t) => `set ${TG[t]} to ${n == 'standby' ? 'Standby' : n == 'prepare' ? 'Prepare' : 'Rest'}`,
    prune: (n, t) => `prune ${TG[t]}`,
    /* raze: destroy Relic(s). With a relic pick target and n > 1 the player chooses up to n Relics */
    raze: (n, t) => t == 'self' ? 'sacrifice this Relic' : t == 'myrelic' && n > 1 ? `sacrifice up to ${n} Relics you control` : sacOwn(t) ? `sacrifice ${SAC[t] || TG[t]}` : ['relic', 'myrelic', 'anyrelic'].includes(t) && n > 1 ? `destroy up to ${n} ${{
        relic: 'target enemy Relics',
        myrelic: 'Relics you control',
        anyrelic: 'target Relics'
    }[t]}` : `destroy ${TG[t]}`,
    steal: n => `steal ${n} Lume from the opponent`,
    /* return: move Unit(s) from the board back to their owner's hand. With a pick target and n > 1 the player chooses up to n Units */
    'return': (n, t) => {
        const own = ['mypick', 'self', 'allies', 'others'].includes(t) || (tgSpec(t) && !/^ehas:/.test(t))
          , many = ['allies', 'enemies', 'others'].includes(t) || !!tgSpec(t)
          , pl = {
            pick: 'enemy Units',
            mypick: 'Units you control',
            anypick: 'Units'
        }
          , to = own ? (many ? 'your hand' : 'your hand') : (many || (['pick', 'mypick', 'anypick'].includes(t) && n > 1) ? "their owners' hands" : "its owner's hand");
        return ['pick', 'mypick', 'anypick'].includes(t) && n > 1 ? `return up to ${n} ${t == 'mypick' ? '' : 'target '}${pl[t]} to ${to}` : `return ${TG[t] || 'this Unit'} to ${to}`
    }
    ,
    recur: n => n == 1 ? 'return the strongest Unit from your Wasteland to your hand' : `return ${n} Units from your Wasteland to your hand`,
    /* destroy: destroy Unit(s) of any side (Wasteland + "When destroyed"). With a pick target and n > 1 the player chooses up to n Units */
    destroy: (n, t) => t == 'mypick' && n > 1 ? `sacrifice up to ${n} Units you control` : sacOwn(t) ? `sacrifice ${SAC[t] || TG[t]}` : ['pick', 'mypick', 'anypick'].includes(t) && n > 1 ? `destroy up to ${n} ${{
        pick: 'target enemy Units',
        mypick: 'Units you control',
        anypick: 'target Units'
    }[t]}` : `destroy ${TG[t]}`,
    peek: () => `look at the opponent's hand`,
    summon: n => {
        const s = tokSpec(n)
          , kw = s.keyword.map( ([k,n]) => KWS[k].n + (n ? ' ' + n : '')).join(' and ')
          , ru = s.abilities.map(tokRule).join(' ');
        return `recruit a ${s.atk}/${s.hp} ${s.faction ? FACTIONS[s.faction].name + ' ' : ''}${s.sub ? s.sub + ' ' : ''}${s.name}${kw || ru ? ' with ' : ''}${kw}${kw && ru ? ' and ' : ''}${ru ? '\u201C' + ru + '\u201D' : ''}`
    }
    ,
    drain: n => `drain ${n} from the opponent`,
    pay: (n, t) => t == 'opp' ? `the opponent pays off ${n} Echo Debt` : t == 'ctrl' ? `its controller pays off ${n} Echo Debt` : `pay off ${n} Echo Debt`,
    retrieve: (n, t) => t == 'shuffle' ? `send ${n} card${n > 1 ? 's' : ''} from your Wasteland to your Logistic and shuffle it` : `return ${n} card${n > 1 ? 's' : ''} from your Wasteland to ${t == 'logistic' ? 'the top of your Logistic' : 'your hand'}`,
    mill: (n, t) => `send the top ${n} card${n > 1 ? 's' : ''} of ${t == 'opp' ? "the opponent's" : 'your'} Logistic to the Wasteland`,
    /* look: ['look', x, take, where]  look at the top x cards of YOUR Logistic, put `take` of them into your hand, return the rest */
    look: (n, k, w) => {
        const t = Math.max(1, Math.floor(+k) || 1);
        return `look at the top ${n} card${n > 1 ? 's' : ''} of your Logistic, put ${t == 1 ? 'one' : t} into your hand and return the rest ${w == 'top' ? 'to the top of' : w == 'shuffle' ? 'and shuffle them into' : 'to the bottom of'} your Logistic`
    }
    ,
    /* search: ['search', n, 'Card Name', where]  search YOUR Logistic for n copies of the card with that exact name, shuffle the Logistic, then put them into your hand (default) or on top of it ('top') */
    search: (n, t, w) => {
        const k = Math.max(1, Math.floor(+n) || 1)
          , sp = searchSpec(t)
          , nm = String(t || 'a card')
          , nn = sp ? searchNoun(sp) : ''
          , what = sp ? (k > 1 ? `up to ${k} ${nn}s` : `${/^[aeiou]/i.test(nn) ? 'an' : 'a'} ${nn}`) : (k > 1 ? `up to ${k} copies of ${nm}` : `a copy of ${nm}`);
        return w == 'top' ? `search your Logistic for ${what}, shuffle your Logistic and put ${k > 1 ? 'them' : 'it'} on top of it` : `search your Logistic for ${what}, put ${k > 1 ? 'them' : 'it'} into your hand and shuffle your Logistic`
    }
    ,
    debt: (n, t) => t == 'opp' ? `transfer up to ${n} Echo Debt to the opponent` : t == 'me' ? `take ${n} Echo Debt` : `take up to ${n} Echo Debt from the opponent`,
    adddebt: (n, t) => t == 'opp' ? `give the opponent ${n} Echo Debt` : t == 'ctrl' ? `give its controller ${n} Echo Debt` : `take ${n} Echo Debt`,
    discard: n => `discard ${n} card${n > 1 ? 's' : ''}`,
    shuffle: (n, t) => t == 'opp' ? `shuffle the opponent's Logistic` : 'shuffle your Logistic',
    /* choose: ['choose', [[effects], [effects], ...]]  (written fx: [A, 'or', B]) */
    choose: (alts, tail, pre) => (Array.isArray(pre) && pre.length ? cap(fxJ(pre)) + ', then <b>choose one :</b>' : '<b>Choose one :</b>') + (alts || []).map(a => '<span class="chl"><i>- </i><span>' + cap(fxJ(a)) + '.</span></span> ').join('') + (Array.isArray(tail) && tail.length ? '<span class="chl cht"><i></i><span>If you do, ' + fxJ(tail) + '.</span></span> ' : '')
};

/* COST of an activated ability  {tr: 'act', cost: [effect, ...], fx: [effect, ...]}
   the cost is a list of ORDINARY effects (same format and same engine as fx): they run first, then the fx run.
   Its text is the text of those effects, printed before the colon. */
const costOf = a => normFx(a.cost || []);

const isRestC = c => c[0] == 'rest' || (c[0] == 'state' && c[1] == 'rest');

const isXv = n => {
    const v = parseVar(n);
    return !!v && v.key == 'x'
}
;

const xUses = list => (list || []).some(f => Array.isArray(f) && (isXv(f[1]) || (f[0] == 'choose' && ((f[1] || []).some(alt => xUses(normFx(alt))) || xUses(f[2] || []) || xUses(f[3] || [])))));

const hasX = a => xUses(costOf(a));

const costT = a => {
    const L = costOf(a);
    if (!xUses(L))
        return fxJ(L, ' and ');
    /* X is chosen by the player: print it as X, and explain X here only when the effects do not */
    const V = vSub(L)
      , t = fxJ0(V.list, ' and ');
    return xUses(normFx(a.fx || [])) ? V.sentence(t) : V.text(t)
}
;

const acts = s => (s.ab || []).filter(a => a.tr == 'act');

const fxT = f => {
    const v = parseVar(f[1]);
    return v ? FT[f[0]](v.neg ? -99999 : 99999, f[2], f[3], f[4]).replace(/99999/g, 'X') : remOf(f[1]) && remOf(f[1]).neg ? FT[f[0]](-99999, f[2], f[3], f[4]).replace(/99999/g, 'X') : FT[f[0]](isRem(f[1]) ? 'X' : f[1], f[2], f[3], f[4])
}
;

const cap = s => s.replace(/^./, x => x.toUpperCase());

const selfN = (c, t) => c && c.t == 'R' ? String(t).replace(/\bthis Unit\b/g, 'this Relic') : t;

const desc = c => {
    const ab = [];
    /* every rule of a card is an ability:  flash = the one-time effects of a Tactical, passive = always on, act = activated, anything else = a trigger */
    (c.ab || []).forEach(a => {
        if (a.tr == 'flash')
            ab.push(dot(cap(fxJ(a.fx))));
        else if (a.tr == 'passive')
            staticJ(a.fx).forEach(t => ab.push(t));
        else
            ab.push(a.tr == 'act' ? actT(a) : dot(`${trT(a)}, ${ifT(a.if) + fxJ(a.fx)}`))
    }
    );
    /* keyword explanations are NOT printed in the card: they appear in the side box next to the zoom preview (kwBox) */
    return ab.map(t => `<span class="ab">${selfN(c, t)}</span>`).join('')
}
;

/* CARD_DB + FACTIONS now live in database/cards.js, deck lists in database/decks.js */
/* ---- everything below is DERIVED from CARD_DB (do not edit) ---- */
/* folder of the database files, taken from the <script src> tag (default 'database/') */
const DB_DIR = ((document.querySelector('script[src$="cards.js"]') || {
    getAttribute: () => ''
}).getAttribute('src') || 'database/cards.js').replace(/[^\/]*$/, '');

/* card "art" paths are relative to the database folder, unless they are a URL / data: URI / absolute path */
const dbPath = p => !p ? p : /^([a-z][a-z0-9+.-]*:|\/)/i.test(p) ? p : DB_DIR + p;

const KC = Object.fromEntries(Object.entries(FACTIONS).map( ([k,v]) => [k, v.letter]));

const clone = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));

/* effects: a list of effects, or ONE effect written flat:  ['buff', 2, 'self']  ==  [['buff', 2, 'self']] */
/* OR: fx: [['pay', 1], 'or', ['lume', 2]]  = the player CHOOSES one side. 'or' splits the list into alternatives; several effects may stand on one side.
   The list becomes ONE effect ['choose', [[alt1 effects], [alt2 effects], ...]] (see chooseFx) */
/* ['choose', alts, tail?, pre?]: builds the choose effect without empty trailing items */
const chooseOf = (alts, tail, pre) => pre ? ['choose', alts, tail || [], pre] : tail ? ['choose', alts, tail] : ['choose', alts];

/* 'then' ends the choice: fx: [['pay', 2], 'or', ['lume', 2], 'then', ['draw', 1]]  =  choose (pay 2 OR gain 2 Lume), THEN draw 1 whichever was chosen.
   Everything after 'then' runs once, after the chosen side is done (it is stored as the 3rd item of the choose effect and does not decide which sides are possible). */
/* the word 'choose' STARTS the choice: the effects before it are done FIRST, as a cost, then the player chooses:
   fx: [['dmg', 1, 'me'], 'choose', ['raze', 1, 'relic'], 'or', ['destroy', 1, 'pick']]  =  pay 1 Life, then choose (raze a Relic OR destroy a Unit).
   The first part is stored as the 4th item of the choose effect. It is only paid if at least one side can be done. */
const orFx = list => {
    if (!Array.isArray(list) || !(list.includes('or') || list.includes('then') || list.includes('choose')))
        return list;
    const ci = list.indexOf('choose')
      , pre = ci < 0 ? [] : list.slice(0, ci).filter(f => f !== 'choose')
      , body = ci < 0 ? list : list.slice(ci + 1).filter(f => f !== 'choose')
      , ti = body.indexOf('then')
      , head = ti < 0 ? body : body.slice(0, ti)
      , tail = ti < 0 ? [] : body.slice(ti + 1).filter(f => f !== 'then');
    if (!head.includes('or'))
        return pre.concat(head, tail);
    const alts = [[]];
    head.forEach(f => f === 'or' ? alts.push([]) : alts[alts.length - 1].push(f));
    return [pre.length ? ['choose', alts, normFx(tail), normFx(pre)] : tail.length ? ['choose', alts, normFx(tail)] : ['choose', alts]]
}
;

/* GRANT: the number slot belongs to keywords that HAVE a number. A keyword without a number is written without it:
     ['grant', 'allies', 'swift']                  ['grant', 'allies', 'swift', 'turn']      (short form, no placeholder)
   and the long form  ['grant', n, 'allies', 'keyword'(, 'turn' | 'next')]  keeps working: n is the keyword's number (1 or more) and is IGNORED
   (write 0) for a keyword without one. The short form is turned into the long form here, so every other part of the engine sees one shape. */
/* ['grant', 'removed', 'ehand', 'echo']: a string in the 2nd slot is an AMOUNT when it is 'removed' or a variable (and not the name of a target) */
const grantAmt = x => typeof x == 'string' && !(x in TG0) && !handTg(x) && !tgSpec(x) && (isRem(x) && !(remOf(x).neg) || !!parseVar(x));

const grantFx = f => !Array.isArray(f) ? f : (f[0] == 'grant' || f[0] == 'disable') && typeof f[1] == 'string' && !(f[0] == 'grant' && grantAmt(f[1])) ? [f[0], 0, ...f.slice(1)] : f[0] == 'choose' && Array.isArray(f[1]) ? chooseOf(f[1].map(al => Array.isArray(al) ? al.map(grantFx) : al), Array.isArray(f[2]) ? f[2].map(grantFx) : null, Array.isArray(f[3]) ? f[3].map(grantFx) : null) : f;

/* 'delta' after an uncounter effect in the same list = the counters that uncounter just removed (the older 'removed', which still works):
   'delta' / '-delta' / 'delta:3' become 'removed' / '-removed' / 'removed:3'. Before any uncounter, 'delta' stays the number of the trigger (see VARS) */
const deltaFx = list => {
    let seen = false;
    const fix = f => !Array.isArray(f) ? f : f[0] == 'choose' ? [f[0], (f[1] || []).map(a => deltaFx(a)), ...f.slice(2).map(x => Array.isArray(x) ? deltaFx(x) : x)] : seen && typeof f[1] == 'string' && /^-?delta(:\d+)?$/.test(f[1]) ? [f[0], f[1].replace('delta', 'removed'), ...f.slice(2)] : f;
    return list.map(f => {
        const g = fix(f);
        if (Array.isArray(g) && g[0] == 'uncounter')
            seen = true;
        return g
    })
};

const normFx = e => deltaFx((Array.isArray(e) && typeof e[0] == 'string' && e[0] !== 'or' ? [e] : orFx(e))).map(grantFx);

/* database record -> the card shape the game engine uses */
/* abilities -> the two effect lists the engine reads (card.ab keeps ALL the abilities):
   tr 'flash'   = the one-time effects of a Tactical      -> card.fx
   tr 'passive' = the always-on effects of a Unit / Relic -> card.fx */
const abFx = (ab, tr) => (ab || []).filter(a => a.tr == tr).flatMap(a => a.fx || []);

const toCard = d => {
    const ab = clone(d.abilities || []).map(a => (a.fx = normFx(a.fx || []),
    /* tr: ['mill', 'discard'] = ONE ability that triggers on any of them (a.tr keeps the first, a.trs all of them) */
    Array.isArray(a.tr) && (a.trs = a.tr.filter(t => typeof t == 'string'),
    a.tr = a.trs[0],
    a.trs.length < 2 && delete a.trs),
    a))
      , fx = abFx(ab, d.type == 'T' ? 'flash' : 'passive');
    return {
        n: d.name,
        t: d.type,
        /* ECHO: the Lume cost of a card with Echo n is  printed cost - n  (never below 1, a printed cost of 0 stays 0). c = what you pay, c0 = the printed cost.
       The Echo value is taken as Echo Debt every time the card is played (see play). */
        c: payCost(d.cost, kwNum(kwOf(d), 'echo'), kwNum(kwOf(d), 'drawdown')),
        ...(kwNum(kwOf(d), 'echo') || kwNum(kwOf(d), 'drawdown') ? {
            c0: d.cost
        } : {}),
        /* DRAWDOWN x (Units only): x less Lume to play, and no Echo Debt (c = what you pay, c0 = the printed cost) */
        ...(kwNum(kwOf(d), 'drawdown') ? {
            dd: kwNum(kwOf(d), 'drawdown')
        } : {}),
        ...(d.type == 'U' ? {
            a: d.atk,
            h: d.hp
        } : {}),
        ...(kwOf(d).length ? {
            k: kwOf(d)[0][0],
            kw: kwOf(d),
            ks: kwOf(d).map(x => x[0])
        } : {}),
        ...(kwNum(kwOf(d), 'echo') ? {
            e: kwNum(kwOf(d), 'echo')
        } : {}),
        ...(ab.length ? {
            ab
        } : {}),
        ...(fx.length ? {
            fx
        } : {}),
        ...(d.token ? {
            tok: 1
        } : {})
    }
}
;

const UN = CARD_DB.filter(d => !d.token && d.type == 'U').map(toCard)
  , OT = CARD_DB.filter(d => !d.token && d.type != 'U').map(toCard)
  , POOL = [...UN, ...OT]
  , TOKENS = CARD_DB.filter(d => d.token).map(toCard);

const FD = {}
  , CARD_IDS = {}
  , ART_PATH = {}
  , CARD_BY_ID = {};

CARD_DB.forEach(d => {
    FD[d.name] = [d.faction, d.sub, d.flavor];
    CARD_IDS[d.name] = d.id;
    ART_PATH[d.name] = dbPath(d.art);
    CARD_BY_ID[d.id] = d
}
);

/* sanity check: tells you in the console (F12) when a card record is wrong */
(function validateCardDb() {
    const bad = []
      , ids = {}
      , names = {};
    CARD_DB.forEach(d => {
        const w = m => bad.push(`${d.name || '(no name)'}: ${m}`);
        if (!d.id || !/^[A-Z]-\d{5}$/.test(d.id))
            w(`id "${d.id}" must look like V-12345`);
        else if (FACTIONS[d.faction] && d.id[0] != FACTIONS[d.faction].letter)
            w(`id ${d.id} must start with ${FACTIONS[d.faction].letter} for ${d.faction}`);
        (ids[d.id] = ids[d.id] || []).push(d.name);
        (names[d.name] = names[d.name] || []).push(d.id);
        if (!FACTIONS[d.faction])
            w(`unknown faction "${d.faction}"`);
        if (!['U', 'T', 'R'].includes(d.type))
            w(`unknown type "${d.type}"`);
        if (typeof d.cost != 'number')
            w('cost is missing');
        if (d.type == 'U' && (typeof d.atk != 'number' || typeof d.hp != 'number'))
            w('a Unit needs atk and hp');
        if (d.type == 'T' && !(d.abilities || []).some(a => a.tr == 'flash' && normFx(a.fx || []).length))
            w("a Tactical needs an ability {tr: 'flash', fx: [...]}");
        if (d.keyword)
            kwCheck(d.keyword, w, '');
        if (d.type == 'U' && !d.sub)
            w('a Unit needs a sub type');
        if (d.type != 'U' && d.sub)
            w('Relics and Tacticals have no sub type: remove sub');
        if (!d.flavor)
            w('flavor text is missing');
        if (!d.art)
            w('art path is missing');
        const chk = f => {
            if (f[0] == 'choose') {
                if (!Array.isArray(f[1]) || f[1].length < 2 || !f[1].every(a => Array.isArray(a) && a.length))
                    w("'or' needs effects on BOTH sides: fx: [['pay', 1], 'or', ['lume', 2]]");
                else
                    f[1].forEach(a => a.forEach(chk));
                if (Array.isArray(f[2]))
                    f[2].forEach(chk);
                if (Array.isArray(f[3]))
                    f[3].forEach(chk);
                return
            }
            if (typeof f[1] == 'string' && ['dmg', 'heal', 'draw', 'lume', 'buff', 'hp', 'counter', 'mill', 'discard', 'pay', 'debt', 'adddebt'].includes(f[0]) && !isRem(f[1]) && !parseVar(f[1]))
                w(`"${f[1]}" is not a number or a variable (${Object.keys(VARS).join(', ')}; counter:Name, counters:Name, ecounters:Name)`);
            if (remOf(f[1]) && remOf(f[1]).neg && !['buff', 'hp', 'surge'].includes(f[0]))
                w("'-removed' only works for buff, hp and surge (use 'removed' for the other effects)");
            if (!FT[f[0]])
                w(`unknown effect "${f[0]}"`);
            /* retrieve's 3rd item is not a target: 'shuffle' = shuffled into your Logistic, 'logistic' = on top of your Logistic, nothing = to your hand */
            if (f[0] == 'retrieve' && f[2] != null && f[2] != 'logistic' && f[2] != 'shuffle')
                w(`retrieve only accepts 'logistic' (top of the Logistic) or 'shuffle' (shuffled into the Logistic) as the 3rd item, or nothing for your hand, not "${f[2]}"`);
            else if (f[2] && f[0] != 'look' && f[0] != 'retrieve' && f[0] != 'search' && !TG[f[2]])
                w(`unknown target "${f[2]}"`);
            if (f[0] == 'pay' && f[2] && f[2] != 'me' && f[2] != 'opp' && f[2] != 'ctrl')
                w("pay's target (3rd item) is optional: ['pay', 2] or ['pay', 2, 'me'] (you pay off Echo Debt), ['pay', 2, 'opp'] (the opponent pays off Echo Debt) or ['pay', 2, 'ctrl'] (the controller of the Unit that set off the trigger pays it off)");
            if (f[0] == 'adddebt' && f[2] != 'me' && f[2] != 'opp' && f[2] != 'ctrl')
                w("adddebt needs its target as the 3rd item: ['adddebt', 3, 'me'] (you take new Echo Debt), ['adddebt', 3, 'opp'] (the opponent takes it) or ['adddebt', 3, 'ctrl'] (the controller of the Unit that set off the trigger takes it)");
            if (f[0] == 'search') {
                if (!(f[1] >= 1))
                    w("search needs the number of copies as the 2nd item (1 or more): ['search', 1, 'Card Name']");
                else if (typeof f[2] != 'string' || !f[2].trim())
                    w("search needs the exact card name or a filter as the 3rd item: ['search', 1, 'Card Name'] | ['search', 1, 'type:unit'] | ['search', 1, 'faction:vulkar+type:unit']");
                else if (searchSpec(f[2]) && searchSpec(f[2]).err)
                    w(`search: ${searchSpec(f[2]).err}`);
                else if (!searchSpec(f[2]) && !CARD_DB.some(x => String(x.name).toLowerCase() == f[2].trim().toLowerCase()))
                    w(`search: no card is named \"${f[2]}\"`);
                if (f[3] != null && !['hand', 'top'].includes(f[3]))
                    w("search: the optional 4th item can only be 'hand' (default) or 'top' (on top of the Logistic)")
            }
            if (f[0] == 'look' && (!(f[1] >= 1) || (f[2] != null && !(f[2] >= 1)) || (f[3] != null && !['top', 'bottom', 'shuffle'].includes(f[3]))))
                w("look needs ['look', how many to look at, how many to take (default 1), 'bottom' | 'top' | 'shuffle' (default bottom)], e.g. ['look', 4, 1]");
            if ((f[0] == 'buff' || f[0] == 'hp' || f[0] == 'surge') && !isRem(f[1]) && !parseVar(f[1]) && (typeof f[1] != 'number' || !isFinite(f[1])))
                w(`${f[0]} needs a number as the 2nd item: ['${f[0]}', 1, 'allies'] = +1, ['${f[0]}', -1, 'enemies'] = -1`);
            if (f[0] == 'return' && !(f[1] >= 1))
                w("return needs the number of Units as the 2nd item (1 or more): ['return', 1, 'mypick']");
            if (f[0] == 'destroy' && (!f[2] || f[2] == 'opp' || f[2] == 'me'))
                w("destroy needs a Unit target as the 3rd item: ['destroy', 1, 'pick'] | ['destroy', 1, 'mypick'] | ['destroy', 0, 'enemies'] ...");
            if (f[0] == 'destroy' && ['pick', 'mypick', 'anypick'].includes(f[2]) && !(f[1] >= 1))
                w("destroy needs the number of Units as the 2nd item (1 or more): ['destroy', 1, 'mypick']");
            if (f[0] == 'raze' && !['self', 'relic', 'myrelic', 'anyrelic', 'relics', 'myrelics', 'allrelics'].includes(f[2]))
                w("raze needs a Relic target as the 3rd item: self (this Relic) | relic | myrelic | anyrelic (choose) or relics | myrelics | allrelics (all), e.g. ['raze', 1, 'relic']");
            if (f[0] == 'raze' && f[2] == 'self' && d.type != 'R')
                w("raze with the target 'self' destroys the Relic that owns the ability, so it only works on a Relic");
            if (f[0] == 'raze' && ['relic', 'myrelic', 'anyrelic'].includes(f[2]) && !(f[1] >= 1))
                w("raze needs the number of Relics as the 2nd item (1 or more): ['raze', 1, 'relic']");
            if (f[0] == 'state' && !['rest', 'standby', 'prepare'].includes(f[1]))
                w(`state effect needs 'rest', 'standby' or 'prepare', got "${f[1]}"`);
            if (f[0] == 'disable') {
                /* long form here: ['disable', 0, target, 'keyword' | 'all', 'turn' | 'next'] */
                const dk = String(f[3] || '');
                if (dk != 'all' && !KWS[dk])
                    w(`disable needs a keyword (${Object.keys(KWS).join(', ')}) or 'all': ['disable', 'enemies', 'evasion'] | ['disable', 'enemies', 'all', 'turn']`);
                if (!f[2])
                    w("disable needs a target: ['disable', 'enemies', 'evasion']");
                if (f[4] != null && !['turn', 'next'].includes(f[4]))
                    w("disable: the optional last item can only be 'turn' (until end of turn) or 'next' (until your next turn, at Extraction)");
                if (handTg(f[2]) && (dk == 'echo' || dk == 'drawdown' || dk == 'all') && f[4])
                    w("disable on a hand: Echo and Drawdown are switched off for good, so the 'turn' / 'next' item is ignored for them");
                if (!handTg(f[2]) && (dk == 'echo' || dk == 'drawdown'))
                    w("disable: Echo and Drawdown only mean something for a card in a HAND: use hand | ehand | ahand (uhand, thand, rhand ...)")
            }
            if (f[0] == 'grant') {
                /* f is the long form here: ['grant', n, target, 'keyword', 'turn' | 'next'] (the short form ['grant', target, 'keyword'] was turned into it by normFx) */
                const gk = String(f[3] || '');
                if (!KWS[gk] || (gk == 'echo' && !handTg(f[2])))
                    w(`grant needs a keyword (${Object.keys(KWS).filter(k => k != 'echo' && k != 'drawdown').join(', ')}), for example ['grant', 'allies', 'evasion'] or ['grant', 'allies', 'swift', 'turn']  (Echo and Drawdown only go to a hand: hand | ehand | ahand, or uhand / thand / rhand ...)`);
                else if (KWS[gk].x && !(f[1] >= 1 || (handTg(f[2]) && f[1] <= -1)) && !grantAmt(f[1]))
                    w(`${KWS[gk].n} is a keyword with a number: write it as the 2nd item, for example ['grant', 2, 'allies', '${gk}'] (a keyword without a number needs no number: ['grant', 'allies', 'swift'])`);
                else if (!grantAmt(f[1]) && (typeof f[1] != 'number' || !isFinite(f[1]) || (f[1] < 0 && !(KWS[gk].x && handTg(f[2])))))
                    w("grant: the 2nd item of the long form is the keyword's number (0 or more); a keyword without a number is written without it: ['grant', 'allies', 'swift']");
                if (!f[2])
                    w("grant needs a target: ['grant', 'allies', 'evasion']");
                if (gk == 'drawdown' && !handTg(f[2]))
                    w("drawdown can only be granted to the cards in a hand: ['grant', 1, 'hand', 'drawdown'] (your hand), 'ehand' (enemy), 'ahand' (both); uhand / thand / rhand = only Units / Tacticals / Relics");
                if (handTg(f[2]) && ['T', 'R'].includes(handTg(f[2]).ty) && gk != 'echo' && gk != 'drawdown')
                    w("grant: keywords other than Echo / Drawdown only work on Unit cards, so a Tactical / Relic hand target does nothing here: use uhand / euhand / auhand");
                if (handTg(f[2]) && (gk == 'echo' || gk == 'drawdown') && f[4])
                    w("grant to a hand: Echo and Drawdown are permanent, so the 'turn' / 'next' item is ignored");
                if (f[4] && f[4] != 'turn' && f[4] != 'next')
                    w("grant: the optional last item can only be 'turn' (until end of turn) or 'next' (until your next turn, at Extraction)")
            }
            if (f[0] == 'counter' || f[0] == 'uncounter') {
                if (!f[3] || !/^[A-Za-z0-9][A-Za-z0-9 '-]{0,19}$/.test(String(f[3]).trim()))
                    w(`${f[0]} needs a plain counter name as the 4th item, for example ['${f[0]}', 1, 'self', 'Dust']`);
                if (!f[2])
                    w(`${f[0]} needs a target as the 3rd item`);
                if (f[0] == 'counter' && !isRem(f[1]) && !(f[1] > 0) && !(parseVar(f[1]) && !parseVar(f[1]).neg))
                    w("counter needs an amount above 0: a number, or a variable like 'debt' / 'others'")
            }
            if (f[0] == 'summon' && f[1] && typeof f[1] == 'object' && !Array.isArray(f[1])) {
                const o = f[1];
                if (o.faction && !FACTIONS[o.faction])
                    w(`summon: unknown faction "${o.faction}"`);
                if (o.keyword)
                    kwCheck(o.keyword, w, 'summon: ');
                (o.abilities || []).forEach(a => {
                    if (!TR[a.tr] && a.tr != 'passive')
                        w(`summon: unknown trigger "${a.tr}"`);
                    if (a.tr == 'flash')
                        w('summon: a Token cannot have a flash ability');
                    (a.fx || []).forEach(chk);
                    costOf(a).forEach(chk)
                }
                )
            }
        }
        ;
        const chkPassive = f => {
            if (!['buff', 'hp', 'hold'].includes(f[0]))
                w(`a passive effect on a ${d.type == 'U' ? 'Unit' : 'Relic'} must be "buff", "hp" or "hold" (got "${f[0]}"). Use another trigger for anything else`);
            else if (!['self', 'allies', 'others', 'enemies'].includes(f[2]))
                w(`passive buff needs a target: self, allies, others or enemies (got "${f[2]}")`);
            else if (f[0] == 'hold' && !f[3])
                w('hold needs the counter name as the 4th item, for example [\'hold\', 0, \'enemies\', \'Frost\']');
            else if (f[0] != 'hold' && f[3] && !perT(f[3]))
                w(`passive "for each" must be one of: ${Object.keys(PER).join(', ')}, counter:Name, counters:Name, ecounters:Name (got "${f[3]}")`);
            else if (typeof f[1] != 'number' && !parseVar(f[1]))
                w('passive buff needs a number, for example [\'buff\', 2, \'self\']')
        }
        ;
        (d.abilities || []).forEach(a => {
            [].concat(a.tr).forEach(t => {
                if (!TR[t] && t != 'passive' && t != 'flash')
                    w(`unknown trigger "${t}"`)
            }
            );
            if (!(a.fx || []).length)
                w(`the ${a.tr} ability has no fx`);
            if (a.once != null)
                w('once is not used any more: write max: 1 instead of once: true (max: n = at most n times each turn)');
            if (a.tr == 'flash') {
                if (d.type != 'T')
                    w('flash is only for Tacticals');
                if (a.if || a.cost || a.of || a.ctr)
                    w("a flash ability is just {tr: 'flash', fx: [...]}: no if / cost / max / of / ctr")
            } else if (d.type == 'T')
                w(`a Tactical only has flash abilities (got "${a.tr}")`);
            if (a.max != null && (!(a.max >= 1) || a.max != Math.floor(a.max)))
                w('max must be a whole number of 1 or more (max times per turn)');
            if (a.max != null && (a.tr == 'passive' || a.tr == 'flash'))
                w('max is only for act abilities and triggered abilities');
            if (a.tr == 'passive') {
                if (d.type == 'T')
                    w('passive is only for Units and Relics');
                if (a.if || a.cost || a.of || a.ctr)
                    w('a passive ability is always on: no if / cost / max / of / ctr');
                normFx(a.fx || []).forEach(chkPassive)
            }
            [].concat(a.if || []).forEach(ci => {
                if (ci && typeof ci == 'object' && ('var' in ci || 'min' in ci || 'max' in ci)) {
                    if (!parseVar(ci.var))
                        w(`if {var: ...} needs a variable name from the VARIABLES list (got \"${ci.var}\")`);
                    if (typeof ci.min != 'number' && typeof ci.max != 'number')
                        w('if {var: ...} needs min and / or max (a number)')
                }
            });
            if (a.ctr && [].concat(a.tr).some(t => t != 'counter' && t != 'ocounter'))
                w('"ctr" only works with the counter / ocounter triggers');
            if (a.of && [].concat(a.tr).some(t => !OF_TR.includes(t)))
                w(`"of" needs a trigger that has a source card (${OF_TR.join(', ')}), got "${a.tr}"`);
            if (a.tr == 'act') {
                /* the cost is a list of ordinary effects, written exactly like fx */
                costOf(a).forEach(c => {
                    chk(c);
                    if (c[0] == 'lume' && !(c[1] < 0) && !(parseVar(c[1]) && parseVar(c[1]).neg))
                        w("a Lume cost is a negative amount: ['lume', -1] = pay 1 Lume, ['lume', '-x'] = the player chooses how much, ['lume', '-edebt'] = as much as a variable");
                    if (['rest', 'state', 'destroy', 'uncounter'].includes(c[0]) && !c[2])
                        w(`the cost \"${c[0]}\" needs a target as the 3rd item, for example ['rest', 0, 'self']`);
                    if (['pick', 'mypick', 'anypick', 'relic', 'myrelic', 'anyrelic'].includes(c[2]))
                        w('a cost cannot use a choosing (pick) target');
                    if (d.type == 'R' && c[2] == 'self' && ['rest', 'state', 'destroy', 'uncounter'].includes(c[0]))
                        w(`a Relic cannot pay the cost \"${c[0]}\" on itself (it is not a Unit)`)
                }
                );
                if (!costOf(a).length && !(a.max > 0))
                    w('an activated ability needs a cost or max: n')
            }
            if (a.tr == 'flash' && d.type == 'T' && xUses(normFx(a.fx || []))) {
                /* Tactical X: the player chooses X when casting. It needs a limit: x:N, or an uncounter effect that uses x */
                const fxl = normFx(a.fx || []).filter(Array.isArray);
                if (!fxl.some(f => isXv(f[1]) && +(parseVar(f[1]) || {}).arg > 0) && !fxl.some(f => f[0] == 'uncounter' && isXv(f[1])))
                    w("a Tactical with x needs a limit: write 'x:5' (X is 5 at most) or remove counters with x, for example ['uncounter', 'x', 'mypick', 'Order']")
            } else if (a.tr == 'act' ? (xUses(normFx(a.fx || [])) && !hasX(a)) : xUses(normFx(a.fx || []).concat(costOf(a))))
                w("the variable x is an amount the player chooses: use it only in an activated ability (tr: 'act') whose cost has it, for example cost: [['lume', '-x']]");
            normFx(a.fx || []).forEach(chk)
        }
        )
    }
    );
    Object.entries(ids).forEach( ([i,n]) => n.length > 1 && bad.push(`duplicate id ${i}: ${n.join(', ')}`));
    Object.entries(names).forEach( ([n,i]) => i.length > 1 && bad.push(`duplicate card name "${n}"`));
    if (bad.length)
        console.error('[Aetheris] CARD_DB problems:\n' + bad.join('\n'))
}
)();

let uid = 0, G, byId = {};

const _usedIds = new Set(Object.values(CARD_IDS));

const printId = (name, fa) => {
    if (CARD_IDS[name])
        return CARD_IDS[name];
    const L = KC[(FD[name] || [fa || 'veyrani'])[0]] || 'X';
    let n = 10000 + ([...name].reduce( (a, c) => a * 31 + c.charCodeAt(0), 7) % 360 * 137 + name.length * 911) % 89999, id;
    while (_usedIds.has(id = L + '-' + n))
        n = 10000 + (n - 9999) % 89999;
    _usedIds.add(id);
    CARD_IDS[name] = id;
    console.warn(`[Aetheris] "${name}" has no print ID yet. Temporary ID ${id}. Add the card to CARD_DB with  id: '${id}'  to make it permanent.`);
    return id
}
;

const mk = d => {
    const c = {
        ...d,
        id: ++uid,
        dmg: 0,
        st: 'P',
        ba: 0,
        bh: 0,
        ctr: {}
    };
    c.d = desc(c);
    const f = d.tok && d.fa ? [d.fa, d.sb || '', d.fv || ''] : FD[c.n] || ['veyrani', 'Wanderer', ''];
    c.fa = f[0];
    c.sb = f[1];
    c.fv = f[2];
    c.cd = d.tok && d.fa ? 'TOKEN' : printId(c.n, c.fa);
    byId[c.id] = c;
    return c
}
;

const sh = a => {
    for (let i = a.length; i > 1; ) {
        const j = Math.random() * i-- | 0;
        [a[i],a[j]] = [a[j], a[i]]
    }
    return a
}
;

const DECK_WARN = [];

const DECKS = {};

(function parseDecks() {
    Object.keys(DECK_LISTS).forEach(who => {
        const want = {}
          , order = [];
        DECK_LISTS[who].split('\n').forEach(raw => {
            const ln = raw.trim();
            if (!ln || ln.startsWith('//') || ln.startsWith('#'))
                return;
            const m = ln.match(/^(\d+)\s*x?\s+(.+)$/i);
            if (!m) {
                DECK_WARN.push(`${who}: cannot read the line "${ln}" (use: 2 Card Name)`);
                return
            }
            const card = POOL.find(c => c.n.toLowerCase() == m[2].trim().toLowerCase());
            if (!card) {
                DECK_WARN.push(`${who}: unknown card "${m[2].trim()}" was skipped`);
                return
            }
            if (!(card.n in want)) {
                want[card.n] = 0;
                order.push(card.n)
            }
            want[card.n] += +m[1]
        }
        );
        const names = [];
        order.forEach(n => {
            if (want[n] > DECK_MAX_COPIES)
                DECK_WARN.push(`${who}: ${want[n]} copies of ${n}, limited to ${DECK_MAX_COPIES}`);
            for (let i = 0; i < Math.min(want[n], DECK_MAX_COPIES); i++)
                names.push(n)
        }
        );
        if (names.length < DECK_MIN)
            DECK_WARN.push(`${who}: logistic has ${names.length} cards, the minimum is ${DECK_MIN}`);
        DECKS[who] = names
    }
    );
    if (DECK_WARN.length) {
        console.warn('Logistic list problems:\n' + DECK_WARN.join('\n'));
    }
}
)();

/* a fresh, shuffled copy of the listed deck; falls back to every card once if no list exists */
let PLAYER_DECK = null
  , AI_DECK_NAME = ''
  , AI_LEVEL = 'omnius';

/* SPECTATE = AI vs AI. The player only watches: seat 0 AND seat 1 are played by an AI (SPEC_LV = the AI of each seat, SPEC_DECK = its logistic).
   ME = the seat the AI code is working for right now, OP = its opponent. In a normal duel ME is always 1 (the computer) and OP is 0 (you). */
let SPEC = 0
  , SPEC_LV = ['axiom', 'axiom']
  , SPEC_DECK = ['', '']
  , SPEC_SPEED = 1
  , SPEC_PAUSE = 0
  , SPEC_HANDS = 1
  , SPEC_AUTO = 0
  , ME = 1
  , OP = 0;
/* does a computer play this seat? / which AI level plays it? */
const isAI = p => SPEC ? true : p == 1;
const lvOf = p => SPEC ? SPEC_LV[p] : AI_LEVEL;
/* run fn with the AI code working for seat s (restores the previous seat: an AI can be asked to defend while another AI is mid-turn) */
function aiSeat(s, fn) {
    const m = ME
      , o = OP;
    ME = s;
    OP = 1 - s;
    try {
        return fn()
    } finally {
        ME = m;
        OP = o
    }
}
/* the AI's pauses: in a normal duel plain timeouts; when watching, they follow the speed and the Pause button */
function aiLater(fn, ms) {
    if (!SPEC)
        return setTimeout(fn, ms);
    const go = () => {
        if (SPEC_PAUSE && G && !G.over)
            return setTimeout(go, 120);
        fn()
    }
    ;
    return setTimeout(go, ms / SPEC_SPEED)
}
const specName = seat => {
    const n = AI_LV[SPEC_LV[seat]].name;
    return SPEC_LV[0] == SPEC_LV[1] ? n + (seat ? ' B' : ' A') : n
}
;

const AI_LV = {
    omnius: {
        name: 'Omnius',
        tag: 'Standard',
        desc: 'Face the Logistic AI in a full duel. It picks the logistic that counters yours. Win by Life, Lume, or when your opponent cannot draw from an empty Logistic.'
    },
    axiom: {
        name: 'Axiom',
        tag: 'Hardest',
        desc: 'The hardest AI. It reads every card effect: trades Units by value, removes your biggest threat and your Lume engines, stops feeding them, plays around Lume, Life and Echo debt, and blocks to survive. It also picks the logistic that counters yours.'
    }
};

const buildDeck = names => sh((names ? names.map(n => POOL.find(c => c.n == n)).filter(Boolean) : POOL).map(mk));

/* every deck in database/decks.js that is legal (size and copy limits) */
const legalDecks = () => Object.keys(DECK_LISTS).filter(k => (DECKS[k] || []).length >= DECK_MIN);

/* how a deck plays: early pressure, early defence, late power, and how much interaction (removal / control) it has */
function deckProfile(names) {
    const cs = names.map(n => POOL.find(c => c.n == n)).filter(Boolean)
      , us = cs.filter(c => c.t == 'U');
    const sum = (l, f) => l.reduce( (a, c) => a + f(c), 0);
    const early = us.filter(c => c.c <= 4)
      , late = us.filter(c => c.c >= 5);
    const fxs = c => (c.t == 'T' ? c.fx || [] : []).map(f => f[0]);
    return {
        press: sum(early, c => c.a),
        wall: sum(early, c => c.h),
        big: sum(late, c => c.a + c.h),
        inter: cs.filter(c => fxs(c).some(t => ['dmg', 'prune', 'rest', 'steal'].includes(t))).length,
        cost: cs.length ? sum(cs, c => c.c) / cs.length : 0
    }
}

/* the AI picks the deck of database/decks.js that counters YOUR deck best, rock-paper-scissors style:
   control (tough blockers + removal) beats aggro, big ramp Units beat control, fast aggro beats ramp.
   Each deck is scored on all three styles; a small random factor stops the pick from always being the same. */
function deckStyle(names) {
    const q = deckProfile(names);
    const v = {
        agg: q.press + (6 - q.cost) * 6,
        ctl: q.wall * .6 + q.inter * 3,
        big: q.big * .8 + q.cost * 6
    };
    const t = v.agg + v.ctl + v.big || 1;
    return {
        agg: v.agg / t,
        ctl: v.ctl / t,
        big: v.big / t
    }
}

/* raw strength of a deck: Unit stats per Lume, Lume / card / Unit engines, removal and finishers.
   Used so the AI can copy the player's deck when that deck is simply the strongest one available */
function deckPower(names) {
    const cs = names.map(n => POOL.find(c => c.n == n)).filter(Boolean);
    let p = 0;
    cs.forEach(c => {
        if (c.t == 'U')
            p += Math.min(2.5, (c.a + c.h) / Math.max(1, c.c) / 1.6) + (c.kw || []).length * .25;
        const fx = [...(c.fx || []), ...(c.ab || []).filter(a => a.tr != 'passive').flatMap(a => a.fx || [])];
        fx.forEach(f => {
            const t = Array.isArray(f) ? f[0] : f;
            if (t == 'lume' && typeof f[1] == 'number' && f[1] > 0)
                /* Lume paid for with Life (Blood Siphon, Tithe) is a dead card unless the deck can spend it: it is not strength */
                p += fx.some(g => Array.isArray(g) && g[0] == 'dmg' && g[2] == 'me') ? .15 : Math.min(2, f[1] * .5);
            else if (t == 'draw')
                p += .5;
            else if (['dmg', 'prune', 'steal', 'return'].includes(t))
                p += .6;
            else if (t == 'summon')
                p += .4
        }
        )
    }
    );
    return p / Math.max(1, cs.length)
}

/* the AI picks the deck of database/decks.js that counters YOUR deck best (rock-paper-scissors on style) AND is strong on its own.
   It may pick an exact copy of your deck: the mirror is chosen when your deck is the strongest one in the list. */
/* MIRROR: the AI may play an exact copy of YOUR deck (it knows the list) when that rates better than every counter deck.
   AX_MIRROR_BONUS: raise it to copy you more often, 0 = only when your deck is simply stronger. AX_MIRROR_DEBT: extra pull towards copying Echo / Echo Debt decks. */
const AX_MIRROR_BONUS = .10
  , AX_MIRROR_DEBT = .35
  , AX_MIRROR_KEY = 'Mirror';

function debtShare(names) {
    const cs = names.map(n => POOL.find(c => c.n == n)).filter(Boolean);
    const isDebt = c => c.e > 0 || [...(c.fx || []), ...(c.ab || []).flatMap(a => a.fx || [])].some(f => Array.isArray(f) && (f[0] == 'debt' || f[0] == 'adddebt'));
    return cs.filter(isDebt).length / Math.max(1, cs.length)
}

/* a deck of many small Units / token makers (the player's) is shut down by effects that hit ALL enemy Units (-1 ATK to them, damage to them) */
const allFx = c => [...(c.fx || []), ...(c.ab || []).flatMap(a => a.fx || [])].filter(Array.isArray);

function swarmShare(names) {
    const cs = names.map(n => POOL.find(c => c.n == n)).filter(Boolean);
    return cs.filter(c => (c.t == 'U' && c.a <= 1) || allFx(c).some(f => f[0] == 'summon')).length / Math.max(1, cs.length)
}

function sweepShare(names) {
    const cs = names.map(n => POOL.find(c => c.n == n)).filter(Boolean);
    return cs.filter(c => allFx(c).some(f => f[2] == 'enemies' && ((f[0] == 'buff' && f[1] < 0) || (f[0] == 'dmg' && f[1] > 0)))).length / Math.max(1, cs.length)
}

/* clunky cards: Tacticals that cost their owner Life (Blood Siphon, Tithe, Burn Forward). They sit in the hand when there is nothing to spend the
   Lume on / no Unit to buff, so a deck full of them draws dead hands. Share of such cards in a deck. */
function deadShare(names) {
    const cs = names.map(n => POOL.find(c => c.n == n)).filter(Boolean);
    return cs.filter(c => c.t == 'T' && allFx(c).some(f => f[0] == 'dmg' && f[2] == 'me')).length / Math.max(1, cs.length)
}

function aiCounter(mine) {
    const P = deckStyle(mine)
      , keys = legalDecks()
      , pw = deckPower(mine);
    const pows = keys.map(k => deckPower(DECKS[k]))
      , pmax = Math.max(...pows, pw)
      , pmin = Math.min(...pows, pw)
      , span = Math.max(.01, pmax - pmin);
    const rnd = () => Math.random() * .03;
    let best = null;
    keys.forEach( (k, i) => {
        const C = deckStyle(DECKS[k]);
        const same = DECKS[k].length == mine.length && [...DECKS[k]].sort().join() == [...mine].sort().join();
        const sc = C.ctl * P.agg + C.big * P.ctl + C.agg * P.big + (pows[i] - pmin) / span * .22 + (same ? .12 : 0) + sweepShare(DECKS[k]) * swarmShare(mine) * 3 - deadShare(DECKS[k]) + rnd();
        if (!best || sc > best.sc)
            best = {
                k,
                sc,
                same
            }
    }
    );
    /* the copy of your own deck (style against itself + its raw power + the mirror bonus + Echo Debt synergy) */
    const msc = P.ctl * P.agg + P.big * P.ctl + P.agg * P.big + (pw - pmin) / span * .22 + AX_MIRROR_BONUS + debtShare(mine) * AX_MIRROR_DEBT - deadShare(mine) + rnd();
    if (!best || (!best.same && msc > best.sc)) {
        DECKS[AX_MIRROR_KEY] = [...mine];
        console.log(`[AI deck] mirror ${msc.toFixed(2)} beats ${best ? best.k + ' ' + best.sc.toFixed(2) : 'nothing'}`);
        return AX_MIRROR_KEY
    }
    if (best && best.same)
        console.log('[AI deck] mirror: your deck rates strongest');
    else
        console.log(`[AI deck] counter ${best.k} ${best.sc.toFixed(2)} vs mirror ${msc.toFixed(2)}`);
    return best ? best.k : null
}

const newP = (name, deckNames) => {
    const P = {
        name,
        life: 20,
        lume: 3,
        ctr: 0,
        debt: 0,
        deck: buildDeck(deckNames),
        hand: [],
        front: [],
        vault: [],
        waste: [],
        void: []
    };
    /* Life, Lume and Echo Debt report EVERY change as it happens (G.lq), not just the net change of a whole action.
       So "When your Lume increases" still fires when one card pays 3 Lume and gains 2.
       G.cur = the chain of cards whose abilities led to the change; none of them is triggered by it again. */
    ['life', 'lume', 'debt'].forEach(k => {
        let v = P[k];
        Object.defineProperty(P, k, {
            enumerable: true,
            configurable: true,
            get: () => v,
            set: nv => {
                const o = v;
                v = nv;
                if (nv !== o && G && G.p && G.started)
                    mlS(G.p.indexOf(P), k, nv - o);
                if (nv !== o && G && G.started && !G.over)
                    (G.lq = G.lq || []).push([k + (nv > o ? 'up' : 'down'), G.p.indexOf(P), undefined, G.cur, Math.abs(nv - o)])
            }
        })
    }
    );
    return P
}
;

/* PASSIVE effects: an ability {tr: 'passive', fx: [...]} on a Unit or Relic is always on while it is in play (no trigger). Supported: buff, hp, hold (use a negative number to reduce ATK) */
function statBonus(p, u, ty='buff') {
    /* how many things a passive counts: others = your other Units, units = all your Units, enemies = enemy Units, relics = your Relics, waste = cards in your Wasteland */
    const cnt = (per, o, x) => per == 'others' ? Math.max(0, G.p[o].front.length - (G.p[o].front.includes(x) ? 1 : 0)) : per == 'units' ? G.p[o].front.length : per == 'enemies' ? G.p[1 - o].front.length : per == 'relics' ? G.p[o].vault.length : per == 'waste' ? G.p[o].waste.length : /^counter:/.test(per) ? ctrN(x, per.slice(8)) : /^counters:/.test(per) ? G.p[o].front.reduce( (s, y) => s + ctrN(y, per.slice(9)), 0) : /^ecounters:/.test(per) ? G.p[1 - o].front.reduce( (s, y) => s + ctrN(y, per.slice(10)), 0) : 1
      , sum = (list, o, enemy) => list.reduce( (s, x) => s + (x.t == 'T' ? [] : x.fx || []).reduce( (q, f) => q + (f[0] == ty && (enemy ? f[2] == 'enemies' : f[2] == 'allies' || f[2] == 'self' && x === u || f[2] == 'others' && x !== u) ? (ty == 'hold' ? (ctrN(u, f[3]) > 0 ? 1 : 0) : (+numOf(o, x, f[1]) || 0) * (f[3] ? cnt(f[3], o, x) : 1)) : 0), 0), 0);
    return sum([...G.p[p].front, ...G.p[p].vault], p, false) + sum([...G.p[1 - p].front, ...G.p[1 - p].vault], 1 - p, true)
}

/* current maximum HP of a Unit: printed HP + permanent bonus + passive effects */
function HPv(u) {
    const p = G.p[0].front.includes(u) ? 0 : G.p[1].front.includes(u) ? 1 : -1;
    return u.h + (u.bh || 0) + (p < 0 ? 0 : statBonus(p, u, 'hp'))
}

const A = (p, u) => Math.max(0, statBonus(p, u) + u.a + u.ba + (u.tb || 0));

const can = (p, c) => {
    const P = G.p[p];
    return P.lume >= c.c
}
;

/* PICK targets: the player chooses ONE Unit.  pick = an enemy Unit, mypick = a Unit you control, anypick = any Unit.
   Tactical: chosen when you cast it.  Unit / Relic abilities: the game asks you when the ability triggers (the AI chooses for itself). */
const PICKS = ['pick', 'mypick', 'anypick', 'relic', 'myrelic', 'anyrelic'];

const pickOf = c => (c.t == 'T' ? c.fx || [] : []).map(f => f[2]).find(t => PICKS.includes(t));

const pk = c => !!pickOf(c);

const pickList = (p, tg) => tg == 'pick' ? G.p[1 - p].front : tg == 'mypick' ? G.p[p].front : tg == 'relic' ? G.p[1 - p].vault : tg == 'myrelic' ? G.p[p].vault : tg == 'anyrelic' ? [...G.p[1 - p].vault, ...G.p[p].vault] : [...G.p[1 - p].front, ...G.p[p].front];

const GOODFX = ['buff', 'surge', 'heal'];

/* the AI's choice: help its own Units with helpful effects, otherwise hit the strongest enemy Unit */
function aiPickList(p, tg, ty, n, key) {
    if (lvOf(p) == 'axiom' && isAI(p))
        return axPickList(p, tg, ty, n, key);
    const L = pickList(p, tg)
      , mine = u => G.p[p].front.includes(u) || G.p[p].vault.includes(u)
      , good = GOODFX.includes(ty);
    if (!L.length)
        return [];
    const pool = tg == 'anypick' || tg == 'anyrelic' ? L.filter(u => good == mine(u)) : L
      , l = pool.length ? pool : L;
    const sc = u => u.t == 'R' ? u.c : ty == 'return' ? (mine(u) ? (u.dmg || 0) * 3 - A(p, u) : A(1 - p, u)) : ty == 'destroy' ? (mine(u) ? -A(p, u) : A(1 - p, u)) : ty == 'heal' ? (u.dmg || 0) : A(mine(u) ? p : 1 - p, u);
    return [...l].sort( (a, b) => sc(b) - sc(a))
}

const aiPickT = (p, tg, ty, n, key) => aiPickList(p, tg, ty, n, key)[0] || null;

/* how many Units a Tactical lets you choose (only 'return', 'raze' and 'destroy' can choose more than one) */
const pkN = c => {
    const f = (c.fx || []).find(f => PICKS.includes(f[2]));
    return f && (f[0] == 'return' || f[0] == 'raze' || f[0] == 'destroy') && f[1] > 1 ? f[1] : 1
}
;

const aiPickC = (p, c) => {
    const f = c.fx.find(f => PICKS.includes(f[2]))
      , L = aiPickList(p, f[2], f[0], f[1], f[3]);
    return pkN(c) > 1 ? L.slice(0, pkN(c)) : L[0]
}
;

/* ---- TIMING RULES ----
   Tactical : instant speed. Playable on ANY turn (yours or the opponent's), also while you are choosing blockers.
   Unit / Relic : only in YOUR OWN Main phase (Main 1 or Main 2) while you are the active player. */
const tacOK = () => G.started && !G.over && !G.lock && !['keep', 'mul', 'tg', 'disc', 'xv'].includes(G.mode);

const timingOK = c => c.t == 'T' ? tacOK() : (G.started && !G.over && G.act == 0 && inMain() && !G.mode && !G.lock);

const say = t => {
    mlog(t);
    G.log.unshift(t);
    G.log.length = Math.min(G.log.length, 6)
}
;

/* ================= MATCH LOG =================
   Every action of BOTH players (plays, abilities, attacks, blocks, damage, deaths, Lume ...) and a full board snapshot at the start of
   every turn are collected in MLOG while a match is played. When the match ends the text is written to database/logs/log1.txt, log2.txt ...
   (the next free number). A browser page may not write to your disk by itself: the first time you choose your `database` folder once
   (the game remembers it); a browser without folder access downloads logN.txt instead. */
const MLOG = {
    L: [],
    hand: 1,
    rows: [],
    decks: [],
    src: 'game'
};

/* balance statistics: MS[player][kind][source] = amount. kinds: life+ life- lume+ lume- debt+ debt- (who changed, caused by which card/rule),
   played / drawn / destroyed / attacked / blocked (counts per card name) */
let MS = [{}, {}];

const mlS = (p, k, d) => {
    if (p < 0 || !d)
        return;
    const kk = k + (d > 0 ? '+' : '-')
      , cur = G && G.cur && G.cur.length ? G.cur[G.cur.length - 1] : null
      , src = cur && cur.n ? cur.n : MLOG.src || '?'
      , o = MS[p][kk] = MS[p][kk] || {};
    o[src] = (o[src] || 0) + Math.abs(d)
}
  , mlC = (p, k, name, n=1) => {
    const o = MS[p][k] = MS[p][k] || {};
    o[name] = (o[name] || 0) + n
}
  , mlSrc = t => {
    MLOG.src = t
}
;

const mlStrip = t => String(t).replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function mlog(t) {
    if (!G || !G.p)
        return;
    MLOG.L.push(`[T${G.turn || 0} ${SPEC ? 'S' + (G.act + 1) : G.act ? 'AI' : 'YOU'} ${G.ph || '-'}] ${mlStrip(t)}`)
}

/* printed Lume cost (before Echo is taken off); an Echo card shows its Echo too */
/* the Lume cost a player SEES is the printed cost (c0 when the card has Echo, otherwise c). c is what is PAID (printed cost - Echo)
   and is only for the rules: every number drawn for a card (face, deck lists, curve, filters, sorting) uses lumeCost */
const lumeCost = c => c.c0 == null ? c.c : c.c0;

/* THE LUME COST FLOOR: whatever lowers a card's cost (Echo, Drawdown, any granted or future reduction) it can never be paid for less than 1 Lume.
   A card whose PRINTED cost is 0 (tokens, free cards) stays free. */
function payCost(printed, ...cuts) {
    const p = Number(printed) || 0;
    return p <= 0 ? 0 : Math.max(1, p - cuts.reduce((t, x) => t + (x || 0), 0))
}

const mlCost = c => lumeCost(c) + (c.e ? ` echo ${c.e}` : '') + (c.dd ? ` drawdown ${c.dd}` : '');

const mlU = (p, u) => `${u.n} ${A(p, u)}/${HPv(u) - u.dmg}${u.st == 'R' ? ' (rest)' : u.st == 'P' ? ' (prep)' : ''}${u.tok ? ' token' : ''}${Object.keys(u.ctr || {}).filter(k => u.ctr[k] > 0).map(k => ` ${k}x${u.ctr[k]}`).join('')}`;

/* who a seat is in the match log: YOU / AI in a duel, S1 / S2 when watching AI vs AI (spectate) */
const mlWho = i => SPEC ? 'S' + (i + 1) + ' ' : i ? 'AI ' : 'YOU'
  , mlRes = () => SPEC ? ({
    win: 'S1 wins',
    loss: 'S2 wins'
}[G.res] || G.res || '?') : G.res || '?';

function mlState(tag) {
    if (!G || !G.p)
        return;
    const L = MLOG.L;
    L.push(`---- ${tag} ----`);
    if (/^(TURN|FINAL)/.test(tag))
        MLOG.rows.push({
            t: G.turn,
            act: G.act,
            tag: /^\w+/.exec(tag)[0],
            life: G.p.map(P => P.life),
            lume: G.p.map(P => P.lume),
            debt: G.p.map(P => P.debt || 0),
            hand: G.p.map(P => P.hand.length),
            units: G.p.map(P => P.front.length),
            atk: G.p.map( (P, i) => P.front.reduce( (s, u) => s + A(i, u), 0)),
            hp: G.p.map(P => P.front.reduce( (s, u) => s + HPv(u) - u.dmg, 0)),
            waste: G.p.map(P => P.waste.length),
            deck: G.p.map(P => P.deck.length)
        });
    G.p.forEach( (P, i) => {
        L.push(`  ${mlWho(i)} ${P.name}: life ${P.life}  lume ${P.lume}  debt ${P.debt || 0}  lumeVictory ${P.ctr || 0}/3  hand ${P.hand.length}  logistic ${P.deck.length}  wasteland ${P.waste.length}`);
        L.push(`      hand: ${P.hand.map(c => `${c.n}(${mlCost(c)})`).join(', ') || '-'}`);
        L.push(`      front: ${P.front.map(u => mlU(i, u)).join(' | ') || '-'}`);
        L.push(`      vault: ${P.vault.map(r => r.n).join(', ') || '-'}`)
    }
    )
}

/* ---- balance summary: written at the top of every log ---- */
const mlTop = (o, n=6) => Object.entries(o || {}).sort( (a, b) => b[1] - a[1]).slice(0, n).map( ([k,v]) => `${k} ${v}`).join(', ') || '-'
  , mlSumOf = o => Object.values(o || {}).reduce( (a, b) => a + b, 0)
  , mlSummary = () => {
    const L = []
      , nm = i => `${mlWho(i)} ${G.p[i].name}`
      , R = MLOG.rows.filter(r => r.tag == 'TURN');
    L.push('==== BALANCE SUMMARY ====');
    [0, 1].forEach(i => {
        L.push(`deck ${nm(i)} (${Object.values(MLOG.decks[i] || {}).reduce( (a, b) => a + b, 0)} cards): ` + Object.entries(MLOG.decks[i] || {}).map( ([k,v]) => `${v}x ${k}`).join(', '))
    }
    );
    const w = G.p.map( (P, i) => mlTop(MS[i]['life-'], 3));
    L.push(`result: ${mlRes()} "${mlStrip(G.over || '')}" after ${G.turn} turns (${R.filter(r => r.act == 0).length} ${SPEC ? 'seat 1' : 'yours'}, ${R.filter(r => r.act == 1).length} ${SPEC ? 'seat 2' : 'AI'})`);
    const w0 = SPEC ? 'S1' : 'you', w1 = SPEC ? 'S2' : 'AI';
    L.push(`final life: ${w0} ${G.p[0].life} / ${w1} ${G.p[1].life}   final lume: ${w0} ${G.p[0].lume} / ${w1} ${G.p[1].lume}   Lume Victory progress: ${w0} ${G.p[0].ctr || 0}/3 / ${w1} ${G.p[1].ctr || 0}/3`);
    L.push(SPEC ? `what hurt the loser most: ${G.res == 'win' ? `S2 ${G.p[1].name} lost Life to: ${w[1]}` : G.res == 'loss' ? `S1 ${G.p[0].name} lost Life to: ${w[0]}` : `S1 lost Life to: ${w[0]}; S2 lost Life to: ${w[1]}`}` : `what hurt the loser most: ${G.res == 'win' ? `AI lost Life to: ${w[1]}` : `you lost Life to: ${w[0]}`}`);
    [0, 1].forEach(i => {
        const m = MS[i];
        L.push('');
        L.push(`-- ${nm(i)} --`);
        L.push(`  Lume gained ${mlSumOf(m['lume+'])} (${mlTop(m['lume+'])})`);
        L.push(`  Lume lost/spent ${mlSumOf(m['lume-'])} (${mlTop(m['lume-'])})`);
        L.push(`  Life gained ${mlSumOf(m['life+'])} (${mlTop(m['life+'])})`);
        L.push(`  Life lost ${mlSumOf(m['life-'])} (${mlTop(m['life-'])})`);
        L.push(`  Echo Debt taken ${mlSumOf(m['debt+'])} (${mlTop(m['debt+'])})  repaid/moved away ${mlSumOf(m['debt-'])}  payday: ${mlTop(m.payday)}`);
        L.push(`  cards drawn ${mlSumOf(m.drawn)}, played ${mlSumOf(m.played)} (${mlTop(m.played, 12)})`);
        L.push(`  abilities activated: ${mlTop(m.activated, 8)}`);
        L.push(`  attacked ${mlSumOf(m.attacked)} times (${mlTop(m.attacked, 8)}); blocked ${mlSumOf(m.blocked)} times (${mlTop(m.blocked, 8)})`);
        L.push(`  units destroyed ${mlSumOf(m.destroyed)} (${mlTop(m.destroyed, 8)})`);
        const rs = R.filter(r => r.act == i);
        if (rs.length)
            L.push(`  own turns: peak lume ${Math.max(...rs.map(r => r.lume[i]))}, lowest life ${Math.min(...R.map(r => r.life[i]))}, peak life ${Math.max(...R.map(r => r.life[i]))}, avg hand ${(rs.reduce( (a, r) => a + r.hand[i], 0) / rs.length).toFixed(1)}, avg units ${(rs.reduce( (a, r) => a + r.units[i], 0) / rs.length).toFixed(1)}, turns with 0 units ${rs.filter(r => !r.units[i]).length}`)
    }
    );
    L.push('');
    L.push('-- per turn (snapshot at the START of each turn, after income/Payday/draw) --');
    L.push(`  T  who | life ${SPEC ? 'S1/S2' : 'you/AI'} | lume ${SPEC ? 'S1/S2' : 'you/AI'} | debt ${SPEC ? 'S1/S2' : 'you/AI'} | hand | units | ATK on board | HP on board | logistic`);
    R.forEach(r => L.push(`  ${String(r.t).padStart(2)} ${mlWho(r.act)} | ${r.life.join('/')} | ${r.lume.join('/')} | ${r.debt.join('/')} | ${r.hand.join('/')} | ${r.units.join('/')} | ${r.atk.join('/')} | ${r.hp.join('/')} | ${r.deck.join('/')}`));
    L.push('==== END SUMMARY ====');
    return L
}
;

const mlTxt = () => {
    const [a,b] = G.p;
    return [`Aetheris Arena match log (format 2: header, BALANCE SUMMARY, then every event)`, `date: ${new Date().toISOString()}`, ...(SPEC ? [`mode: SPECTATE (AI vs AI)`, `seat 1 (S1): ${a.name} / ${SPEC_LV[0]} (deck ${SPEC_DECK[0] || '?'})   seat 2 (S2): ${b.name} / ${SPEC_LV[1]} (deck ${SPEC_DECK[1] || '?'})`, `result: ${mlRes()}  "${G.over || ''}"  turns ${G.turn}  final life S1 ${a.life} / S2 ${b.life}`] : [`you: ${a.name} (deck ${(typeof dkCur == 'function' && dkCur() || {}).name || '?'})   opponent: ${b.name} / ${AI_LEVEL} (deck ${AI_DECK_NAME || '?'})`, `result: ${mlRes()}  "${G.over || ''}"  turns ${G.turn}  final life you ${a.life} / opponent ${b.life}`]), ''].concat(mlSummary(), ['', '==== EVENT LOG ===='], MLOG.L).join('\n') + '\n'
}
;

/* DRAW: an empty Logistic is not a defeat by itself. A player loses when a card MUST be drawn and the Logistic is empty
   (P.dry marks that failed draw; check() ends the game) */
const draw = (p, n) => {
    const P = G.p[p];
    while (n-- > 0) {
        if (!P.deck.length) {
            P.dry = 1;
            say(`${P.name} cannot draw: the Logistic is empty`);
            break
        }
        P.hand.push(P.deck.shift());
        mlC(p, 'drawn', 'cards');
        emit('draw', p)
    }
}
;

/* n cards were put back into player q's Logistic (retrieve, the rest of a look, a search put on top).
   ONE event per move: "relog" for q's cards, "orelog" for the other player's; the variable `delta` = n */
function relogEvent(q, n) {
    if (!(n > 0))
        return;
    emit('relog', q, null, n)
}

/* the top n cards of player q's Logistic go to the Wasteland. ONE event per mill (not per card):
   "mill" fires for q's cards, "omill" for the other player's cards */
function millDeck(q, n) {
    const T = G.p[q]
      , top = T.deck.splice(0, Math.max(0, n));
    T.waste.push(...top);
    if (top.length) {
        say(`${top.length} card${top.length > 1 ? 's' : ''} from ${T.name}'s Logistic go to the Wasteland`);
        emit('mill', q, null, top.length)
    }
    return top
}

/* ['look', x, take, where]: look at the top x cards of YOUR Logistic and put `take` of them into your hand;
   the rest return to the 'bottom' (default), the 'top' or are shuffled in. The player chooses on a card screen (see drawLk),
   the computer takes the cards it can use best. */
const lookTake = f => Math.max(1, Math.floor(+f[2]) || 1);

function lookTop(p, s, f) {
    const P = G.p[p]
      , top = P.deck.slice(0, Math.max(0, f[1]))
      , take = Math.min(lookTake(f), top.length);
    if (!top.length)
        return;
    let got = G.lkc;
    if (!got) {
        if (top.length <= take)
            got = top;
        else if (isAI(p)) {
            const v = c => (c.t == 'U' ? c.a + c.h : c.t == 'R' ? 3 : 2.5) - Math.max(0, c.c - P.lume - 1);
            got = [...top].sort( (a, b) => v(b) - v(a)).slice(0, take)
        } else {
            (G.pq = G.pq || []).push([p, s, f]);
            return
        }
    }
    const rest = top.filter(c => !got.includes(c));
    P.deck.splice(0, top.length);
    P.hand.push(...got);
    if (f[3] == 'top')
        P.deck.unshift(...rest);
    else if (f[3] == 'shuffle') {
        P.deck.push(...rest);
        sh(P.deck)
    } else
        P.deck.push(...rest);
    relogEvent(p, rest.length);
    say(p == 0 ? `${P.name} looks at the top ${top.length} card${top.length > 1 ? 's' : ''} and takes ${got.map(c => c.n).join(', ')}` : `${P.name} looks at the top ${top.length} card${top.length > 1 ? 's' : ''} of the Logistic and takes ${got.length}`)
}

/* ['search', n, 'Card Name' | 'type:unit' | 'type:relic' | 'type:tactical', 'hand' | 'top']: take up to n matching cards out of YOUR Logistic,
   shuffle it, then put them into the hand (default) or on top of it. A name means identical copies (no choice); a type lets the player choose
   on the same card screen as 'look' (drawLk), the computer takes what it can use best. */
const searchCands = (p, tg) => {
    const sp = searchSpec(tg)
      , want = String(tg || '').trim().toLowerCase();
    return G.p[p].deck.filter(c => sp ? !sp.err && (!sp.type || c.t == sp.type[0]) && cardMatch(c, {
        sub: sp.sub,
        faction: sp.faction
    }) : String(c.n).toLowerCase() == want)
}
;

const searchK = (p, s, f) => Math.max(1, Math.floor(+numOf(p, s, f[1])) || 1);

function searchDeck(p, s, f) {
    const P = G.p[p]
      , k = searchK(p, s, f)
      , cand = searchCands(p, f[2]);
    let found = G.lkc;
    if (!found) {
        if (cand.length <= k || !searchSpec(f[2]))
            found = cand.slice(0, k);
        else if (isAI(p)) {
            const v = c => (c.t == 'U' ? c.a + c.h : c.t == 'R' ? 3 : 2.5) - Math.max(0, c.c - P.lume - 1);
            found = [...cand].sort( (a, b) => v(b) - v(a)).slice(0, k)
        } else {
            (G.pq = G.pq || []).push([p, s, f]);
            return
        }
    }
    found.forEach(c => P.deck.splice(P.deck.indexOf(c), 1));
    sh(P.deck);
    if (f[3] == 'top')
        P.deck.unshift(...found);
    else
        P.hand.push(...found);
    const what = searchSpec(f[2]) ? 'a ' + searchNoun(searchSpec(f[2])) : String(f[2] || 'a card');
    say(p == 0 ? (found.length ? `${P.name} searches the Logistic and finds ${found.map(c => c.n).join(', ')}${f[3] == 'top' ? ' (put on top)' : ''}` : `${P.name} searches the Logistic for ${what} but finds nothing`) : `${P.name} searches the Logistic${found.length ? ' and finds a card' : ' but finds nothing'}`);
    if (f[3] == 'top')
        relogEvent(p, found.length);
    if (found.length)
        mlC(p, 'drawn', 'cards')
}

function init() {
    resetAnim();
    matchStarted();
    G = {
        p: SPEC ? [0, 1].map(i => newP(specName(i), DECKS[SPEC_DECK[i]] || DECKS[legalDecks()[0]])) : [newP(profName(), PLAYER_DECK || DECKS[legalDecks()[0]]), newP(AI_LV[AI_LEVEL].name, DECKS[AI_DECK_NAME] || DECKS[legalDecks()[0]])],
        act: 0,
        turn: 0,
        ph: '',
        sel: [],
        mode: SPEC ? null : 'keep',
        spec: SPEC,
        log: [],
        over: 0,
        started: 0,
        selc: null,
        pr: {},
        at: [],
        atkNow: new Set(),
        da: null
    };
    MLOG.L.length = 0;
    MLOG.rows = [];
    MLOG.src = 'game';
    MS = [{}, {}];
    MLOG.decks = G.p.map(P => {
        const m = {};
        P.deck.forEach(c => m[c.n] = (m[c.n] || 0) + 1);
        return m
    }
    );
    mlReset();
    mlog('match start');
    draw(0, 7);
    draw(1, 7);
    mlState('OPENING HANDS');
    if (SPEC)
        say(`${G.p[0].name} plays ${SPEC_DECK[0]}, ${G.p[1].name} plays ${SPEC_DECK[1]}`);
    else if (AI_DECK_NAME)
        say(`${AI_LV[AI_LEVEL].name} plays ${AI_DECK_NAME}`);
    render();
    if (SPEC)
        aiLater(begin, 1500)
}

function begin() {
    if (G.started || (!SPEC && G.mode != 'keep' && G.mode != 'mul'))
        return;
    G.started = 1;
    let r = [0, 0];
    while (r[0] == r[1])
        r = [1 + Math.random() * 20 | 0, 1 + Math.random() * 20 | 0];
    say(SPEC ? `D20 roll: ${G.p[0].name} ${r[0]}, ${G.p[1].name} ${r[1]}` : `D20 roll: you ${r[0]}, opponent ${r[1]}`);
    G.mode = null;
    start(r[0] > r[1] ? 0 : 1)
}

function mull() {
    if (G.started || G.mode != 'keep')
        return;
    const M = G.p[0];
    G.old = M.hand;
    M.hand = M.deck.splice(0, 7);
    G.mode = 'mul';
    render()
}

/* ---- trigger engine ---- */
const SELF = ['play', 'death', 'attack', 'defend', 'echo', 'block'];

/* every Unit state change goes through setSt so no Prepare/Standby/Rest event is ever lost
   (e.g. a Unit that wakes up and is rested again before the next check used to look unchanged) */
function setSt(u, v) {
    if (u.st !== v)
        (G.stq = G.stq || []).push([u, u.st, v]);
    u.st = v
}

/* FIRST-TURN DEBT PROTECTION: only until a player has had their FIRST turn, the opponent cannot push their total Echo Debt above FT_DEBT.
   So going first (or dumping debt the turn before) can never wipe out a player who has not yet had a chance to build. From their second turn on there is no cap.
   (The first turn also has no Payday, see extract: that is the only skip.) debtRoom(T) = how much more debt T may still take now. */
const FT_DEBT = 10;
/* RULE: Echo Debt goes to your LIFE. At Payday the Lume in your reservoir does NOT pay the debt any more: every Echo Debt costs you 1 Life and your Lume is left alone.
   (false = the old rule: the Lume in the reservoir pays the debt first, 1 Lume = 1 Echo Debt, and only the rest costs Life.) */
const ECHO_PAYS_LIFE = true;

function debtRoom(T) {
    return G && G.p[G.act] !== T && !T.hadTurn ? Math.max(0, FT_DEBT - (T.debt || 0)) : Infinity
}

function ftNote(T) {
    if (T.ftN)
        return;
    T.ftN = 1;
    say(`${T.name} is protected until their first turn: Echo Debt cannot go above ${FT_DEBT}`)
}

/* CARD CUE: tells the UI which card is being played / activated / triggered, so it can show the #zoom preview for a moment (cardCue is a UI hook) */
function cue(c, p, kind) {
    if (typeof cardCue == 'function')
        try {
            cardCue(c, p, kind)
        } catch (x) {}
}

/* amt = the number 'delta' stands for while this trigger runs (default 1: one event) */
function fire(tr, p, src, amt) {
    const pa = G.evAmt;
    G.evAmt = amt == null ? 1 : amt;
    try {
        fire0(tr, p, src)
    } finally {
        G.evAmt = pa
    }
}

function fire0(tr, p, src) {
    const run = s => (s.ab || []).forEach( (a, ai) => {
        if (a.tr != tr && !(a.trs || []).includes(tr))
            return;
        if (!SELF.includes(tr) && !G.p[p].front.includes(s) && !G.p[p].vault.includes(s))
            return;
        if (!ifOk(a.if, p, s))
            return;
        if ((tr == 'counter' || tr == 'ocounter') && a.ctr && G.evCtr != cn(a.ctr))
            return;
        if (a.of && !(src && cardMatch(src, a.of)))
            return;
        if ((G.evBy || []).includes(s) && /^o?(lume|life|debt)(up|down)$/.test(tr))
            return;
        /* max: n = this ability triggers at most n times each turn (max: 1 = once per turn). s.tu[ai] counts how many times it already triggered this turn */
        const lim = a.tr == 'act' ? 0 : a.max > 0 ? Math.floor(a.max) : 0;
        if (lim) {
            if (((s.tu || {})[ai] || 0) >= lim)
                return;
            (s.tu = s.tu || {})[ai] = ((s.tu || {})[ai] || 0) + 1
        }
        TXT_TR = [tr];
        say(selfN(s, `${IC.bolt} ${s.n} — ${TR[tr]}: ${fxJ(a.fx)}`));
        cue(s, p, 'trig');
        s.trig = 1;
        G.nf = (G.nf || 0) + 1;
        const pc = G.cur
          , pes = G.evSrc;
        G.cur = [...(G.evBy || []), s];
        G.evSrc = src;
        s.rm = 0;
        a.fx.forEach(f => fx(p, s, f));
        G.cur = pc;
        G.evSrc = pes
    }
    );
    if (SELF.includes(tr)) {
        src && run(src)
    } else
        [...G.p[p].front, ...G.p[p].vault].filter(s => !((tr == 'enter' || tr == 'aecho' || tr == 'aact' || tr == 'anyplay' || tr == 'ablock' || tr == 'aattack' || tr == 'adefend') && s === src)).forEach(run)
}

/* ---- activated abilities with an additional cost ---- */
/* An activated ability whose EFFECTS would resolve nothing must not be activatable: it would burn its once-per-turn use for no result.
   The costs are checked by costsOK; counter effects written in 'fx' (not in 'cost') were never checked:
   Praetorum / Rector Auresol could be activated with no Order counter to remove (and Praedicolum with no Unit to put one on).
   Returns the short reason, or '' when the ability would do something. Enemy / 'pick' targets and abilities with an 'or' choice are left to the old rules. */
function actNoopWhy(p, s, a) {
    const P = G.p[p]
      , L = a.fx || [];
    if (L.includes('or'))
        return '';
    let added = false;
    for (const f of L) {
        if (!Array.isArray(f) || (f[0] != 'uncounter' && f[0] != 'counter'))
            continue;
        const [ty,n0,tg,nm] = f
          , spec = tgSpec(tg)
          , pool = tg == 'self' ? [s] : tg == 'others' ? P.front.filter(u => u !== s) : tg == 'allies' || tg == 'mypick' ? P.front : spec && !/^ehas:/.test(tg) ? P.front.filter(u => cardMatch(u, spec)) : null;
        if (!pool)
            continue;
        if (ty == 'counter') {
            if (!pool.length)
                return 'No Unit to put a counter on';
            added = true;
            continue
        }
        /* a counter put on the same targets earlier in this ability can be removed by the next effect */
        if (added)
            continue;
        const n = n0 == 'all' || isRem(n0) ? 1 : Math.max(1, Math.floor(+numOf(p, s, n0)) || 1);
        if (!pool.some(u => ctrN(u, nm) >= n))
            return `No ${ctrName(cn(nm || 'Order'))} counter to remove`
    }
    return ''
}

/* act limits: max: n = at most n activations of THIS ability each turn (counted in s.tu, like triggered abilities) */
const actUsedUp = (s, a) => a.max > 0 && ((s.tu || {})[(s.ab || []).indexOf(a)] || 0) >= Math.floor(a.max);
function canAct(p, s, a) {
    if (a.tr != 'act' || G.over || G.act != p || !inMain() || G.mode || G.lock)
        return false;
    const P = G.p[p];
    if (!(P.front.includes(s) || P.vault.includes(s)) || actUsedUp(s, a))
        return false;
    return costsOK(p, s, costOf(a)) && !actNoopWhy(p, s, a)
}

/* WHY an activated ability cannot be used right now: this is the short reason printed on its greyed-out button */
function whyNot(p, s, a) {
    const P = G.p[p];
    if (actUsedUp(s, a))
        return a.max == 2 ? 'Already used twice this turn' : a.max > 2 ? `Already used ${numW(Math.floor(a.max))} times this turn` : 'Already used this turn';
    for (const f of costOf(a)) {
        const [ty,n0,tg] = f
          , n = Math.floor(+numOf(p, s, n0)) || 0;
        if (ty == 'lume' && n < 0 && P.lume < -n)
            return `Needs ${-n} Lume`;
        if (ty == 'discard' && P.hand.length < n)
            return `Needs ${n} card${n > 1 ? 's' : ''} in your hand`;
        if (ty == 'dmg' && tg == 'me' && P.life <= n)
            return 'Not enough Life to pay';
        if (ty == 'mill' && tg != 'opp' && P.deck.length < n)
            return 'Your Logistic is too small';
        if (!costsOK(p, s, [f]))
            return ty == 'rest' || (ty == 'state' && n0 == 'rest') ? (s.st == 'P' ? 'This Unit is still in Prepare (needs Standby)' : s.st == 'R' ? 'This Unit is Resting' : 'Needs a ready Unit') : 'The cost cannot be paid';
    }
    return actNoopWhy(p, s, a)
}

/* can every effect of a cost be fully done right now?  Needs add up (two Lume costs need both). The cost effects themselves are run by fx(). */
function costsOK(p, s, list) {
    const P = G.p[p]
      , need = {
        lume: 0,
        life: 0,
        mill: 0,
        discard: 0
    }
      , ctr = {};
    for (const f of list) {
        const [ty,n0,tg,nm] = f
          , n = Math.floor(+numOf(p, s, n0)) || 0
          , us = tgUnits(p, s, tg, () => []).filter(u => G.p.some(Q => Q.front.includes(u)));
        if (ty == 'lume')
            need.lume += Math.max(0, -n);
        else if (ty == 'dmg' && tg == 'me')
            need.life += n;
        else if (ty == 'mill' && tg != 'opp')
            need.mill += n;
        else if (ty == 'discard')
            need.discard += n;
        else if (ty == 'raze' && tg == 'self') {
            /* destroying this Relic as a cost needs the Relic to be in your Vault */
            if (!P.vault.includes(s))
                return false
        } else if (ty == 'rest' || (ty == 'state' && n0 == 'rest')) {
            /* setting a Unit to Rest as a cost needs a ready (Standby) Unit */
            if (!us.length || !us.every(u => u.st == 'S'))
                return false
        } else if (['dmg', 'state', 'destroy', 'prune', 'return'].includes(ty) && tg != 'opp' && tg != 'me' && !us.length)
            return false;
        else if (ty == 'uncounter') {
            if (!us.length)
                return false;
            if (n0 == 'all') {
                if (!us.some(u => ctrN(u, nm) > 0))
                    return false
            } else {
                const k = cn(nm);
                ctr[k] = (ctr[k] || 0) + n;
                if (!us.every(u => ctrN(u, nm) >= ctr[k]))
                    return false
            }
        }
    }
    return P.lume >= need.lume && (!need.life || P.life > need.life) && (!need.mill || P.deck.length >= need.mill) && P.hand.length >= need.discard
}

/* ready = payable AND its effects would do something right now (used by the glow and the auto phase skip) */
const actReady = (p, s) => acts(s).some(a => canAct(p, s, a) && meetsTrigger(p, {
    t: 'T',
    fx: a.fx
}));

/* discard n cards from the hand: the player CHOOSES them (G.dpk = ids from the discard selection of an activation);
   with no choice made (computer, or any other effect) the cheapest cards go */
/* GRANT TO A HAND: ['grant', n, 'hand', 'keyword'] = the Units in YOUR hand, ['grant', n, 'ehand', 'keyword'] = the Units in the ENEMY hand.
   Echo and Drawdown go to every card type; any other keyword only to Unit cards. The keyword stays on the card when it is played (a keyword without a number ignores n).
   Echo n / Drawdown n change the cost: c0 = the printed cost, c.e = Echo, c.dd = Drawdown, c.c = what you pay (printed cost - Echo - Drawdown, never below 1 unless the printed cost is 0);
   they do not stack (the bigger number counts) and are permanent. Other keywords: permanent, or 'turn' / 'next' (cleared like on the board). */
/* HAND targets: [e|a][u|t|r]hand.  none = your hand, e = the enemy hand, a = BOTH hands;  none = every card, u = Unit cards, t = Tactical cards, r = Relic cards.
   hand ehand ahand | uhand euhand auhand | thand ethand athand | rhand erhand arhand */
function handTg(tg) {
    const m = /^([ea]?)([utr]?)hand$/.exec(String(tg || ''));
    return m ? {e: m[1], ty: m[2] ? m[2].toUpperCase() : null} : null
}

function handSides(p, H) {
    return H.e == 'a' ? [p, 1 - p] : H.e == 'e' ? [1 - p] : [p]
}

/* Echo and Drawdown reach every card type; any other keyword only Unit cards */
function handGrantList(Q, gk, n, ty) {
    return Q.hand.filter(c => (!ty || c.t == ty) && (c.t == 'U' || gk == 'drawdown' || gk == 'echo') && (gk == 'drawdown' || gk == 'echo' ? !kOff(c, gk) && (n > 0 || (gk == 'echo' ? c.e : c.dd) > 0) : !hk(c, gk)))
}

function grantHand(who, giver, gk, n, dur, ty) {
    const Q = G.p[who];
    if (!KWS[gk])
        return;
    handGrantList(Q, gk, n, ty).forEach(c => {
        if (gk == 'drawdown' || gk == 'echo') {
            const fld = gk == 'echo' ? 'e' : 'dd'
              , p0 = c.c0 == null ? c.c : c.c0;
            c.c0 = p0;
            /* a numbered keyword ADDS UP: Echo 1 + a grant of Echo 2 = Echo 3 */
            /* a negative n takes it away again (down to 0 = the keyword is gone) */
            /* the discounts (Echo + Drawdown) never go past the printed cost - 1: at least 1 Lume is always paid. A grant only fills up to that limit
               (a number that is already above it, printed on the card, is left alone) */
            const old = c[fld] || 0
              , room = Math.max(0, p0 - 1 - (fld == 'e' ? c.dd || 0 : c.e || 0));
            c[fld] = n > 0 ? Math.max(old, Math.min(old + n, room)) : Math.max(0, old + n);
            c.c = payCost(p0, c.e, c.dd);
            if (!c[fld]) {
                c.kw = (c.kw || []).filter(x => x[0] != gk);
                c.kg = (c.kg || []).filter(x => x != gk);
                c.ks = (c.ks || []).filter(x => x != gk);
                if (c.kgn)
                    delete c.kgn[gk]
            } else
            /* the card shows it as a keyword (a native one just gets the new total) */
            if ((c.ks || []).includes(gk))
                c.kw = (c.kw || []).map(x => x[0] == gk ? [gk, c[fld]] : x);
            else {
                if (!(c.kg || []).includes(gk))
                    c.kg = [...(c.kg || []), gk];
                c.kgn = {...(c.kgn || {}), [gk]: c[fld]}
            }
        } else {
            if (dur == 'turn')
                c.kt = [...(c.kt || []), gk];
            else if (dur == 'next')
                c.kx = [...(c.kx || []), [gk, giver]];
            else
                c.kg = [...(c.kg || []), gk];
            if (KWS[gk].x && n >= 1)
                c.kgn = {...(c.kgn || {}), [gk]: n}
        }
        say(`${c.n} (in ${G.p[who].name}'s hand) ${n < 0 ? 'loses' : 'gains'} ${KWS[gk].n}${KWS[gk].x ? ' ' + Math.abs(n) : ''}`)
    }
    )
}

/* DISABLE: ['disable', target, 'keyword' | 'all' (, 'turn' | 'next')].  Any card target works (Units, Relics, picks, hand targets).
   On the board / in a hand it is stored on the card (kd / kdt / kdx) and read through hk; Echo and Drawdown in a hand are switched off for good and the cost is recalculated. */
function disableOn(c, gk, dur, giver) {
    if (dur == 'turn')
        c.kdt = [...(c.kdt || []), gk];
    else if (dur == 'next')
        c.kdx = [...(c.kdx || []), [gk, giver]];
    else
        c.kd = [...(c.kd || []), gk]
}

function hasKwOn(c, gk) {
    if (gk == 'all')
        return !kOff(c, 'all') && !!((c.ks || []).length || (c.kg || []).length || (c.kt || []).length || (c.kx || []).length || c.e > 0 || c.dd > 0);
    return hk(c, gk) || (gk == 'echo' && c.e > 0 && !kOff(c, gk)) || (gk == 'drawdown' && c.dd > 0 && !kOff(c, gk))
}

function handDisableList(Q, gk, ty) {
    return Q.hand.filter(c => (!ty || c.t == ty) && hasKwOn(c, gk))
}

function disableHand(who, giver, gk, dur, ty) {
    handDisableList(G.p[who], gk, ty).forEach(c => {
        if (gk == 'echo' || gk == 'drawdown' || gk == 'all') {
            if (gk != 'drawdown')
                c.e = 0;
            if (gk != 'echo')
                c.dd = 0;
            c.c = payCost(c.c0 == null ? c.c : c.c0, c.e, c.dd);
            c.kd = [...(c.kd || []), gk]
        } else
            disableOn(c, gk, dur, giver);
        say(`${c.n} (in ${G.p[who].name}'s hand) loses ${gk == 'all' ? 'its keywords' : KWS[gk].n}`)
    }
    )
}

function discardCards(p, n) {
    const P = G.p[p]
      , chosen = (G.dpk ? G.dpk.splice(0, n) : []).map(id => P.hand.find(c => c.id == id)).filter(Boolean);
    while (chosen.length < n) {
        const low = P.hand.filter(c => !chosen.includes(c)).sort( (a, b) => a.c - b.c)[0];
        if (!low)
            break;
        chosen.push(low)
    }
    chosen.forEach(c => {
        P.hand.splice(P.hand.indexOf(c), 1);
        P.waste.push(c);
        say(`${P.name} discards ${c.n}`);
        emit('discard', p, c)
    }
    )
}

/* the Units an effect target points at (pickU = how the chosen Units of a pick target are found) */
function tgUnits(p, s, tg, pickU) {
    const P = G.p[p]
      , O = G.p[1 - p];
    return {
        self: [s],
        allies: P.front,
        enemies: O.front,
        pick: pickU('pick'),
        mypick: pickU('mypick'),
        anypick: pickU('anypick'),
        others: P.front.filter(u => u !== s),
        /* the Unit that set off the trigger (attacker of aattack / oattack, the Unit of enter / block ...), only while it is still on the board */
        trigger: G.evSrc && [...P.front, ...O.front, ...P.vault, ...O.vault].includes(G.evSrc) ? [G.evSrc] : []
    }[tg] || (tgSpec(tg) ? (/^ehas:/.test(tg) ? O.front : P.front).filter(u => cardMatch(u, tgSpec(tg))) : []);
}

/* X abilities: the biggest X that can be paid right now (0 = cannot be paid at all) */
function xMax(p, s, a) {
    const v = costOf(a).map(f => parseVar(f[1])).find(v => v && v.key == 'x');
    if (!v)
        return 0;
    const top = +v.arg > 0 ? Math.floor(+v.arg) : 99
      , old = G.xv;
    let m = 0;
    try {
        for (let k = 1; k <= top; k++) {
            G.xv = k;
            if (!costsOK(p, s, costOf(a)))
                break;
            m = k
        }
    } finally {
        G.xv = old
    }
    return m
}

/* a copy of the ability with X worked out: every x in the cost and in the effects becomes a plain number (so it also survives effects that wait for a choice) */
function xBind(p, s, a, X) {
    const old = G.xv;
    G.xv = X;
    try {
        const sub = f => !Array.isArray(f) ? f : f[0] == 'choose' ? chooseOf((f[1] || []).map(alt => normFx(alt).map(sub)), Array.isArray(f[2]) ? f[2].map(sub) : null, Array.isArray(f[3]) ? f[3].map(sub) : null) : isXv(f[1]) ? [f[0], numOf(p, s, f[1]), ...f.slice(2)] : f;
        return {
            ...a,
            cost: costOf(a).map(sub),
            fx: normFx(a.fx || []).map(sub),
            xv: X
        }
    } finally {
        G.xv = old
    }
}

/* every way the computer could pay an ability: [[ability, X], ...]  (a normal ability is just [[ability, null]]) */
function xVariants(p, s, a) {
    if (!hasX(a))
        return [[a, null]];
    const m = Math.min(xMax(p, s, a), 12)
      , out = [];
    for (let k = 1; k <= m; k++)
        out.push([xBind(p, s, a, k), k]);
    return out
}

/* TACTICAL X: a Tactical whose flash fx use the variable x lets the player choose X when casting it.
   Largest X = the cap of x:N (if written), limited by the most counters of the named counter that an uncounter-with-x effect could remove
   from one Unit it can reach (a pick target: any Unit you could choose). Without any limit the checker warns and X is at most 10. */
const tacX = c => !!c && c.t == 'T' && xUses(normFx(c.fx || []));

/* an uncounter with x on several Units (allies, others, 'has:..' ...) removes X counters IN TOTAL from those Units (the Unit with the most counters first) */
const xTot = f => Array.isArray(f) && f[0] == 'uncounter' && isXv(f[1]) && !PICKS.includes(f[2]) && f[2] != 'self';

function xMaxT(p, c) {
    const fl = normFx(c.fx || []).filter(f => Array.isArray(f) && isXv(f[1]));
    let cap = 0
      , lim = null;
    fl.forEach(f => {
        const v = parseVar(f[1]);
        if (v && +v.arg > 0)
            cap = cap ? Math.min(cap, Math.floor(+v.arg)) : Math.floor(+v.arg);
        if (f[0] == 'uncounter') {
            const us = PICKS.includes(f[2]) ? pickList(p, f[2]) : tgUnits(p, c, f[2], () => []);
            const m = xTot(f) ? us.reduce( (t, u) => t + ctrN(u, f[3]), 0) : us.reduce( (t, u) => Math.max(t, ctrN(u, f[3])), 0);
            lim = lim == null ? m : Math.max(lim, m)
        }
    }
    );
    const top = Math.min(cap || 99, lim == null ? 10 : lim);
    return Math.max(1, top)
}

function activate(p, s, i, picks, xv) {
    let a = acts(s)[i];
    if (!a || !canAct(p, s, a))
        return false;
    const aIx = (s.ab || []).indexOf(a);
    let X = 0;
    if (hasX(a)) {
        /* the chosen X, never more than can be paid and never less than 1 */
        X = Math.min(xMax(p, s, a), Math.max(1, Math.floor(+xv) || 1));
        if (X < 1)
            return false;
        a = xBind(p, s, a, X)
    }
    mlSrc(s.n + ' (ability)');
    mlC(p, 'activated', s.n);
    mlog(`ACTIVATE ${G.p[p].name}: ${s.n} ability #${i + 1}` + (X ? ` (X = ${X})` : ''));
    /* the cost is made of ordinary effects: they run first (canAct already checked that all of them can be done), then the fx */
    G.dpk = picks ? [...picks] : null;
    try {
        costOf(a).forEach(f => fx(p, s, f))
    } finally {
        G.dpk = null
    }
    if (a.max > 0)
        (s.tu = s.tu || {})[aIx] = ((s.tu || {})[aIx] || 0) + 1;
    s.trig = 1;
    say(selfN(s, `${IC.bolt} ${s.n} — ${cap(costT(a) || 'activate')}: ${fxJ(a.fx)}`));
    cue(s, p, 'act');
    s.rm = 0;
    a.fx.forEach(f => fx(p, s, f));
    /* 'aact' = your OTHER cards, 'oaact' = the opponent's cards: "Whenever you activate another card's ability" (the activated card itself never reacts) */
    emit('aact', p, s);
    sweep();
    return true
}

function emit(name, q, src, amt) {
    if (!G.started || G.over || (G.evd || 0) >= 3)
        return;
    G.evd = (G.evd || 0) + 1;
    snd(name, q);
    fire(name, q, src, amt);
    fire('o' + name, 1 - q, src, amt);
    G.evd--;
    /* an effect fired by this event may have changed Unit states (Rest / Standby / Prepare): report those now */
    if (!G.evd && !G.wd)
        watch()
}

/* Lume and Life changes are detected by comparing with the last known values (called at the end of sweep) */
function watch() {
    if (!G.started)
        return;
    const ev = [];
    /* Unit state changes (Prepare / Standby / Rest): a Unit entering play counts as set to its first state */
    const SN = {
        P: 'prepare',
        S: 'standby',
        R: 'rest'
    };
    (G.stq || []).forEach( ([u,from,to]) => {
        const i = ownerIdx(u);
        if (i < 0)
            return;
        if (u.ps === undefined && from)
            ev.push([SN[from], i, u]);
        ev.push([SN[to], i, u]);
        u.ps = to
    }
    );
    G.stq = [];
    G.p.forEach( (P, i) => P.front.forEach(u => {
        if (u.ps !== u.st) {
            u.ps = u.st;
            ev.push([{
                P: 'prepare',
                S: 'standby',
                R: 'rest'
            }[u.st], i, u])
        }
    }
    ));
    /* every Life / Lume change since the last check, in the order it happened */
    (G.lq || []).forEach(e => ev.push(e));
    G.lq = [];
    if (!ev.length || (G.wd || 0) >= 4)
        return;
    const n0 = G.nf || 0;
    G.wd = (G.wd || 0) + 1;
    ev.forEach( ([t,i,u,by,amt]) => {
        if (!t)
            return;
        const pb = G.evBy
          , pa = G.evAmt;
        G.evBy = by;
        emit(t, i, u, amt);
        G.evBy = pb
    }
    );
    if ((G.nf || 0) != n0)
        sweep();
    G.wd--
}

/* ['choose', alts]: the player picks ONE alternative (a choice window), the computer picks the better one.
   An alternative that could do nothing right now is not offered; with only one left it is used at once. */
function chooseFx(p, s, f) {
    const alts = f[1] || []
      , run = k => {
        const saved = G.chc;
        G.chc = null;
        try {
            (alts[k] || []).forEach(g => fx(p, s, g));
            /* 'then' effects: after the chosen side, whichever it was */
            (Array.isArray(f[2]) ? f[2] : []).forEach(g => fx(p, s, g))
        } finally {
            G.chc = saved
        }
    }
    ;
    if (G.chc != null)
        return run(G.chc);
    const ok = alts.map( (_, k) => k).filter(k => meetsTrigger(p, {
        t: 'T',
        fx: alts[k]
    }));
    if (!ok.length)
        return;
    /* the cost part (the effects written before the word 'choose') is paid first, once, only now that a side can be done */
    (Array.isArray(f[3]) ? f[3] : []).forEach(g => fx(p, s, g));
    if (ok.length == 1)
        return run(ok[0]);
    if (isAI(p)) {
        const v = k => {
            try {
                return axEvalFx(p,alts[k],s,{})
            } catch (e) {
                return 0
            }
        }
        ;
        return run(ok.sort( (a, b) => v(b) - v(a))[0])
    }
    (G.pq = G.pq || []).push([p, s, f])
}

function fx(p, s, f) {
    if (f[0] == 'choose')
        return chooseFx(p, s, f);
    const [ty,n0,tg] = f /* amount 'removed' = how many counters the uncounter effect of this same ability just removed */
      , n = numOf(p, s, n0)
      , P = G.p[p]
      , O = G.p[1 - p]
      , pickU = t => G.ptgs ? G.ptgs.filter(u => pickList(p, t).includes(u)) : G.ptg && pickList(p, t).includes(G.ptg) ? [G.ptg] : [];
    /* ['return', n, pick-target] with n > 1: choose up to n DIFFERENT Units */
    if ((ty == 'return' || ty == 'raze' || ty == 'destroy') && n > 1 && PICKS.includes(tg) && !G.ptg && !G.ptgs) {
        const L = pickList(p, tg);
        if (!L.length)
            return;
        if (isAI(p) || L.length <= n) {
            G.ptgs = isAI(p) ? aiPickList(p, tg, ty, n, f[3]).slice(0, n) : [...L];
            try {
                return fx(p, s, f)
            } finally {
                G.ptgs = null
            }
        }
        (G.pq = G.pq || []).push([p, s, f]);
        return
    }
    /* a pick target with no target chosen yet (a Unit / Relic ability): the AI and single-choice cases resolve at once,
       the player is asked after the current action (see render) */
    if (PICKS.includes(tg) && !G.ptg && !G.ptgs) {
        const L = pickList(p, tg);
        if (!L.length)
            return;
        if (isAI(p) || L.length == 1) {
            G.ptg = isAI(p) ? aiPickT(p, tg, ty, n, f[3]) : L[0];
            try {
                return fx(p, s, f)
            } finally {
                G.ptg = null
            }
        }
        (G.pq = G.pq || []).push([p, s, f]);
        return
    }
    /* ['grant', n, 'hand', 'drawdown']: every Unit in the hand of the player gets Drawdown n (it does not stack: the bigger number counts) */
    const HD = ty == 'disable' ? handTg(tg) : null;
    if (HD) {
        const dk = String(f[3] || '');
        if (dk == 'all' || KWS[dk])
            handSides(p, HD).forEach(w => {
                disableHand(w, p, dk, f[4], HD.ty);
                /* a window (until end of turn / the giver's next turn) also covers cards that reach the hand later, e.g. the next draw */
                if (f[4] == 'turn' || f[4] == 'next')
                    (G.haur = G.haur || []).push({w, g: p, gk: dk, dur: f[4], ty: HD.ty})
            });
        return
    }
    const HT = ty == 'grant' ? handTg(tg) : null;
    if (HT) {
        const gk = String(f[3] || '');
        if (KWS[gk] && !(KWS[gk].x && typeof n0 == 'string' && !(Math.floor(+n) >= 1)))
            handSides(p, HT).forEach(w => grantHand(w, p, gk, gk == 'echo' || gk == 'drawdown' ? (Math.floor(+n) || 1) : Math.max(1, Math.floor(+n) || 1), f[4], HT.ty));
        return
    }
    const us = tgUnits(p, s, tg, pickU);
    const rs = ty == 'raze' ? [...({
        relics: O.vault,
        myrelics: P.vault,
        allrelics: [...O.vault, ...P.vault],
        self: s.t == 'R' ? [s] : [],
        relic: pickU('relic'),
        myrelic: pickU('myrelic'),
        anyrelic: pickU('anyrelic')
    }[tg] || [])] : [];
    const src = s.t == 'T' ? 'av' + p : s.id
      , CM = {
        dmg: '#ff6a3c',
        heal: '#6dff9a',
        draw: '#6aa8ff',
        lume: '#41d8ff',
        buff: '#ffd37a',
        surge: '#ffb347',
        rest: '#9ad0ff',
        state: '#9ad0ff',
        prune: '#b070ff',
        raze: '#e0884a',
        destroy: '#ff4a3c',
        'return': '#7fe0c0',
        steal: '#41d8ff',
        drain: '#d04aff',
        pay: '#41d8ff',
        retrieve: '#b8a0ff',
        mill: '#9aa0b0',
        look: '#7fd0ff',
        search: '#6aa8ff',
        debt: '#e0b24a',
        adddebt: '#e0b24a',
        shuffle: '#6aa8ff'
    };
    (ty == 'dmg' || ty == 'heal' ? (tg == 'opp' ? ['av' + (1 - p)] : tg == 'me' ? ['av' + p] : us.map(u => u.id)) : (ty == 'buff' || ty == 'surge' || ty == 'rest' || ty == 'state' || ty == 'prune' || ty == 'return' || ty == 'destroy') ? us.map(u => u.id) : ty == 'raze' ? rs.map(r => r.id) : ty == 'draw' ? ['dk' + p] : ty == 'lume' ? ['lu' + p] : ty == 'pay' ? ['lu' + (tg == 'opp' ? 1 - p : tg == 'ctrl' && G.evSrc && ownerIdx(G.evSrc) >= 0 ? ownerIdx(G.evSrc) : p)] : ty == 'drain' ? ['av' + (1 - p), 'av' + p] : ty == 'retrieve' ? [tg == 'logistic' ? 'dk' + p : 'wl' + p] : ty == 'mill' ? ['wl' + (tg == 'opp' ? 1 - p : p)] : ty == 'debt' ? ['av' + (tg == 'opp' ? 1 - p : p)] : ty == 'search' ? ['dk' + p] : ty == 'shuffle' ? ['dk' + (tg == 'opp' ? 1 - p : p)] : []).forEach(t => VQ.push({
        k: 'b',
        a: src,
        b: t,
        col: CM[ty],
        p
    }));
    if (ty == 'steal')
        VQ.push({
            k: 'b',
            a: 'lu' + (1 - p),
            b: 'lu' + p,
            col: CM.steal,
            p
        });
    if (ty == 'dmg') {
        if (tg == 'opp')
            O.life -= n;
        else if (tg == 'me')
            P.life -= n;
        else
            us.forEach(u => u.dmg += n)
    } else if (ty == 'heal') {
        if (tg == 'me')
            P.life += n;
        else
            us.forEach(u => u.dmg = Math.max(0, u.dmg - n))
    } else if (ty == 'draw')
        draw(p, n);
    else if (ty == 'lume')
        P.lume = Math.max(0, P.lume + n);
    else if (ty == 'buff')
        us.forEach(u => u.ba += n);
    else if (ty == 'hp')
        us.forEach(u => u.bh = (u.bh || 0) + n);
    else if (ty == 'grant') {
        /* ['grant', 'allies', 'swift'] permanent (long form ['grant', n, target, 'keyword'], n = the keyword's number, ignored if it has none)   |   [..., 'turn'] until end of turn   |   [..., 'next'] until your next turn (cleared at your Extraction) */
        const gk = String(f[3] || '');
        if (KWS[gk] && gk != 'echo')
            us.forEach(u => {
                if (u.t != 'U')
                    return;
                if (f[4] == 'turn') {
                    if (!hk(u, gk))
                        u.kt = [...(u.kt || []), gk]
                } else if (f[4] == 'next') {
                    /* until the start (Extraction) of the granting player's next turn: stored as [keyword, owner] */
                    if (!(u.ks || []).includes(gk) && !(u.kg || []).includes(gk))
                        u.kx = [...(u.kx || []), [gk, p]]
                } else if (!(u.ks || []).includes(gk) && !(u.kg || []).includes(gk))
                    u.kg = [...(u.kg || []), gk];
                /* a keyword with a number keeps the granted number (read by kwBox / the pills; a keyword without a number ignores n) */
                if (KWS[gk].x && +n >= 1)
                    u.kgn = {...(u.kgn || {}), [gk]: ((u.kgn || {})[gk] || 0) + Math.floor(+n)};
                /* Swift on a Unit that is still in Prepare makes it ready at once */
                if (gk == 'swift' && u.st == 'P')
                    setSt(u, 'S')
            }
            );
    } else if (ty == 'disable') {
        const dk = String(f[3] || '');
        if (dk == 'all' || KWS[dk]) {
            us.forEach(u => {
                if (hasKwOn(u, dk))
                    disableOn(u, dk, f[4], p)
            }
            );
            /* 'enemies' with a window: Units that enter the enemy side later are disabled too */
            if (tg == 'enemies' && (f[4] == 'turn' || f[4] == 'next'))
                (G.haur = G.haur || []).push({w: 1 - p, g: p, gk: dk, dur: f[4], units: 1})
        }
    } else if (ty == 'counter' || ty == 'uncounter') {
        const key = cn(f[3])
          , hit = [];
        let total = 0;
        /* 'total' (a Tactical with x): remove n counters in all from these Units, the Unit with the most counters first */
        const alloc = ty == 'uncounter' && f[4] == 'total' && n != 'all' ? new Map() : null;
        if (alloc && key) {
            let left = Math.floor(+n) || 0;
            [...us].sort( (a, b) => ((b.ctr || {})[key] || 0) - ((a.ctr || {})[key] || 0)).forEach(u => {
                const k = Math.min(((u.ctr || {})[key] || 0), left);
                if (k > 0) {
                    alloc.set(u, k);
                    left -= k
                }
            }
            )
        }
        if (key)
            us.forEach(u => {
                u.ctr = u.ctr || {};
                const have = u.ctr[key] || 0;
                if (ty == 'counter') {
                    const k = Math.floor(+n) || 0;
                    if (k > 0) {
                        u.ctr[key] = have + k;
                        hit.push(u)
                    }
                } else {
                    const k = alloc ? alloc.get(u) || 0 : n == 'all' ? have : Math.min(have, Math.floor(+n) || 0);
                    if (k > 0) {
                        total += k;
                        u.ctr[key] = have - k;
                        if (!u.ctr[key])
                            delete u.ctr[key]
                    }
                }
            }
            );
        if (ty == 'uncounter')
            s.rm = total;
        hit.forEach(u => {
            /* a counter put on a Unit OR a Relic, of either player, tells the 'counter' / 'ocounter' triggers */
            const o = ownerAny(u);
            if (o >= 0) {
                G.evCtr = key;
                emit('counter', o, u);
                G.evCtr = null
            }
        }
        )
    } else if (ty == 'summon') {
        const s = tokSpec(n)
          , k = mk({
            n: s.name,
            t: 'U',
            c: 0,
            a: s.atk,
            h: s.hp,
            tok: 1,
            fa: s.faction || 'none',
            sb: s.sub,
            fv: '',
            ...(s.keyword.length ? {
                k: s.keyword[0][0],
                kw: s.keyword,
                ks: s.keyword.map(x => x[0]),
                ...(kwNum(s.keyword, 'echo') ? {
                    e: kwNum(s.keyword, 'echo')
                } : {})
            } : {}),
            ...(s.abilities.length ? {
                ab: clone(s.abilities),
                ...(abFx(s.abilities, 'passive').length ? {
                    fx: clone(abFx(s.abilities, 'passive'))
                } : {})
            } : {})
        });
        k.st = hk(k, 'swift') ? 'S' : 'P';
        P.front.push(k);
        fire('play', p, k);
        emit('enter', p, k)
    } else if (ty == 'drain') {
        O.life -= n;
        P.life += n
    } else if (ty == 'pay') {
        /* ['pay', n] / ['pay', n, 'me'] = YOUR Echo Debt goes down by n; 'opp' = the opponent's; 'ctrl' = the controller of the Unit that set off the trigger (G.evSrc) */
        const ci = tg == 'ctrl' ? (G.evSrc ? ownerIdx(G.evSrc) : -1) : -1
          , T = tg == 'ctrl' ? G.p[ci] : tg == 'opp' ? O : P
          , k = T ? Math.min(T.debt, Math.max(0, n)) : 0;
        if (T) {
            T.debt = Math.max(0, T.debt - n);
            if (k && T !== P)
                say(`${T.name} pays off ${k} Echo Debt (Debt ${T.debt})`)
        }
    } else if (ty == 'surge')
        us.forEach(u => u.tb = (u.tb || 0) + n);
    else if (ty == 'rest')
        us.forEach(u => setSt(u, 'R'));
    else if (ty == 'recur') {
        for (let i = 0; i < n; i++) {
            const w = P.waste.filter(x => x.t == 'U').sort( (a, b) => b.c - a.c)[0];
            if (!w)
                break;
            P.waste = P.waste.filter(x => x !== w);
            w.dmg = 0;
            w.ba = 0;
            w.bh = 0;
            w.ctr = {};
            w.tb = 0;
            w.kg = [];
            w.kt = [];
            w.kx = [];
            w.kd = [];
            w.kdt = [];
            w.kdx = [];
            P.hand.push(w);
            say(`${P.name} returns ${w.n} from the Wasteland`)
        }
    } else if (ty == 'destroy') {
        /* lethal damage: the sweep that follows sends the Unit(s) to the Wasteland and fires "When destroyed" / "Whenever your Unit is destroyed" */
        us.forEach(u => {
            if (u.dmg < HPv(u))
                u.dmg = HPv(u)
        }
        )
    } else if (ty == 'retrieve') {
        /* the most recently discarded n cards, newest first */
        const got = P.waste.splice(Math.max(0, P.waste.length - n)).reverse();
        got.forEach(c => {
            c.dmg = 0;
            c.ba = 0;
            c.bh = 0;
            c.ctr = {};
            c.tb = 0;
            c.kg = [];
            c.kt = [];
            c.kx = [];
            c.kd = [];
            c.kdt = [];
            c.kdx = []
        }
        );
        if (tg == 'logistic')
            P.deck.unshift(...got);
        else if (tg == 'shuffle') {
            P.deck.push(...got);
            sh(P.deck)
        } else
            P.hand.push(...got);
        if (got.length)
            say(`${P.name} ${tg == 'shuffle' ? 'sends' : 'returns'} ${got.length} card${got.length > 1 ? 's' : ''} from the Wasteland ${tg == 'shuffle' ? 'to the Logistic and shuffles it' : tg == 'logistic' ? 'to the top of the Logistic' : 'to the hand'}`);
        if (tg == 'logistic' || tg == 'shuffle')
            relogEvent(p, got.length)
    } else if (ty == 'mill') {
        millDeck(tg == 'opp' ? 1 - p : p, n)
    } else if (ty == 'discard') {
        discardCards(p, n)
    } else if (ty == 'look') {
        lookTop(p, s, f)
    } else if (ty == 'search') {
        searchDeck(p, s, f)
    } else if (ty == 'shuffle') {
        const T = tg == 'opp' ? O : P;
        sh(T.deck);
        say(`${T.name}'s Logistic is shuffled`)
    } else if (ty == 'adddebt') {
        /* ['adddebt', n, 'me' | 'opp']: NEW Echo Debt is created (nothing moves between the players) */
        /* 'ctrl' = whoever controls the Unit that set off the trigger (G.evSrc, set by fire):
           "Whenever a Unit enters, its controller takes n Echo Debt" works for your Units and the enemy's */
        const ci = tg == 'ctrl' ? (G.evSrc ? ownerIdx(G.evSrc) : -1) : -1
          , T = tg == 'ctrl' ? G.p[ci] : tg == 'opp' ? O : P
          , k0 = Math.max(0, Math.floor(n) || 0)
          , k = T ? Math.min(k0, debtRoom(T)) : 0;
        if (T && k < k0)
            ftNote(T);
        if (k && T) {
            T.debt += k;
            say(`${T.name} takes ${k} Echo Debt (Debt ${T.debt})`)
        }
    } else if (ty == 'debt' && tg == 'me') {
        P.debt += n
    } else if (ty == 'debt') {
        const from = tg == 'opp' ? P : O
          , to = tg == 'opp' ? O : P
          , m0 = Math.min(n, from.debt)
          , m = Math.min(m0, debtRoom(to));
        if (m < m0)
            ftNote(to);
        from.debt -= m;
        to.debt += m;
        if (m)
            say(`${m} Echo Debt moves to ${to.name}`)
    } else if (ty == 'steal') {
        const m = Math.min(n, O.lume);
        if (m > 0) {
            O.lume -= m;
            P.lume += m;
            say(`${P.name} steals ${m} Lume from ${O.name}`)
        }
    } else if (ty == 'state')
        us.forEach(u => setSt(u, n == 'standby' ? 'S' : n == 'prepare' ? 'P' : 'R'));
    else if (ty == 'return') {
        /* back to the owner's hand as a fresh card (damage, counters and bonuses are lost); a token simply disappears */
        const gone = [];
        us.forEach(u => {
            const i = ownerIdx(u);
            if (i < 0)
                return;
            const Q = G.p[i];
            Q.front = Q.front.filter(x => x !== u);
            u.dmg = 0;
            u.ba = 0;
            u.bh = 0;
            u.ctr = {};
            u.tb = 0;
            u.kg = [];
            u.kt = [];
            u.kx = [];
            u.kd = [];
            u.kdt = [];
            u.kdx = [];
            u.ps = undefined;
            u.tu = null;
            G.sel = G.sel.filter(id => id != u.id);
            G.atkNow && G.atkNow.delete(u.id);
            gone.push([i, u]);
            if (u.tok)
                return say(`${u.n} vanishes`);
            u.bn = (u.bn || 0) + 1;
            Q.hand.push(u);
            say(`${u.n} returns to ${Q.name}'s hand`)
        }
        );
        /* "When your Unit is returned" (its owner's cards) / "When an enemy Unit is returned" (the other player's cards) */
        gone.forEach( ([i,u]) => emit('return', i, u))
    } else if (ty == 'raze') {
        /* Relic leaves the Vault for the Wasteland; its own "When destroyed" ability still fires */
        rs.forEach(r => {
            const i = G.p.findIndex(Q => Q.vault.includes(r));
            if (i < 0)
                return;
            const Q = G.p[i];
            Q.vault = Q.vault.filter(x => x !== r);
            r.tu = null;
            if (G.selu == r.id)
                G.selu = null;
            if (!r.tok)
                Q.waste.push(r);
            say(`${r.n} is destroyed`);
            fire('death', i, r)
        }
        )
    } else if (ty == 'prune') {
        /* removed from play: no Wasteland, no "destroyed" triggers (the card goes to The Void) */
        us.forEach(u => G.p.forEach(Q => {
            if (!Q.front.includes(u))
                return;
            Q.front = Q.front.filter(x => x !== u);
            u.dmg = 0;
            u.ba = 0;
            u.bh = 0;
            u.ctr = {};
            u.tb = 0;
            u.kg = [];
            u.kt = [];
            u.kx = [];
            u.kd = [];
            u.kdt = [];
            u.kdx = [];
            u.pruned = 1;
            (Q.void = Q.void || []).push(u);
            G.sel = G.sel.filter(i => i != u.id);
            say(`${u.n} is pruned`)
        }
        ))
    } else if (ty == 'peek') {
        if (p == 0)
            say(`Opponent hand: ${O.hand.map(c => c.n).join(', ') || 'empty'}`)
    }
}

/* DISABLE WINDOWS (G.haur): cards that reach a hand / the enemy board while the window is open get the same disable */
function haurSync() {
    (G.haur || []).forEach(e => {
        if (e.units)
            [...G.p[e.w].front, ...G.p[e.w].vault].forEach(u => {
                if (hasKwOn(u, e.gk))
                    disableOn(u, e.gk, e.dur, e.g)
            }
            );
        else
            disableHand(e.w, e.g, e.gk, e.dur, e.ty)
    }
    )
}

function sweep() {
    haurSync();
    for (let k = 0; k < 6; k++) {
        let d = [];
        G.p.forEach( (P, i) => {
            P.front = P.front.filter(u => {
                if (u.dmg >= HPv(u)) {
                    d.push([i, u]);
                    return 0
                }
                return 1
            }
            )
        }
        );
        if (!d.length)
            break;
        d.forEach( ([i,u]) => {
            mlC(i, 'destroyed', u.n);
            u.dmg = 0;
            u.ba = 0;
            u.bh = 0;
            u.ctr = {};
            u.tb = 0;
            u.kg = [];
            u.kt = [];
            u.kx = [];
            u.kd = [];
            u.kdt = [];
            u.kdx = [];
            if (!u.tok)
                G.p[i].waste.push(u);
            say(`${u.n} is destroyed`);
            snd('unitDestroyed', i);
            fire('death', i, u);
            fire('ally', i, u)
        }
        )
    }
    watch();
    check()
}

/* ---- turn flow ---- */
function start(p) {
    G.act = p;
    G.lock = 0;
    G.ph = 'main';
    G.turn++;
    snd('turnStart', p);
    mlSrc('turn income');
    const P = G.p[p];
    P.front.forEach(u => {
        if (statBonus(p, u, 'hold') > 0)
            say(`${u.n} does not wake`);
        else
            setSt(u, 'S')
    }
    );
    G.p.forEach(Q => [...Q.front, ...Q.vault].forEach(u => u.tu = null));
    /* 'next' grants end now: at the Extraction of the player who gave them */
    G.haur = (G.haur || []).filter(e => !(e.dur == 'next' && e.g == p));
    G.p.forEach(Q => [...Q.front, ...Q.vault, ...Q.hand].forEach(u => {
        if (u.kx)
            u.kx = u.kx.filter(x => x[1] != p);
        if (u.kdx)
            u.kdx = u.kdx.filter(x => x[1] != p)
    }
    ));
    /* the +1 Lume of each turn only fills up to the STARTING CAP of 10; Lume above it comes from effects and has no cap */
    /* the +1 income is PROTECTED: Payday cannot take it, so a player in debt can always play at least one card */
    const inc1 = P.lume < 10 ? 1 : 0;
    P.lume += inc1;
    watch();
    mlSrc('game');
    draw(p, 1);
    fire('extract', p);
    /* PAYDAY comes AFTER the +1 Lume income and the Extraction effects: the whole Echo Debt = the Life lost (ECHO_PAYS_LIFE; the old rule: Echo Debt minus the Lume in the reservoir) */
    /* FIRST-TURN PAYDAY PROTECTION: a player's very first turn has no Payday, so both players can play their cards with all their Lume.
       The Echo Debt is not forgiven, it waits for the next Payday. */
    const firstTurn = !P.hadTurn;
    P.hadTurn = 1;
    if (!firstTurn && !P.debt)
        P.pd = (P.pd || 0) + 1;
    if (P.debt && firstTurn) {
        mlC(p, 'payday', 'skipped (first turn)');
        say(`${P.name} is protected on the first turn: no Payday, ${P.debt} Echo Debt waits for the next one`)
    } else if (P.debt) {
        P.pd = (P.pd || 0) + 1;
        mlSrc('Payday');
        /* ECHO_PAYS_LIFE: the whole Echo Debt is Life lost, the Lume is not touched. Old rule: the Lume in the reservoir (without this turn's protected +1 income)
           pays the debt first (1 Lume = 1 Echo Debt); every Echo Debt it cannot pay costs 1 Life */
        const paid = ECHO_PAYS_LIFE ? 0 : Math.min(Math.max(0, P.lume - inc1), P.debt), owed = P.debt - paid;
        mlC(p, 'payday', ECHO_PAYS_LIFE ? 'lost Life' : owed <= 0 ? 'paid in Lume' : paid > 0 ? 'part paid in Lume, rest lost Life' : 'unpaid (lost Life)');
        P.lume -= paid;
        if (owed <= 0)
            say(`Payday: ${P.name} pays ${P.debt} Echo Debt`);
        else {
            P.life -= owed;
            say(ECHO_PAYS_LIFE ? `Payday! ${P.name} loses ${owed} Life to Echo Debt` : paid > 0 ? `Payday! ${P.name} pays ${paid} Echo Debt with Lume and loses ${owed} Life to the rest` : `Payday! ${P.name} cannot pay and loses ${owed} Life to Echo Debt`)
        }
        P.debt = 0
    }
    sweep();
    mlState(`TURN ${G.turn}: ${P.name} (${SPEC ? 'SEAT ' + (p + 1) : p ? 'AI' : 'YOU'}) starts`);
    render();
    flash(SPEC ? `${P.name}'s Turn` : p ? "Opponent's Turn" : 'Your Turn');
    if (isAI(p) && !G.over)
        aiLater( () => ai(), 2300)
}

function play(p, c, tg, xv) {
    const P = G.p[p];
    mlSrc(c.n + ' (cost)');
    mlC(p, 'played', c.n);
    mlog(`PLAY ${P.name}: ${c.n} (${c.t}, cost ${mlCost(c)}, lume ${P.lume}, debt ${P.debt || 0})` + (tg != null && tg !== 0 ? ` target ${[].concat(tg).map(i => byId[i] ? byId[i].n : i).join(', ')}` : ''));
    cue(c, p, 'play');
    let echo = 0
      , eamt = 0;
    /* a card played by borrowing Lume (Echo): its own 'echo' ability, 'aecho' = my OTHER cards, 'oaecho' = the opponent's cards */
    const echoed = () => {
        if (!echo)
            return;
        /* delta = the Echo Debt this play took */
        fire('echo', p, c, eamt);
        fire('aecho', p, c, eamt);
        fire('oaecho', 1 - p, c, eamt)
    }
    ;
    /* the Lume cost already has the Echo taken off (printed cost - echo); the Echo value becomes Echo Debt.
       The debt can never be more than the printed cost. */
    P.lume = Math.max(0, P.lume - c.c);
    if (c.e) {
        const d = Math.min(c.e, c.c0 == null ? c.c : c.c0);
        P.debt += d;
        echo = 1;
        eamt = d;
        say(`${P.name} takes ${d} Echo Debt (Debt ${P.debt})`)
    }
    P.hand = P.hand.filter(x => x !== c);
    say(`${P.name} plays ${c.n}`);
    snd([c.t == 'U' ? 'playUnit' : c.t == 'R' ? 'playRelic' : 'playTactic', 'playCard'], p);
    if (c.t == 'U') {
        c.st = hk(c, 'swift') ? 'S' : 'P';
        c.ps = undefined;
        c.dmg = 0;
        P.front.push(c);
        fire('play', p, c);
        echoed();
        emit('enter', p, c)
    } else if (c.t == 'R') {
        P.vault.push(c);
        fire('play', p, c);
        echoed()
    } else {
        VQ.push({
            k: 'c',
            c,
            p
        });
        G.ptg = Array.isArray(tg) ? null : tg;
        G.ptgs = Array.isArray(tg) ? tg : null;
        c.rm = 0;
        /* a Tactical with x: the human chose X on the X bar, the computer takes the biggest X */
        let fxs = c.fx;
        if (tacX(c)) {
            const X = Math.min(xMaxT(p, c), Math.max(1, Math.floor(+xv) || (isAI(p) ? 99 : 1)));
            fxs = xBind(p, c, {
                cost: [],
                fx: normFx(c.fx).map(f => xTot(f) ? [f[0], f[1], f[2], f[3], 'total'] : f)
            }, X).fx;
            say(`${c.n}: X = ${X}`)
        }
        fxs.forEach(f => fx(p, c, f));
        G.ptg = null;
        G.ptgs = null;
        P.waste.push(c);
        emit('cast', p, c);
        echoed()
    }
    /* ANY card played (Unit / Relic / Tactical): 'anyplay' = my OTHER cards, 'oanyplay' = the opponent's cards */
    emit('anyplay', p, c);
    sweep()
}

function declare(a, at) {
    G.combat = 1;
    mlSrc('combat');
    at.forEach(u => mlC(a, 'attacked', u.n));
    mlog(`ATTACK ${G.p[a].name} declares: ${at.map(u => mlU(a, u)).join(' | ')}`);
    snd('attack', a);
    at.forEach(u => {
        G.atkNow.add(u.id);
        if (!hk(u, 'tireless'))
            setSt(u, 'R');
        fire('attack', a, u);
        /* the same attack seen by the OTHER cards: aattack = your other Units / Relics, oattack = the opponent's cards (G.evSrc = this attacker, target 'trigger') */
        fire('aattack', a, u);
        fire('oattack', 1 - a, u)
    }
    );
    sweep()
}

function resolve(a, at, pr) {
    const d = 1 - a
      , clash = [];
    /* DEFEND triggers: every Unit that was declared as a blocker, whether it survives this combat or not. Each blocker fires once, BEFORE any damage,
       so the effect can still change the fight (G.evSrc = the blocker, target 'trigger'):  defend = that blocker itself, adefend = the defender's
       other Units / Relics, odefend = the attacker's cards (an ENEMY Unit blocks). */
    const blk = [];
    at.forEach(u => (pr[u.id] || []).forEach(i => {
        const df = byId[i];
        if (df && !blk.includes(df) && G.p[d].front.includes(df))
            blk.push(df)
    }
    ));
    if (blk.length) {
        blk.forEach(df => {
            if (!G.p[d].front.includes(df))
                return;
            fire('defend', d, df);
            fire('adefend', d, df);
            fire('odefend', a, df)
        }
        );
        sweep()
    }
    at.forEach(u => {
        if (u.pruned || (u.dmg >= HPv(u) && !G.p[a].front.includes(u)))
            return;
        const dfs = (pr[u.id] || []).map(i => byId[i])
          , live = dfs.filter(df => G.p[d].front.includes(df));
        if (dfs.length && !live.length) {
            if (hk(u, 'stomp')) {
                /* its blockers are gone: Stomp still hits the opponent */
                const x = A(a, u);
                G.p[d].life -= x;
                if (hk(u, 'lifesteal'))
                    fx(a, u, ['heal', x, 'me']);
                say(`${u.n} stomps through and hits ${G.p[d].name} for ${x}`)
            } else
                say(`${u.n} is blocked`);
            return
        }
        if (live.length) {
            live.forEach(df => clash.includes(df) || clash.push(df));
            const x = A(a, u)
              , ys = live.map(df => A(d, df)) /* EVASION: a Unit with it ignores the combat damage (Toxic included) of the Unit(s) it is paired with */
              , evU = hk(u, 'evasion')
              , hit = live.filter(df => !hk(df, 'evasion'));
            let left = x;
            if (hk(u, 'toxic'))
                hit.forEach(df => df.dmg = Math.max(df.dmg, HPv(df)));
            else
                hit.forEach( (df, i) => {
                    /* lethal damage to each blocker in the order they were chosen; the rest goes to the last one */
                    const give = i == hit.length - 1 ? left : Math.min(left, Math.max(0, HPv(df) - df.dmg));
                    df.dmg += give;
                    left -= give
                }
                );
            if (!evU) {
                u.dmg += ys.reduce( (t, y) => t + y, 0);
                /* Toxic works on defence too: a toxic blocker destroys the attacker it is paired with */
                if (live.some(df => hk(df, 'toxic')))
                    u.dmg = Math.max(u.dmg, HPv(u))
            }
            /* Lifesteal only heals for damage that was not ignored */
            if (hk(u, 'lifesteal') && hit.length)
                fx(a, u, ['heal', x, 'me']);
            live.forEach( (df, i) => {
                if (hk(df, 'lifesteal') && !evU)
                    fx(d, df, ['heal', ys[i], 'me'])
            }
            );
            say(`${u.n} clashes with ${live.map(df => df.n).join(' + ')}${evU || live.some(df => hk(df, 'evasion')) ? ' (Evasion ignores the damage)' : ''}`);
            /* Stomp: the blocker takes its ATK, then the opponent takes it as well */
            if (hk(u, 'stomp')) {
                G.p[d].life -= x;
                if (hk(u, 'lifesteal'))
                    fx(a, u, ['heal', x, 'me']);
                say(`${u.n} stomps over its blocker and hits ${G.p[d].name} for ${x}`)
            }
        } else {
            const x = A(a, u);
            G.p[d].life -= x;
            if (hk(u, 'lifesteal'))
                fx(a, u, ['heal', x, 'me']);
            say(`${u.n} hits ${G.p[d].name} for ${x}`)
        }
    }
    );
    sweep();
    /* BLOCK triggers: a blocker that fought in this clash and is STILL in play after damage and destruction (it survived).
       'block' = that Unit itself, 'ablock' = your other Units, 'oablock' = the opponent's cards (target 'trigger' = the blocker). Each blocker fires once, even if it blocked a stack. */
    const bl = clash.filter(df => G.p[d].front.includes(df));
    if (bl.length) {
        bl.forEach(df => {
            if (G.p[d].front.includes(df)) {
                fire('block', d, df);
                fire('ablock', d, df);
                fire('oablock', 1 - d, df)
            }
        }
        );
        sweep()
    }
}

/* LUME VICTORY: at the end of your turn you need a goal amount of Lume, three turns IN A ROW:
   1st turn 30 or more, 2nd turn 90 or more, 3rd turn 180 or more. Missing a goal starts again at 30. */
const LUME_GOALS = [30, 90, 180];

function lumeGoal(P) {
    return LUME_GOALS[Math.min(P.ctr || 0, LUME_GOALS.length - 1)]
}

function endT() {
    if (G.over || !G.started)
        return;
    if (G.mode == 'tg' || G.pp || G.lk || G.ch)
        return setTimeout(endT, 500);
    const P = G.p[G.act];
    if (isAI(G.act))
        mlog(`${SPEC ? P.name : 'AI'} ends its turn with ${P.hand.length} card(s) in hand and ${P.lume} Lume unspent` + (P.hand.length ? `: ${P.hand.map(c => `${c.n}(${mlCost(c)})`).join(', ')}` : ''));
    mlSrc('end of turn');
    fire('end', G.act);
    sweep();
    G.haur = (G.haur || []).filter(e => e.dur != 'turn');
    G.p.forEach(Q => Q.front.forEach(u => (u.tb = 0,
    u.kt = [],
    u.kdt = [])));
    G.p.forEach(Q => [...Q.vault, ...Q.hand].forEach(c => {
        if (c.kt && c.kt.length)
            c.kt = [];
        if (c.kdt && c.kdt.length)
            c.kdt = []
    }
    ));
    if (G.over)
        return;
    const goal = lumeGoal(P);
    if (P.lume >= goal) {
        P.ctr++;
        say(`${P.name} has ${P.lume} Lume (goal ${goal}): Lume Victory ${P.ctr}/3` + (P.ctr < 3 ? `, next turn needs ${lumeGoal(P)}` : ''))
    } else {
        if (P.ctr)
            say(`${P.name} missed the goal of ${goal} Lume: the Lume Victory starts again at ${LUME_GOALS[0]}`);
        P.ctr = 0
    }
    check();
    if (!G.over)
        start(1 - G.act)
}

function check() {
    sfxDiff();
    /* while a combat is being resolved (G.combat) nobody wins or loses yet: every attacker strikes and every effect resolves first,
       then combat() calls check() again, so the result (and the match log) shows the FINAL board */
    if (G.over || G.combat)
        return;
    const [a,b] = G.p;
    const end = (res, msg) => {
        snd(res == 'win' ? 'victory' : res == 'loss' ? 'defeat' : 'drawGame');
        if (SPEC && res != 'draw')
            msg = `${(res == 'win' ? a : b).name} wins ` + (/Lume/.test(msg) ? 'by Lume Victory.' : /draw/i.test(msg) ? 'because the other Logistic ran dry.' : 'by Life.');
        G.over = msg;
        G.res = res
    }
    ;
    if (a.life <= 0 && b.life <= 0)
        end('draw', 'Both Sahels fall. Draw.');
    else if (b.life <= 0)
        end('win', 'Victory! Your opponent has fallen.');
    else if (a.life <= 0)
        end('loss', 'Defeat. You have fallen.');
    else if (a.dry && b.dry)
        end('draw', 'Neither player can draw. Draw.');
    else if (b.dry)
        end('win', "Victory! Your opponent cannot draw from an empty Logistic.");
    else if (a.dry)
        end('loss', 'Defeat. You cannot draw from an empty Logistic.');
    else if (a.ctr >= 3)
        end('win', 'Lume Victory! Three turns in a row: 30, 90 and 180 Lume.');
    else if (b.ctr >= 3)
        end('loss', 'Defeat by Lume Victory.');
    if (G.over)
        recordMatch();
    render()
}

/* ---- AI ---- */
/* the AI's second main phase: after combat it may still play cards / use abilities, then the turn ends */
function aiMain2() {
    if (G.over || !G.started)
        return;
    G.ph = 'main2';
    render();
    aiLater( () => ai(1), 700)
}

/* the AI seat ME attacks with `at`. A human defender chooses the blocks on the Defend screen; when the other seat is an AI too (watching), it blocks at once */
function aiLaunch(at) {
    const H = G.p[OP].front.filter(u => u.st != 'R');
    G.ph = 'bat';
    declare(ME, at);
    flash('Attack!');
    if (G.over)
        return;
    if (!H.length)
        return combat(ME, at, {}, aiMain2);
    if (isAI(OP)) {
        aiInstant(OP);
        const live = at.filter(u => G.p[ME].front.includes(u));
        return combat(ME, live, aiDef(live), aiMain2)
    }
    G.mode = 'def';
    G.at = at;
    G.pr = {};
    G.ds = G.da = null;
    render()
}

/* the computer opponent also has instant-speed Tacticals: it may cast one right after you declare attackers */
function aiInstant(seat) {
    return aiSeat(seat == null ? 1 - G.act : seat, aiInstantRun)
}
function aiInstantRun() {
    if (lvOf(ME) == 'axiom')
        return axInstant();
    const P = G.p[ME]
      , H0 = G.p[OP];
    const pl = P.hand.filter(c => c.t == 'T' && P.lume >= c.c && worth(ME, c) && (!pk(c) || pickList(ME, pickOf(c)).length) && (c.fx[0][2] != 'enemies' || H0.front.length > 1) && c.fx[0][0] != 'lume' && !c.fx.some(f => (f[0] == 'dmg' && f[2] == 'me') || f[0] == 'surge') && (!c.fx.some(f => f[0] == 'rest') || H0.front.some(u => u.st != 'R'))).sort( (a, b) => b.c - a.c)[0];
    if (pl && Math.random() < .6) {
        play(ME, pl, pk(pl) ? aiPickC(ME, pl) : 0);
        render()
    }
}

function ai(m2) {
    return aiSeat(G.act, () => aiRun(m2))
}
function aiRun(m2) {
    if (G.over || !G.started)
        return;
    if (G.mode == 'tg' || G.pp || G.lk || G.ch)
        return aiLater( () => ai(m2), 500);
    if (lvOf(ME) == 'axiom')
        return axMain(m2);
    const P = G.p[ME]
      , H0 = G.p[OP];
    const pl = P.hand.filter(c => worth(ME, c) && !(P.lume < c.c && P.debt > 2) && (!pk(c) || pickList(ME, pickOf(c)).length) && ((c.t == 'T' ? c.fx : null)?.[0][2] != 'enemies' || H0.front.length > 1) && ((c.t == 'T' ? c.fx : null)?.[0][0] != 'lume' || P.lume < 12) && (!(c.t == 'T' ? c.fx : null)?.some(f => f[0] == 'dmg' && f[2] == 'me') || P.life > 8) && (!(c.t == 'T' ? c.fx : null)?.some(f => f[0] == 'surge') || P.front.some(u => u.st == 'S')) && (!(c.t == 'T' ? c.fx : null)?.some(f => f[0] == 'rest') || H0.front.some(u => u.st != 'R'))).sort( (a, b) => b.c - a.c)[0];
    if (pl) {
        play(ME, pl, pk(pl) ? aiPickC(ME, pl) : 0);
        render();
        return aiLater( () => ai(m2), 1800)
    }
    /* the AI uses activated abilities that only cost Lume or resting a weak Unit */
    for (const u of [...P.front, ...P.vault])
        for (const [i,a] of acts(u).entries()) {
            const cs = costOf(a);
            if ((cs.length || a.max > 0) && cs.every(c => isRestC(c) || (c[0] == 'lume' && numOf(ME, u, c[1]) < 0)) && (!cs.some(isRestC) || A(ME, u) < 2) && canAct(ME, u, a) && meetsTrigger(ME, {
                t: 'T',
                fx: a.fx
            })) {
                activate(ME, u, i, null, hasX(a) ? xMax(ME, u, a) : 0);
                render();
                return aiLater( () => ai(m2), 1800)
            }
        }
    if (m2)
        return aiLater(endT, 1300);
    const H = H0.front.filter(u => u.st != 'R');
    const at = P.front.filter(u => u.st == 'S' && (!H.length || hk(u, 'evasion') || H.every(d => A(OP, d) < HPv(u) - u.dmg) || P.life > H0.life + 5));
    if (!at.length)
        return aiLater(aiMain2, 1300);
    return aiLaunch(at)
}

function aiDef(at) {
    return aiSeat(1 - G.act, () => aiDefRun(at))
}
function aiDefRun(at) {
    if (lvOf(ME) == 'axiom')
        return axDef(at);
    const used = new Set()
      , pr = {}
      , P = G.p[ME]
      , tot = at.reduce( (s, u) => s + A(OP, u), 0);
    [...at].sort( (a, b) => A(OP, b) - A(OP, a)).forEach(u => {
        const ds = P.front.filter(d => d.st != 'R' && !used.has(d.id));
        const live = ds.filter(d => hk(d, 'evasion') || HPv(d) - d.dmg > A(OP, u))
          , kill = live.filter(d => !hk(u, 'evasion') && A(ME, d) >= HPv(u) - u.dmg);
        const d = kill[0] || live[0] || (P.life - tot < 8 ? ds.sort( (a, b) => a.c - b.c)[0] : 0);
        if (d) {
            pr[u.id] = [d.id];
            used.add(d.id)
        }
    }
    );
    return pr
}


/* ================= AXIOM: the hardest AI =================
   Omnius plays by simple rules. Axiom READS the card effects: every effect (damage, Lume, draw, heal, steal, rest, return, prune,
   summon, sacrifice ...) is given a value for the current board, and every decision uses those values:
     - main phase : plays the card with the best value (engine cards first while Lume is low), avoids self damage at low Life
                    and Echo debt, uses activated abilities when the gain is bigger than the cost
     - attack     : attacks when it is lethal, when nothing can punish it, or when the trade is good; keeps blockers home when in danger
     - defence    : blocks to kill without dying, trades by value, double-blocks a big attacker, chump-blocks to survive lethal
     - instants   : casts a Tactical during your attack when it removes a threat
     - targets    : the right Unit for each effect (kill the biggest threat, heal the hurt, boost the attacker ...)
   Tune the numbers in axFx / axCard to change how it plays. */
const axKw = u => (hk(u, 'toxic') ? 3 : 0) + (hk(u, 'stomp') ? 1.5 : 0) + (hk(u, 'lifesteal') ? 1.5 : 0) + (hk(u, 'tireless') ? 1 : 0) + (hk(u, 'evasion') ? 2.5 : 0) + (hk(u, 'swift') ? .5 : 0);

/* the opponent is close to a Lume Victory (its goal 30 / 90 / 180 Lume, 3 turns in a row): Axiom races, steals Lume and ignores safe trades */
const axRace = p => G.p[1 - p].lume >= lumeGoal(G.p[1 - p]) * .8 || G.p[1 - p].ctr >= 1;

const AX_TM = {
    play: 1,
    death: .7,
    extract: 2.5,
    end: 2.5,
    attack: 1.2,
    aattack: 1,
    oattack: 1.8,
    anyplay: 1.45,
    oanyplay: 1.6,
    aecho: 1.35,
    oaecho: 1.5,
    ally: 1.45,
    enter: 1.5,
    oenter: 1.35,
    oablock: 1,
    defend: 1.2,
    adefend: 1,
    odefend: 1,
    debtup: 1.8,
    odebtup: 1.6,
    debtdown: 1.4,
    odebtdown: 1.8
};

/* LUME ENGINES. A permanent that makes Lume / Units / steals when something happens is an engine. axEng = its worth per turn for owner p.
   The closer its owner is to a Lume Victory, the more it is worth (up to x3), so Axiom kills engines BEFORE the Lume runs away. */
const AX_EV = {
    ally: 2.2,
    death: 1.2,
    enter: 2,
    oenter: 1.2,
    extract: 2.5,
    end: 2.5,
    lumeup: 1,
    act: 2,
    aact: 1.5,
    draw: 1,
    play: .5,
    cast: 1.5,
    discard: 1.5,
    mill: 1.5,
    attack: 1,
    anyplay: 1.5,
    oanyplay: 1.7,
    aecho: 1.35,
    oaecho: 1.5,
    oattack: 1.8,
    counter: 1.2,
    debtup: 2.0,
    odebtup: 1.8,
    debtdown: 1.5,
    odebtdown: 2.0
};

const axEng = (p, u) => (u.ab || []).reduce( (s, a) => {
    if (a.tr == 'passive' || a.tr == 'flash')
        return s;
    const L = (a.fx || []).reduce( (q, f) => q + (f[0] == 'lume' && typeof f[1] == 'number' && f[1] > 0 ? f[1] : f[0] == 'steal' ? 1.5 : f[0] == 'summon' ? 1.2 : f[0] == 'draw' ? .8 : f[0] == 'counter' ? Math.max(1,G.p[p].front.length) * (typeof f[1]=='number' ? f[1] : 1) * .5 : f[0] == 'debt' && f[2] == 'opp' ? (typeof f[1]=='number' ? f[1] : 2) * 1.1 : f[0] == 'adddebt' && f[2] == 'opp' ? (typeof f[1]=='number' ? f[1] : 2) * 1.25 : f[0] == 'adddebt' && f[2] == 'me' ? -(typeof f[1]=='number' ? f[1] : 2) * .8 : 0), 0);
    return s + L * (AX_EV[a.tr] || 1.2) * (a.max == 1 ? .6 : 1)
}
, 0)
  , axThr = p => 1 + 2 * Math.min(1, G.p[p].lume / (lumeGoal(G.p[p]) * .5));

/* Can the opponent destroy my Relics ('raze' that is not aimed at its own Relic) with something I can see: its board, its vault (and its hand when the Logistic is known)?
   A Relic that is about to be destroyed anyway is worth much less to keep than to cash in. */
function axRelicThreat(p) {
    const O = G.p[1 - p]
      , razes = c => [...(c.ab || []), ...(c.fx ? [{
        fx: c.fx
    }] : [])].some(a => (a.fx || []).some(f => Array.isArray(f) && f[0] == 'raze' && f[2] && f[2] != 'self' && f[2] != 'myrelic' && f[2] != 'myrelics'));
    return [...O.front, ...O.vault, ...(AX_KNOWS_DECK ? O.hand : [])].some(razes)
}

/* Lume gained by an ability is worth more when it lets the hand be played THIS turn: every card that is stuck only for lack of Lume and fits into
   (Lume now + n) counts as one more play (cheapest first, at most 3). Before, a pile of Lume was valued as a number and never as the cards it releases,
   so a Relic that sacrifices itself for Lume (Grave Altar) was never cashed in while the hand sat unplayed. */
function axSpendBonus(p, n) {
    const P = G.p[p]
      , stuck = P.hand.filter(c => c.c > P.lume).map(c => c.c).sort( (a, b) => a - b);
    let left = P.lume + n
      , played = 0;
    for (const c of stuck) {
        if (c > left)
            break;
        left -= c;
        played++
    }
    /* EMERGENCY: Lume that pays the Echo Debt of the next Payday (my own pile + what the opponent can push) saves Life 1 for 1 */
    const short = Math.max(0, (P.debt || 0) + axDebtThreat(p, true) - axPayAvail(p, P.lume));
    return Math.min(3, played) * 2.5 + Math.min(n, short) * (short >= P.life ? 3 : P.life < 12 ? 1.6 : 1)
}

/* UNIT SWAP: how many of MY Units die per turn, the thing a "whenever your Unit is destroyed" Relic lives on. It starts from the rating the deck gave itself
   when it read its list (axProfile.swap) and is corrected by this match (the record of Units destroyed).
   A deck that swaps Units fast keeps such a Relic; a deck that hardly loses Units cashes it in. */
function axSwapRate(p) {
    const D = Object.values((MS[p] || {}).destroyed || {}).reduce( (a, b) => a + b, 0)
      , T = Math.max(1, Math.ceil((G.turn || 1) / 2));
    /* the deck's own rating (axProfile: read from the effects of its list) counts as 2 turns of evidence, the Units that really died in this match count turn by turn */
    return (D + axProfile(p).swap * 2) / (T + 2)
}

/* Lume the side gets every time ONE of its Units dies or another enters (death / ally triggers, tokens that enter into an enter trigger): what an attack that is chump-blocked FEEDS it */
function axFeed(side) {
    const P = G.p[side]
      , all = [...P.front, ...P.vault]
      , lm = a => (a.fx || []).reduce( (q, f) => q + (f[0] == 'lume' && typeof f[1] == 'number' && f[1] > 0 ? f[1] : 0), 0);
    const ent = P.front.reduce( (s, u) => s + (u.ab || []).filter(a => a.tr == 'enter').reduce( (q, a) => q + lm(a), 0), 0)
      , dth = P.front.filter(u => u.tok).reduce( (s, u) => s + (u.ab || []).filter(a => a.tr == 'death').reduce( (q, a) => q + lm(a), 0), 0) / Math.max(1, P.front.filter(u => u.tok).length);
    return all.reduce( (s, u) => s + (u.ab || []).filter(a => a.tr == 'ally').reduce( (q, a) => q + lm(a) + (a.fx.some(f => f[0] == 'summon') ? ent + dth + 1 : 0), 0), 0) + dth
}

/* DECK SAFETY: a permanent that draws every time something happens (Life gained, a Unit enters ...) empties the Logistic and the player who
   cannot draw LOSES. axDrawEng = how many such draw triggers p has in play; axDeckUnsafe says whether a card / ability would keep feeding them. */
/* worth of taking n cards out of P's Logistic: good while it is full, bad when it runs short (the player who cannot draw loses), less with a full hand */
const axDraw = (P, n) => n * (P.deck.length > n + 12 ? 1.7 : P.deck.length > n + 6 ? .8 : P.deck.length > n + 3 ? -.5 : -30) * (P.hand.length >= 7 ? .4 : 1);

const axDrawTr = a => a.tr != 'act' && a.tr != 'passive' && a.tr != 'flash' && a.tr != 'play' && (a.fx || []).some(f => f[0] == 'draw');

const axDrawEng = p => [...G.p[p].front, ...G.p[p].vault].reduce( (s, u) => s + (u.ab || []).filter(axDrawTr).length, 0);

function axDeckUnsafe(p, c) {
    const P = G.p[p]
      , n = axDrawEng(p)
      , L = P.deck.length;
    if (L > 12 + 3 * n)
        return false;
    const fxs = [...(c.fx || []), ...(c.ab || []).filter(a => a.tr == 'play' || a.tr == 'enter' || a.tr == 'act').flatMap(a => a.fx || [])];
    /* a Life gain or an entering Unit triggers every draw engine we own */
    if (n && L <= 3 + 3 * n && (c.t == 'U' || fxs.some(f => f[0] == 'heal' && f[2] == 'me' || f[0] == 'summon')))
        return true;
    if (n && L <= 3 + 3 * n && hk(c, 'lifesteal'))
        return true;
    /* a new draw engine when the Logistic is already short */
    return L <= 10 && (c.ab || []).some(axDrawTr)
}

/* Lume per turn that p's permanents make at Extraction / End Turn (a 'pay or gain' choice counts its better side) */
const axIncome = p => [...G.p[p].front, ...G.p[p].vault].reduce( (s, u) => s + (u.ab || []).filter(a => a.tr == 'extract' || a.tr == 'end').reduce( (q, a) => q + (a.fx || []).reduce( (r, f) => r + (f[0] == 'lume' && typeof f[1] == 'number' && f[1] > 0 ? f[1] : f[0] == 'choose' ? Math.max(0, ...(f[1] || []).map(alt => alt.reduce( (t, e) => t + (e[0] == 'lume' && typeof e[1] == 'number' ? e[1] : e[0] == 'pay' ? e[1] * .7 : 0), 0))) : 0), 0), 0), 0);

const axEndIncome = p => [...G.p[p].front, ...G.p[p].vault].reduce( (s, u) => s + (u.ab || []).filter(a => a.tr == 'end').reduce( (q, a) => q + (a.fx || []).reduce( (r, f) => r + (f[0] == 'lume' && typeof f[1] == 'number' && f[1] > 0 ? f[1] : f[0] == 'choose' ? Math.max(0, ...(f[1] || []).map(alt => alt.reduce( (t, e) => t + (e[0] == 'lume' && typeof e[1] == 'number' ? e[1] : e[0] == 'pay' ? e[1] * .7 : 0), 0))) : 0), 0), 0), 0);

/* Lume that can really pay the next Payday: what is left + End Turn income + Extraction income (Extraction resolves BEFORE Payday). The +1 income of the turn is protected and never pays. */
const axExtractIncome = p => axIncome(p) - axEndIncome(p);

const axPayAvail = (p, leftover) => ECHO_PAYS_LIFE ? 0 : leftover + axIncome(p);

let AX_PLAN_T = -1
  , AX_KILL_T = -1;

/* worth of a Unit that is in play (owner p) */
function uVal(p, u) {
    const ab = (u.ab || []).filter(a => a.tr != 'act' && a.tr != 'play' && a.tr != 'passive').reduce( (s, a) => s + Math.max(0,axEvalFx(p,a.fx,u,{light:1})) * (AX_TM[a.tr] || 1.2) * .4, 0);
    const pas = (u.ab || []).filter(a => a.tr == 'passive').reduce((s,a)=>s+Math.max(0,axEvalFx(p,a.fx,u,{light:1,noCounterSynergy:true}))*.72,0);
    /* Counter-powered abilities are worth their live, ordered payoff, not a generic fixed bonus. */
    const eng = (u.ab || []).filter(a => a.tr == 'act' && !actUsedUp(u, a)).reduce( (s, a) => s + Math.max(0,axEvalFx(p,a.fx,u,{light:1})) * 1.15, 0);
    return A(p, u) * 1.1 + Math.max(1, HPv(u) - u.dmg) * .8 + axKw(u) + ab + pas + eng + .5 + axEng(p, u) * axThr(p)
}

/* ENGINE SCORE of a permanent (Unit on the Frontline or Relic in the Vault) of player o: what it keeps producing for o, WITHOUT its body (ATK / HP).
   A professional removes the opponent's engine first, whatever the card type: the cards that make value every turn are worth more than any body.
   It counts repeating triggers and passives, activated abilities and Lume / draw / counter income, and adds a combo bonus when o's side holds BOTH halves of a
   counters -> value chain (a card that puts counters + a card that cashes them in: heal / Lume / draw 'removed'): killing either half stops the whole chain.
   Only readable information (the board and the vault) is used, the same as a human reads. */
function axEngineScore(o, u) {
    if (!u)
        return 0;
    const ab = u.ab || []
      , ev = a => Math.max(0, axEvalFx(o, a.fx, u, {
        light: 1
    }));
    let e = ab.filter(a => a.tr != 'act' && a.tr != 'play' && a.tr != 'flash' && a.tr != 'passive').reduce( (t, a) => t + ev(a) * (AX_TM[a.tr] || 1.2) * .4, 0) + ab.filter(a => a.tr == 'passive').reduce( (t, a) => t + ev(a) * .72, 0) + ab.filter(a => a.tr == 'act').reduce( (t, a) => t + ev(a) * 1.15, 0) + axEng(o, u) * axThr(o);
    const side = [...G.p[o].front, ...G.p[o].vault]
      , prod = x => (x.ab || []).some(a => a.tr != 'flash' && a.tr != 'play' && (a.fx || []).some(f => f[0] == 'counter'))
      , conv = x => (x.ab || []).some(a => (a.fx || []).some(f => isRem(f[1])));
    /* a chain needs BOTH halves: the fewer cards that carry a half, the more each one is worth (the only converter is the whole payoff), and the more
       counters are already waiting to be cashed in, the closer the payoff is */
    const ps = side.filter(prod)
      , cs = side.filter(conv);
    if ((prod(u) || conv(u)) && ps.length && cs.length) {
        const waiting = side.reduce( (t, x) => t + Object.values(x.ctr || {}).reduce( (a, b) => a + b, 0), 0)
          , share = Math.min(1, (prod(u) ? 1 / ps.length : 0) + (conv(u) ? 1 / cs.length : 0));
        e += (12 + Math.min(waiting, 30) * .5) * share
    }
    return e + axImpact(o, u)
}

/* OBSERVED IMPACT: what this permanent has really done for its owner in THIS match, read from the public match record (Life and Lume it made, debt it moved away),
   as a rate per turn over the next 4 turns. A human sees it too: the Life total keeps climbing and the log names who did it. Nothing here depends on a card's name
   except as the key of that record, so a new card with the same kind of effect is judged the same way. */
function axImpact(o, u) {
    const M = (MS && MS[o]) || {}
      , g = k => (M[k] || {})[u.n] || 0
      , t = Math.max(1, G && G.turn || 1);
    return (g('life+') * .5 + g('lume+') * 1.2 + g('debt-') * .3) / t * 4
}

/* ---- LEARNING THE LOGISTIC: which cards are the engine of MY deck, and what is it worth to play them first? ----
   Until now the engine score only decided what to KILL. A professional also plays their own engine first: the card that makes value every turn is worth
   more than its first-turn body, and the earlier it comes down the more turns it pays back.
   1. At the first look Axiom reads its OWN Logistic (its own cards: its own information, nothing of the opponent's): the engine value of every card (the same
      effect scan the removal uses) and the chains inside the deck: a card that puts counters + a card that cashes them in (heal / Lume / draw 'removed').
      A chain needs BOTH halves in the deck, then each half is worth more, and most while the other half is already in hand or on the board.
   2. When it chooses what to play, every Unit / Relic gets its engine value added to its play value (axPlayEng), and engines are played before the cards
      they power. What a card really did earlier in THIS match (axImpact: Life / Lume it made) makes its other copies worth more.
   AX_ENGINE_PLAY = how much of the engine value counts, per seat (0 = the old behaviour, the engine only counts once it is in play). */
const AX_ENGINE_PLAY = [.5, .5];
function axProfile(p) {
    G.axProf = G.axProf || [];
    if (G.axProf[p])
        return G.axProf[p];
    const P = G.p[p]
      , all = [...P.deck, ...P.hand, ...P.front, ...P.vault, ...P.waste]
      , prod = c => (c.ab || []).some(a => a.tr != 'flash' && a.tr != 'play' && (a.fx || []).some(f => f[0] == 'counter'))
      , conv = c => (c.ab || []).some(a => (a.fx || []).some(f => isRem(f[1])))
      , role = {}
      , seen = {};
    let np = 0, nc = 0;
    all.forEach(c => {
        const r = prod(c) && conv(c) ? 'both' : prod(c) ? 'prod' : conv(c) ? 'conv' : '';
        if (r)
            role[c.n] = r;
        np += r == 'prod' || r == 'both' ? 1 : 0;
        nc += r == 'conv' || r == 'both' ? 1 : 0
    }
    );
    const chain = np && nc ? 6 : 0
      , top = [];
    all.forEach(c => {
        if (seen[c.n] || c.t == 'T')
            return;
        seen[c.n] = 1;
        const e = axEngineScore(p, c) + (role[c.n] ? chain * (role[c.n] == 'both' ? 1.5 : 1) : 0);
        if (e >= 3)
            top.push([c.n, e])
    }
    );
    top.sort( (a, b) => b[1] - a[1]);
    /* UNIT SWAP RATING: is this deck one that loses / replaces its Units fast, read from the EFFECTS of every card of the list (never from names).
       fuel   = a card that makes my Units leave on purpose: sacrifice costs, 'destroy' my Unit, summon (tokens), 'return' my Unit
       payoff = a card that lives on Units dying: 'ally' (a Unit of mine is destroyed) / 'death' triggers
       Units  = bodies that also die in combat.   Result = Units expected to leave per own turn; the match record then corrects it (axSwapRate). */
    const nAll = Math.max(1, all.length)
      , fuelOf = c => [...(c.ab || []), ...(c.fx ? [{
        fx: c.fx
    }] : [])].some(a => costOf(a).some( ([t,,g]) => t == 'destroy' && (g == 'self' || g == 'mypick')) || (a.fx || []).some(f => Array.isArray(f) && (f[0] == 'summon' || (f[0] == 'destroy' && f[2] == 'mypick') || (f[0] == 'return' && f[2] == 'mypick'))))
      , payoffOf = c => (c.ab || []).some(a => a.tr == 'ally' || a.tr == 'death')
      , swap = .15 + 1.6 * all.filter(fuelOf).length / nAll + 1.2 * all.filter(payoffOf).length / nAll + .25 * all.filter(c => c.t == 'U').length / nAll;
    const prof = {
        role,
        chain,
        top,
        swap
    };
    G.axProf[p] = prof;
    const txt = top.slice(0, 4).map(x => `${x[0]} ${x[1].toFixed(0)}`).join(', ') || 'none';
    mlog(`AI DECK PLAN (${G.p[p].name}): reads its own Logistic. Engine cards: ${txt}.${chain ? ` Chain: ${np} counter makers + ${nc} cash-ins.` : ''} Unit swap: ${swap.toFixed(2)} Units lost per turn (${swap < .4 ? 'low' : swap < .8 ? 'medium' : 'high'}).`);
    if (SPEC)
        say(`${G.p[p].name} studies its Logistic. Main engine: ${top.slice(0, 3).map(x => x[0]).join(', ') || 'none'}`);
    return prof
}
/* the engine value that playing card c adds to its play value (Units and Relics; a Tactical has no lasting engine) */
function axPlayEng(p, c) {
    const w = AX_ENGINE_PLAY[p];
    if (!w || c.t == 'T')
        return 0;
    const P = G.p[p]
      , side = [...P.front, ...P.vault]
      , prof = axProfile(p)
      , r = prof.role[c.n];
    let e = axEngineScore(p, c);
    if (r && prof.chain) {
        /* the other half of the chain: in hand or in play counts in full, still in the Logistic only half */
        const need = r == 'prod' ? 'conv' : 'prod'
          , partner = [...side, ...P.hand].some(x => x !== c && (prof.role[x.n] == need || prof.role[x.n] == 'both'));
        e += prof.chain * (r == 'both' ? 1.5 : 1) * (r == 'both' || partner ? 1 : .5)
    }
    /* a second copy of the same engine adds a little less, and an engine pays back over the turns that are left */
    e /= 1 + .3 * side.filter(x => x.n == c.n).length;
    return e * w * Math.max(.35, Math.min(1, (26 - G.turn) / 18))
}

/* a Unit that can BLOCK is worth the damage of the biggest attacker it stops, counted at the Life price of the short clock (0 when there is no danger) */
function axBlockerNeed(p, c) {
    if (c.t != 'U')
        return 0;
    const ck = axClock(p);
    return ck.urgency > 0 ? Math.min(10, ck.urgency * ck.next * 3) : 0
}

/* ---- COMBO ROLES AND CHAIN BONUS: Echo and death chains, read from the EFFECTS (never from names) ----
   Echo chain: a card that PAYS when Echo cards are played (aecho: Lume / Life for every Echo card) + cards that have Echo to play.
   Death chain: a card that PAYS when Units die (a Unit's own 'death', or 'ally' on the side) + cards that make Units die on purpose (destroy / damage to your own
   Units) or fodder that dies anyway. Neither half is worth much alone: each half gets a bonus while the other half is in the hand or in play. */
function axRoles(c) {
    G.axRl = G.axRl || {};
    if (G.axRl[c.n])
        return G.axRl[c.n];
    const ab = c.ab || []
      , own = ['self', 'allies', 'others', 'mypick', 'myunit', 'myunits']
      , r = {
        echoMake: c.e > 0,
        echoPay: ab.some(a => axAbilityTrigger(a, 'aecho') || axAbilityTrigger(a, 'debtup')),
        deathPay: ab.some(a => axAbilityTrigger(a, 'death') || axAbilityTrigger(a, 'ally')),
        deathMake: [...ab.flatMap(a => [...(a.fx || []), ...(a.cost || [])]), ...(c.fx || [])].some(f => Array.isArray(f) && (f[0] == 'destroy' || f[0] == 'dmg' && f[2] == 'allies') && own.includes(f[2]))
    };
    return G.axRl[c.n] = r
}
const axTurnsLeft = () => Math.max(.4, Math.min(1, (26 - G.turn) / 18));
function axChain(p, c) {
    const P = G.p[p]
      , side = [...P.front, ...P.vault]
      , others = [...side, ...P.hand.filter(x => x !== c)]
      , r = axRoles(c);
    let v = 0;
    /* ECHO: the payoff is worth more with Echo cards waiting; an Echo card is worth more with the payoff in hand (it will be on the board first) */
    if (r.echoPay)
        v += Math.min(3, others.filter(x => axRoles(x).echoMake).length) * 2.2;
    if (r.echoMake && !side.some(x => axRoles(x).echoPay))
        v += Math.min(2, P.hand.filter(x => x !== c && axRoles(x).echoPay).length) * 1.2;
    /* DEATH: the payoff needs deaths (a way to cause them, or enough Units to trade); a death maker is worth what the payoffs on the board give */
    if (r.deathPay)
        v += Math.min(2, others.filter(x => axRoles(x).deathMake).length) * 2.5 + (P.front.length >= 3 ? 1 : 0);
    if (r.deathMake) {
        const pay = side.reduce( (t, u) => t + (axRoles(u).deathPay ? (u.ab || []).filter(a => axAbilityTrigger(a, 'death') || axAbilityTrigger(a, 'ally')).reduce( (q, a) => q + Math.max(0, axEvalFx(p, a.fx, u, {
            light: 1
        })) * .6, 0) : 0), 0);
        v += Math.min(8, pay)
    }
    return v * axTurnsLeft()
}

/* ---- OBJECTIVE PLAN: the best card in hand is the PRIMARY objective. If it cannot be paid yet, the objective becomes the card that can fund it ----
   1. phase 'engine'  : the best card can be played now -> it is played first (a large bonus), the rest of the Lume goes to cards that fit around it.
   2. phase 'enable'  : it cannot be paid now, but a card that gives Lume back (a Lume Tactical, a Unit with a Lume play effect) makes it payable THIS turn -> play the
                        enabler first and the engine right after it (both get a bonus; the engine is only SECONDARY until the Lume is there).
   3. phase 'enable-next' : no card makes it payable this turn, but an enabler leaves enough Lume that the next turn's income pays for it -> play the enabler, keep that Lume.
   4. phase 'wait'    : nothing funds it, the old saving rule decides.
   5. phase 'loop'    : an engine of the AI is already in play: the cards that fire it (their triggers: play / enter / Echo / death chains) get the bonus.
   Every turn the plan is recomputed from the cards in hand, so the main objective switches back to the engine card as soon as the Lume is there. */
function axObjective(p) {
    const P = G.p[p]
      , out = {
        bonus: {},
        keep: 0,
        eid: null,
        phase: 'none',
        T: null
    }
      , inc = 1 + axIncome(p)
      , side = [...P.front, ...P.vault]
      /* the primary card does not have to be affordable yet (that is the point), an enabler has to be playable now */
      , okT = c => meetsTrigger(p, c) && !axDeckUnsafe(p, c)
      , ok = c => worth(p, c) && !axDeckUnsafe(p, c) && meetsTrigger(p, c)
      , scored = P.hand.filter(c => c.t != 'T' && okT(c)).map(c => ({
        c,
        v: axCard(p, c)
    })).sort( (a, b) => b.v - a.v);
    const top = scored[0];
    const loopEngine = side.some(u => axEngineScore(p, u) >= 8);
    if (!top || top.v < 6) {
        if (loopEngine)
            out.phase = 'loop';
        return out
    }
    const T = top.c;
    out.T = T;
    if (axSeq(p, [T])) {
        out.phase = 'engine';
        out.bonus[T.id] = Math.max(8, top.v * .8)
    } else {
        const en = P.hand.filter(e => e !== T && ok(e) && axLumeGain(e) > 0 && e.c <= P.lume).map(e => ({
            e,
            net: axLumeGain(e) - e.c
        })).sort( (a, b) => b.net - a.net || a.e.c - b.e.c);
        const now = en.find(x => axSeq(p, [x.e, T]));
        if (now) {
            out.phase = 'enable';
            out.eid = now.e.id;
            out.bonus[now.e.id] = Math.max(6, top.v * .6);
            out.bonus[T.id] = Math.max(8, top.v * .8)
        } else {
            const nxt = en.find(x => P.lume - x.e.c + axLumeGain(x.e) + inc >= T.c);
            if (nxt) {
                out.phase = 'enable-next';
                out.eid = nxt.e.id;
                out.bonus[nxt.e.id] = Math.max(6, top.v * .6);
                out.keep = Math.max(0, T.c - inc)
            } else
                out.phase = 'wait'
        }
    }
    const key = out.phase + ':' + (out.T && out.T.id) + ':' + (out.eid || '');
    if (G.axObjKey !== key + ':' + G.turn) {
        G.axObjKey = key + ':' + G.turn;
        const en = out.eid ? P.hand.find(c => c.id == out.eid) : null;
        mlog(`AI OBJECTIVE: primary ${T.n} (value ${top.v.toFixed(1)}, cost ${T.c}, Lume ${P.lume}) -> ` + ({
            engine: 'it can be played now: plays it first',
            enable: `${en && en.n} gives the Lume back: plays it first, ${T.n} right after (secondary until the Lume is there)`,
            'enable-next': `${en && en.n} funds it for next turn: plays that and keeps ${out.keep} Lume`,
            wait: 'nothing funds it yet: saves'
        }[out.phase] || out.phase) + (loopEngine ? '; engine in play: loop focus' : ''))
    }
    return out
}

/* FEEDING THE OPPONENT'S ENGINES. A debt trigger of the opponent ('debtup' = its own debt rises, 'odebtup' = mine rises: Sinner puts X counters on all its Units,
   X = its Echo Debt) is fired by every Echo Debt move Axiom makes, and counters turn into Life (The Lifeblade) or HP (Praetorum). This is what one debt event
   would give the opponent, in Life points. kind 'opp' = Axiom puts k debt ON the opponent (its 'debtup'), 'me' = Axiom takes k debt itself (its 'odebtup').
   Only what a human can see counts (board and vault): a visible Life converter makes a counter worth 1 Life, a visible HP cash-in .5, nothing visible .25. */
const AX_FEED_W = 1;
/* the estimate evaluates the opponent's debt triggers, and a trigger that moves debt asks for the same estimate again (Gravity Lock against Gravity Lock):
   a nested ask counts as 0, otherwise the two sides call each other until the stack overflows */
let AX_FEED_BUSY = 0;
function axDebtFeed(p, kind, k) {
    if (AX_FEED_BUSY)
        return 0;
    AX_FEED_BUSY = 1;
    try {
        return axDebtFeedRaw(p, kind, k)
    } finally {
        AX_FEED_BUSY = 0
    }
}
function axDebtFeedRaw(p, kind, k) {
    if (!(k > 0))
        return 0;
    const oi = 1 - p
      , O = G.p[oi]
      , side = [...O.front, ...O.vault]
      , want = kind == 'opp' ? 'debtup' : 'odebtup'
      , fxs = side.reduce( (l, u) => l.concat((u.ab || []).reduce( (m, a) => m.concat(a.fx || []), [])), [])
      , heal = fxs.some(f => f[0] == 'heal' && isRem(f[1]))
      , cash = fxs.some(f => isRem(f[1]))
      , w = heal ? 1 : cash ? .5 : .25;
    let v = 0;
    side.forEach(u => (u.ab || []).forEach( (a, ai) => {
        if (a.tr != want && !(a.trs || []).includes(want))
            return;
        if (!ifOk(a.if, oi, u))
            return;
        const lim = a.max > 0 ? Math.floor(a.max) : 0;
        if (lim && ((u.tu || {})[ai] || 0) >= lim)
            return;
        (a.fx || []).forEach(f => {
            if (f[0] == 'counter') {
                const x = String(f[1]) == 'debt' ? (O.debt || 0) + (kind == 'opp' ? k : 0) : Math.max(0, +numOf(oi, u, f[1]) || 0)
                  , t = f[2] == 'allies' ? O.front.length : 1;
                v += Math.min(x * t, 80) * w
            } else
                v += Math.max(0, axEvalFx(oi, [f], u, {
                    light: 1
                }))
        }
        )
    }
    ));
    return v
}

/* Echo Debt the OPPONENT's "when the opponent's Echo Debt decreases" cards (Archive Core) would put on player p every time p's own debt goes down
   (Payday, Calibrator, Gravity Lock, Recycler...): only abilities that can fire right now (condition met, max not yet reached) count */
function axTrap(p) {
    const Q = G.p[1 - p];
    let t = 0;
    [...Q.front, ...Q.vault].forEach(s => (s.ab || []).forEach( (a, ai) => {
        if (!(a.tr == 'odebtdown' || (a.trs || []).includes('odebtdown')))
            return;
        if (a.max > 0 && ((s.tu || {})[ai] || 0) >= a.max)
            return;
        if (!ifOk(a.if, 1 - p, s))
            return;
        (a.fx || []).forEach(f => {
            if (f[0] == 'debt' && f[2] == 'opp')
                t += Math.min(Math.max(0, numOf(1 - p, s, f[1]) || 0), Q.debt || 0)
        }
        )
    }
    ));
    return t
}

/* The AI's OWN cards move debt onto the opponent by themselves: 'debtup' (its debt rises: Gravity Lock, Decommission) or 'anyplay' (it plays a card: Recalculate).
   Each such move is one more debt event for the opponent's 'debtup' engine (Sinner counters -> Life). This is what those moves hand the opponent, in Life points,
   for ONE firing of the trigger 'trig' when p's debt has just gone up by k. 'extra' = cards about to enter play (their own triggers fire too). */
function axOwnDumpFeed(p, trig, k, extra) {
    const P = G.p[p];
    let v = 0;
    [...P.front, ...P.vault, ...(extra || [])].forEach(u => (u.ab || []).forEach( (a, ai) => {
        if (a.tr != trig && !(a.trs || []).includes(trig))
            return;
        if (!ifOk(a.if, p, u))
            return;
        const lim = a.max > 0 ? Math.floor(a.max) : 0;
        if (lim && ((u.tu || {})[ai] || 0) >= lim)
            return;
        (a.fx || []).forEach(f => {
            if (f[0] == 'debt' && f[2] == 'opp') {
                const m = Math.min(Math.max(0, +numOf(p, u, f[1]) || 0), Math.max(0, (P.debt || 0) + k));
                if (m > 0)
                    v += axDebtFeed(p, 'opp', m)
            }
        }
        )
    }
    ));
    return v
}

/* worth of ONE effect [type, amount, target] for player p, now. Positive = good for p. */
function axFx(p, f, src, ctx={}) {
    const ty = f[0]
      /* a card with Echo takes its Echo Debt BEFORE its effect resolves: an effect that copies 'my Echo Debt' (Factory Reset) sees that debt too (ctx.echoDebt) */
      , n0 = isRem(f[1]) && ctx.removed != null ? remAmt(f[1], ctx.removed) : f[1] === 'debt' && ctx.echoDebt ? numOf(p, src, f[1]) + ctx.echoDebt : numOf(p, src, f[1])
      , tg = f[2]
      , n = typeof n0 == 'number' ? n0 : 1
      , P = G.p[p]
      , O = G.p[1 - p]
      , lt = ctx.light
      , df = ctx.def;
    const enL = () => tg == 'trigger' && ctx.trigger ? [ctx.trigger] : O.front;
    const kill = (u, x) => x >= HPv(u) - u.dmg ? (lt ? 4 : uVal(1 - p, u) * 1.1 + axEngineScore(1 - p, u) * 1.6) + 1 : x * .45;
    const hit = (L, x) => !L.length ? 0 : tg == 'pick' ? Math.max(...L.map(u => kill(u, x))) : L.reduce( (s, u) => s + kill(u, x), 0);
    const mineT = ['allies', 'self', 'others', 'mypick'].includes(tg) || (tgSpec(tg) && !/^ehas:/.test(tg)) || (tg == 'trigger' && ownerAny(ctx.trigger) == p);
    switch (ty) {
    case 'dmg':
        if (tg == 'me') {
            /* Life paid now must still leave enough for MY OWN next Payday (my Echo Debt minus the Lume that can pay it comes off my Life too):
               Biofuel Recycle at 20 Life and 15 Debt left the AI at 5 Life facing a 13 Life Payday */
            const pl = Math.max(0, (P.debt || 0) - axPayAvail(p, P.lume));
            return -n * (P.life <= n + 3 || P.life - n <= pl + 2 ? 50 : P.life < 10 ? 2.5 : 1.2)
        }
        if (tg == 'opp')
            return O.life <= n ? 100 : n * (O.life < 10 ? 1.6 : .9) * (axRace(p) ? 1.6 : 1);
        return mineT ? -n * 1.5 : hit(enL(tg), n);
    case 'buff':
    case 'hp':
    case 'surge':
        {
            /* n is signed: +n helps the Units it hits, -n hurts them. Value = effect on MY side minus effect on THEIR side */
            const w = ty == 'surge' ? .9 : 1.2
              , mineSide = mineT || tg == 'trigger' && ownerAny(ctx.trigger) == p || tg == 'anypick' && n >= 0
              , per = String(f[3] || '')
              , scale = per.startsWith('counter:') ? ctrN(src, per.slice(8)) : per.startsWith('counters:') ? P.front.reduce((z,u) => z + ctrN(u, per.slice(9)), 0) : per.startsWith('ecounters:') ? O.front.reduce((z,u) => z + ctrN(u, per.slice(10)), 0) : per == 'others' ? Math.max(0, P.front.length - (P.front.includes(src) ? 1 : 0)) : per == 'units' ? P.front.length : per == 'enemies' ? O.front.length : 1
              , amt = n * Math.max(0, scale)
              , L = tg == 'trigger' && ctx.trigger ? [ctx.trigger] : mineT ? (tg == 'self' ? [src].filter(u => u && u.t == 'U') : tg == 'others' ? P.front.filter(u => u !== src) : tg == 'mypick' ? P.front.slice(0, 1) : P.front) : tg == 'pick' ? O.front.slice(0, 1) : enL(tg);
            if (!mineSide && amt < 0) {
                /* a curse on enemy Units: an HP curse that kills is worth the whole Unit */
                if (ty == 'hp')
                    return L.reduce( (s, u) => s + (HPv(u) - u.dmg + amt <= 0 ? (lt ? 4 : uVal(1 - p, u) * 1.1) + 1 : -amt * .6), 0);
                return L.reduce( (s, u) => s + Math.min(A(1 - p, u), -amt) * w * (u.st == 'R' ? .5 : 1.3), 0)
            }
            if (mineSide && amt < 0)
                return (ty == 'hp' ? -1 : -.8) * -amt * Math.max(1, L.length) * w * 1.3;
            if (!mineSide)
                return -amt * L.length * w;
            if (ty == 'surge')
                return P.front.filter(u => u.st == 'S').length * amt * .9;
            return (L.length || tg == 'self') ? amt * w * (tg == 'allies' ? Math.max(1, L.length) * .8 : 1) : 0
        }
    case 'heal':
        return tg == 'me' ? Math.max(0, n) * (P.life < 8 ? 1.7 : P.life < 20 ? .8 : .22) : (tg == 'trigger' && ctx.trigger ? [ctx.trigger] : tg == 'pick' ? O.front.slice(0, 1) : mineT ? P.front : O.front).reduce( (s, u) => s + Math.min(Math.max(0,n), u.dmg || 0) * (ownerAny(u) == p ? .8 : -.8), 0);
    case 'lume':
        return n * (P.lume < 8 ? 1.3 : P.lume < 14 ? .9 : .5) + (P.lume + n >= lumeGoal(P) ? 5 : 0);
    case 'draw':
        return axDraw(P, n);
    case 'steal':
        return Math.min(n, O.lume) * (axRace(p) ? 4 : 1.6) + (O.lume >= lumeGoal(O) && O.lume - n < lumeGoal(O) ? 12 : 0);
    case 'rest':
        {
            const L = (tg == 'trigger' && ctx.trigger ? [ctx.trigger] : tg == 'pick' ? O.front.slice(0, 1) : mineT ? P.front : enL(tg)).filter(u => u.st != 'R')
              , v = u => (ownerAny(u) == p ? -1 : 1) * A(ownerAny(u), u) * (df ? .2 : .8);
            return tg == 'pick' ? Math.max(0, ...L.map(v)) : L.reduce( (s, u) => s + v(u), 0)
        }
    case 'state':
        {
            if (tg == 'enemies' || tg == 'pick')
                return n0 == 'rest' ? enL(tg).filter(u => u.st != 'R').reduce( (s, u) => s + A(1 - p, u) * (df ? .2 : .8), 0) : -2;
            return n0 == 'standby' ? (df ? 0 : P.front.filter(u => u.st != 'S').reduce( (s, u) => s + A(p, u) * .9, 0)) : n0 == 'rest' ? -2 : 0.5
        }
    case 'return':
        if (tg == 'mypick' || tg == 'self')
            return Math.max(0.5, ...P.front.map(u => (u.dmg || 0) * 1.2));
        return O.front.length ? Math.max(...enL(tg).map(u => uVal(1 - p, u) * (u.tok ? 1.1 : .6))) : 0;
    case 'prune':
        return mineT ? -3 : hit(enL(tg), 99) * 1.2;
    case 'choose':
        return Math.max(0, ...((n0 || []).map(a => axEvalFx(p, a, src, {...ctx, _counterState: ctx._counterState ? new Map(ctx._counterState) : undefined})))) + (Array.isArray(f[2]) ? axEvalFx(p, f[2], src, ctx) : 0) + (Array.isArray(f[3]) ? axEvalFx(p, f[3], src, ctx) : 0);
    case 'raze':
        return tg == 'self' ? -1 : tg == 'myrelic' || tg == 'myrelics' ? -2 : O.vault.length ? Math.max(...O.vault.map(r => r.c * .8 + 1.5 + axEngineScore(1 - p, r) * 2.2)) : 0;
    case 'summon':
        return Array.isArray(n0) ? (n0[0] + n0[1]) * .8 + .8 : 1.8;
    case 'pay':
        /* 'opp' = it relieves the opponent's debt (bad for me); 'ctrl' depends on whose Unit set it off: neutral */
        return tg == 'opp' ? -Math.min(O.debt || 0, n) * 1.2 : tg == 'ctrl' ? 0 : Math.min(P.debt, n) * 1.4 - (P.debt > 0 && n > 0 ? axTrap(p) * 1.3 : 0);
    case 'disable':
        {
            const dk = String(f[3] || ''), H = handTg(tg);
            /* switching a keyword off is worth it on the enemy side, a loss on mine */
            if (H)
                return handSides(p, H).reduce( (v, w) => v + (w == p ? -1 : 1) * Math.min(handDisableList(G.p[w], dk, H.ty).length, 4) * .7, 0);
            const mineT = ['allies', 'self', 'mypick', 'others', 'myrelic', 'myrelics'].includes(tg) || !!tgSpec(tg) && !/^ehas:/.test(tg)
              , lst = /relic/.test(String(tg)) ? (mineT ? P.vault : O.vault) : (mineT ? P.front : O.front);
            return (mineT ? -1 : 1) * Math.min(lst.filter(u => hasKwOn(u, dk)).length, 4) * .9
        }
    case 'grant':
        /* Evaluate the actual set of cards affected. Echo is a debt trap when granted to the enemy, not merely a generic keyword. */
        {
            const H = handTg(tg);
            if (H) {
                const gk = String(f[3] || ''), k = Math.max(0, Math.floor(+n) || 0);
                return handSides(p, H).reduce( (v, w) => {
                    const mine = w == p, L = handGrantList(G.p[w], gk, Math.max(1,k), H.ty);
                    if (gk == 'drawdown')
                        return v + (mine ? L.reduce( (t, c) => t + Math.min(k, c.c) * (P.lume < 8 ? 1.1 : .65), 0) : -L.length * .6);
                    if (gk == 'echo') {
                        if (mine) return v - L.reduce((t,c) => t + Math.min(k,c.c) * .45, 0);
                        return v + L.reduce((t,c) => {
                            const borrow = Math.min(k, c.c);
                            const unpaid = Math.max(0, borrow - O.lume - axExtractIncome(w));
                            return t + borrow * (O.life < 10 ? 1.25 : .75) + unpaid * (O.life < 10 ? 1.1 : .5);
                        }, 0);
                    }
                    return v + (mine ? 1 : -1) * Math.min(L.length, 4) * .75
                }, 0)
            }
            return 1
        }
    case 'recur':
        return P.waste.filter(u => u.t == 'U').sort((a,b) => (b.c + (b.a||0) + (b.h||0)) - (a.c + (a.a||0) + (a.h||0))).slice(0, Math.max(1,n)).reduce((z,u) => z + 1.1 + (u.a||0)*.65 + (u.h||0)*.35, 0);
    case 'retrieve':
        {
            const got = P.waste.slice(-Math.max(1,n));
            return tg == 'logistic' || tg == 'shuffle' ? got.length * (P.deck.length < 8 ? 1.3 : .55) : got.reduce((z,c) => z + .9 + (c.t == 'U' ? ((c.a||0)+(c.h||0))*.45 : .35), 0);
        }
    case 'mill':
        if (tg == 'opp') return Math.min(Math.max(0,n), O.deck.length) * (O.deck.length <= 5 ? 3.5 : O.deck.length <= 10 ? 1.8 : .45);
        return -Math.min(Math.max(0,n), P.deck.length) * (P.deck.length <= 10 + axDrawEng(p)*2 ? 2.5 : .2);
    case 'drain':
        return Math.min(Math.max(0,n),O.life) * (O.life < 10 ? 1.8 : .95) + Math.min(Math.max(0,n),P.life < 8 ? 8-P.life : P.life < 20 ? 20-P.life : 2) * (P.life < 8 ? 1.5 : .55) + (O.life <= n ? 100 : 0);
    case 'discard':
        return -Math.max(0,n) * (P.hand.length <= 2 ? 2.6 : P.hand.length <= 4 ? 1.5 : .65);
    case 'peek':
        return Math.min(2, O.hand.length) * .35;
    case 'shuffle':
        return tg == 'opp' ? (O.deck.length > 0 ? .35 : 0) : 0;
    case 'counter':
        return !ctx.noCounterSynergy ? .2 * Math.max(0,n) : .1 * Math.max(0,n);
    case 'uncounter':
        return -Math.max(0,ctx.removed || 0) * .06;
    case 'hold':
        {
            const L = axEffectUnits(p,src,tg,ctx);
            const key = f[3];
            return L.reduce((z,u) => z + (ctrN(u,key) > 0 ? (ownerAny(u) == p ? -.9 : .9) * Math.min(3,ctrN(u,key)) : 0),0);
        }
    case 'debt':
        {
            /* ['debt', n, 'opp'] = move up to n of MY Echo Debt onto the opponent (n may be the variable 'debt' = all of it):
           worth what it makes the opponent lose at its Payday (the debt its Lume cannot pay becomes Life) */
            if (tg == 'opp') {
                const k = Math.min(n, P.debt || 0, debtRoom(O));
                if (k <= 0)
                    return 0;
                const oAvail = ECHO_PAYS_LIFE ? 0 : O.lume + (O.lume < 10 ? 1 : 0)
                  , oAfter = (O.debt || 0) + k
                  , oLoss = ECHO_PAYS_LIFE ? k : oAfter > oAvail ? oAfter : 0;
                /* my debt going down wakes the opponent's Archive Core: it puts that debt straight back on me */
                return k * .9 + oLoss * (O.life < 15 ? 1.6 : 1) * (O.life <= oLoss ? 6 : 1) + (O.life <= oLoss ? 100 : 0) - axTrap(p) * 1.3 - (O.life <= oLoss ? 0 : axDebtFeed(p, 'opp', k) * AX_FEED_W)
            }
            /* ['debt', n, 'me'] = I take n Echo Debt myself; ['debt', n] = I take up to n from the opponent (a debt sponge) */
            return tg == 'me' ? -n * 1.5 : -Math.min(n, O.debt || 0) * .6 + 1
        }
    case 'adddebt':
        {
            /* ['adddebt', n, 'opp'] = the opponent takes n NEW Echo Debt: worth what it costs it at Payday; 'me' = I take it myself */
            if (tg == 'opp') {
                const k = Math.min(Math.max(0, n), debtRoom(O))
                  , oAvail = ECHO_PAYS_LIFE ? 0 : O.lume + (O.lume < 10 ? 1 : 0)
                  , oAfter = (O.debt || 0) + k
                  , oLoss = ECHO_PAYS_LIFE ? k : oAfter > oAvail ? oAfter - Math.max(oAvail, O.debt || 0) : 0;
                return k * .9 + oLoss * (O.life < 15 ? 1.6 : 1) * (O.life <= oLoss ? 6 : 1) + (O.life <= oLoss ? 100 : 0) - (O.life <= oLoss ? 0 : axDebtFeed(p, 'opp', k) * AX_FEED_W)
            }
            /* 'ctrl': who takes it depends on whose Unit entered, so it is neutral for the AI */
            if (tg == 'ctrl')
                return 0;
            return -n * 1.5
        }
    case 'search':
        {
            /* a named card is worth a good draw while a copy is still in the Logistic; searching also empties it like a draw */
            return searchCands(p, tg).length ? axDraw(P, 1) + 1.4 : -.5
        }
    case 'look':
        /* look at n, take f[2]: it empties the Logistic just like a draw does */
        return axDraw(P, typeof f[2] == 'number' ? f[2] : 1) + .6;
    case 'destroy':
        {
            if (!mineT)
                return hit(enL(tg), 99) * 1.3;
            /* your own Units die: a cost (the cheapest ones, you choose) */
            const L = tg == 'self' ? [src].filter(Boolean) : P.front.filter(u => u !== src)
              , v = L.map(u => uVal(p, u)).sort( (a, b) => a - b);
            return -(!L.length ? 50 : ['allies', 'others'].includes(tg) || tgSpec(tg) ? v.reduce( (s, x) => s + x, 0) : v.slice(0, n).reduce( (s, x) => s + x, 0) * .9)
        }
    default:
        return 1
    }
}

/* ================= RULE-AWARE EFFECT / TRIGGER EVALUATION =================
   Effects are evaluated as an ordered sequence, not as unrelated labels. This matters for
   counter -> uncounter -> 'removed' combinations, OR choices, and reactive abilities. */
const axCtrKey = (u, key) => `${u && u.id != null ? u.id : u && u.n || 'unit'}|${cn(key)}`;

function axCtrRead(u, key, ctx={}) {
    const k = axCtrKey(u,key), st = ctx._counterState;
    return st && st.has(k) ? st.get(k) : ctrN(u,key);
}

function axEffectUnits(p, src, tg, ctx={}) {
    if (tg == 'trigger') return ctx.trigger ? [ctx.trigger] : [];
    if (PICKS.includes(tg)) {
        const L = pickList(p,tg);
        if (!L.length) return [];
        /* Keep this helper non-recursive: uVal itself evaluates counter abilities.
           Target choice is scored separately by aiPickList when the effect resolves. */
        return [L[0]];
    }
    return tgUnits(p,src,tg,()=>[]).filter(u => u && [...G.p[OP].front,...G.p[ME].front].includes(u));
}

function axCounterMeasure(p, src, f, ctx={}) {
    const key = cn(f[3]);
    if (!key) return 0;
    const units = axEffectUnits(p,src,f[2],ctx);
    const amount = f[1] == 'all' ? Infinity : Math.max(0,Math.floor(+numOf(p,src,f[1])) || 0);
    if (f[4] == 'total' && amount !== Infinity) {
        let left = amount, total = 0;
        [...units].sort((a,b) => axCtrRead(b,key,ctx)-axCtrRead(a,key,ctx)).forEach(u => {
            const take = Math.min(axCtrRead(u,key,ctx),left);
            if (take > 0) { total += take; left -= take; }
        });
        return total;
    }
    return units.reduce((z,u) => z + Math.min(axCtrRead(u,key,ctx),amount),0);
}

function axCounterApply(p, src, f, ctx={}) {
    const key = cn(f[3]);
    if (!key) return 0;
    const units = axEffectUnits(p,src,f[2],ctx);
    const amount = Math.max(0,Math.floor(+numOf(p,src,f[1])) || 0);
    const state = ctx._counterState || (ctx._counterState = new Map());
    if (f[0] == 'counter') {
        units.forEach(u => {
            const k=axCtrKey(u,key);
            state.set(k,axCtrRead(u,key,ctx)+amount);
        });
        return amount * units.length;
    }
    let total = 0;
    if (f[4] == 'total' && f[1] != 'all') {
        let left=amount;
        [...units].sort((a,b)=>axCtrRead(b,key,ctx)-axCtrRead(a,key,ctx)).forEach(u=>{
            const k=axCtrKey(u,key), have=axCtrRead(u,key,ctx), take=Math.min(have,left);
            if(take>0){state.set(k,have-take);total+=take;left-=take;}
        });
    } else {
        units.forEach(u=>{
            const k=axCtrKey(u,key), have=axCtrRead(u,key,ctx), take=f[1]=='all'?have:Math.min(have,amount);
            if(take>0){state.set(k,have-take);total+=take;}
        });
    }
    return total;
}

function axCounterPotential(side, baseline, future, changed, key) {
    /* Compare the same board with and without the newly-added counters, then spend the
       simulated counters on the best available ability before considering another. */
    const changedSet = new Set(changed), beforeSeed = new Map(baseline || []), afterSeed = new Map(future || []);
    let total = 0, used = new Set();
    const board = [...G.p[side].front,...G.p[side].vault];
    for (let pass=0; pass<8; pass++) {
        let best = null;
        board.forEach(s => (s.ab||[]).forEach((a,ai) => {
            const lim = a.max > 0 ? Math.floor(a.max) : 0;
            const onBoard = G.p[side].front.includes(s) || G.p[side].vault.includes(s);
            if(a.tr!='act' || !onBoard || used.has(`${s.id}:${ai}`) || (lim && ((s.tu||{})[ai]||0)>=lim) || !ifOk(a.if,side,s) || !costsOK(side,s,costOf(a))) return;
            const relevant = (a.fx||[]).filter(f=>f[0]=='uncounter' && cn(f[3])==cn(key));
            if(!relevant.length) return;
            const touched = new Set();
            relevant.forEach(f => axEffectUnits(side,s,f[2],{_counterState:afterSeed}).forEach(u=>touched.add(u)));
            if (![...touched].some(u=>changedSet.has(u))) return;
            const beforeMap = new Map(beforeSeed), afterMap = new Map(afterSeed);
            const beforeN = relevant.reduce((z,f)=>z+axCounterMeasure(side,s,f,{_counterState:beforeMap}),0);
            const afterN = relevant.reduce((z,f)=>z+axCounterMeasure(side,s,f,{_counterState:afterMap}),0);
            if(afterN<=beforeN) return;
            const v = axEvalFx(side,a.fx,s,{light:1,noCounterSynergy:true,_counterState:afterMap}) - axEvalFx(side,a.fx,s,{light:1,noCounterSynergy:true,_counterState:beforeMap});
            if(!best || v>best.v) {
                const beforeSpent = new Map(beforeSeed), afterSpent = new Map(afterSeed);
                relevant.forEach(f=>{
                    axCounterApply(side,s,f,{_counterState:beforeSpent});
                    axCounterApply(side,s,f,{_counterState:afterSpent});
                });
                best={s,ai,v,beforeMap:beforeSpent,afterMap:afterSpent};
            }
        }));
        if(!best || best.v<=0) break;
        total += best.v * .72;
        beforeSeed.clear(); best.beforeMap.forEach((v,k)=>beforeSeed.set(k,v));
        afterSeed.clear(); best.afterMap.forEach((v,k)=>afterSeed.set(k,v));
        used.add(`${best.s.id}:${best.ai}`);
    }
    return total;
}

let AX_COUNTER_EVAL_DEPTH = 0;

function axCounterEffectValue(p, src, f, ctx={}) {
    const key=cn(f[3]), units=axEffectUnits(p,src,f[2],ctx), amount=Math.max(0,Math.floor(+numOf(p,src,f[1]))||0);
    if(!key || !units.length || !amount) return 0;
    const changed=units.filter(u=>ownerAny(u)>=0);
    if(!changed.length) return 0;
    const baseline=amount*.08*changed.reduce((z,u)=>z+(ownerAny(u)==p?1:-1),0);
    /* Nested effect valuation uses a small intrinsic score instead of recursively searching the same engines. */
    if(AX_COUNTER_EVAL_DEPTH>0) return baseline;
    AX_COUNTER_EVAL_DEPTH++;
    try {
        const base=new Map(ctx._counterState||[]), after=new Map(base);
        changed.forEach(u=>{
            const k=axCtrKey(u,key), have=axCtrRead(u,key,{_counterState:base});
            after.set(k,have+amount);
        });
        let value=baseline;
        for(let side=0;side<2;side++) {
            if(!changed.some(u=>ownerAny(u)==side)) continue;
            const future=axCounterPotential(side,base,after,changed,key);
            value += (side==p ? 1 : -1) * future;
        }
        return value;
    } finally {
        AX_COUNTER_EVAL_DEPTH--;
    }
}

function axEvalFx(p, effects, src, ctx={}) {
    if(!Array.isArray(effects)) return 0;
    const state=ctx._counterState ? new Map(ctx._counterState) : new Map();
    const local={...ctx,_counterState:state};
    let value=0, removed=ctx.removed == null ? 0 : ctx.removed;
    for(const f of effects) {
        if(!Array.isArray(f)) continue;
        if(f[0]=='choose') {
            const opts=(f[1]||[]).map(alt=>axEvalFx(p,alt,src,{...local,removed,_counterState:new Map(state)}));
            value += Math.max(0,...opts) + (Array.isArray(f[2]) ? axEvalFx(p,f[2],src,{...local,removed,_counterState:new Map(state)}) : 0) + (Array.isArray(f[3]) ? axEvalFx(p,f[3],src,{...local,removed,_counterState:new Map(state)}) : 0);
        } else if(f[0]=='counter') {
            value += ctx.noCounterSynergy ? Math.max(0,+numOf(p,src,f[1])||0)*.08*axEffectUnits(p,src,f[2],local).length : axCounterEffectValue(p,src,f,local);
            axCounterApply(p,src,f,local);
        } else if(f[0]=='uncounter') {
            const got=axCounterApply(p,src,f,local);
            if(!ctx.forceRemoved) removed=got;
            value += axFx(p,f,src,{...local,removed});
        } else {
            value += axFx(p,f,src,{...local,removed});
        }
    }
    return value;
}

function axAbilityTrigger(a,tr) { return a && (a.tr==tr || (a.trs||[]).includes(tr)); }

function axTriggerBatchValue(side,tr,sources) {
    const SELF=['play','death','attack','defend','echo','block'];
    const excluded=['enter','aecho','aact','anyplay','ablock','aattack','adefend'];
    const localUsed=new Map(); let value=0;
    for(const source of sources) {
        const cards=SELF.includes(tr) ? (source ? [source] : []) : [...G.p[side].front,...G.p[side].vault].filter(s=>!(excluded.includes(tr)&&s===source));
        cards.forEach(s=>(s.ab||[]).forEach((a,ai)=>{
            if(!axAbilityTrigger(a,tr) || !ifOk(a.if,side,s) || (a.of && !(source && cardMatch(source,a.of)))) return;
            const lim=a.max>0?Math.floor(a.max):0, k=`${side}:${s.id}:${ai}`;
            const used=(s.tu||{})[ai]||0, local=localUsed.get(k)||0;
            if(lim && used+local>=lim) return;
            localUsed.set(k,local+1);
            value += axEvalFx(side,a.fx,s,{light:1,trigger:source}) * .82;
        }));
    }
    return value;
}

function axEventDelta(actor,event,sources) {
    const opp=1-actor;
    if(event=='play') return axTriggerBatchValue(actor,'anyplay',sources)-axTriggerBatchValue(opp,'oanyplay',sources);
    if(event=='enter') return axTriggerBatchValue(actor,'enter',sources)-axTriggerBatchValue(opp,'oenter',sources);
    if(event=='cast') return axTriggerBatchValue(actor,'cast',sources)-axTriggerBatchValue(opp,'ocast',sources);
    if(event=='echo') return axTriggerBatchValue(actor,'aecho',sources)-axTriggerBatchValue(opp,'oaecho',sources);
    if(event=='debtup') return axTriggerBatchValue(actor,'debtup',sources)-axTriggerBatchValue(opp,'odebtup',sources);
    if(event=='attack') return axTriggerBatchValue(actor,'attack',sources)+axTriggerBatchValue(actor,'aattack',sources)-axTriggerBatchValue(opp,'oattack',sources);
    return 0;
}

/* worth of playing a card from hand (p = its owner) */
function axCard(p, c, ctx={}) {
    const P = G.p[p];
    if (c.t == 'T') {
        let tv=axEvalFx(p,c.fx||[],c,c.e>0?{...ctx,echoDebt:c.e}:ctx);
        tv += axEventDelta(p,'play',[c]);
        tv += axEventDelta(p,'cast',[c]);
        if(c.e>0) {
            tv += axEvalFx(p,(c.ab||[]).filter(a=>a.tr=='echo').flatMap(a=>a.fx||[]),c,ctx);
            tv += axEventDelta(p,'echo',[c]);
            tv += axEventDelta(p,'debtup',[c]);
        }
        return tv;
    }
    let v = 0;
    if (c.t == 'U')
        v += (c.a + (c.fx || []).reduce( (s, f) => s + (f[0] == 'buff' && f[2] == 'self' ? f[1] * (f[3] == 'others' ? P.front.length : 1) : 0), 0)) * 1.1 + (c.h + (c.fx || []).reduce( (s, f) => s + (f[0] == 'hp' && f[2] == 'self' ? f[1] * (f[3] == 'others' ? P.front.length : 1) : 0), 0)) * .8 + axKw(c) + .9;
    else
        v += 1;
    v += axEvalFx(p,c.fx||[],c,c.e>0?{...ctx,echoDebt:c.e}:ctx);
    /* Existing board engines can respond to this play/entry. A card can be valuable—or dangerous—to play because of those responses. */
    v += axEventDelta(p,'play',[c]);
    if(c.t=='U') v += axEventDelta(p,'enter',[c]);
    if(c.e>0) {
        v += axEvalFx(p,(c.ab||[]).filter(a=>a.tr=='echo').flatMap(a=>a.fx||[]),c,ctx);
        v += axEventDelta(p,'echo',[c]);
        v += axEventDelta(p,'debtup',[c]);
    }
    /* a Relic that works when YOUR Units die / enter does nothing on an empty board: worth little until the Units are there */
    const brd = Math.max(.25, Math.min(1, P.front.length / 2));
    (c.ab || []).filter(a => a.tr != 'passive' && a.tr != 'flash').forEach(a => {
        if(a.tr=='echo' && !(c.e>0)) return;
        const m = (a.tr == 'act' ? .6 : (a.tr == 'play' ? 1 : AX_TM[a.tr] || .3)) * (c.t == 'R' && (a.tr == 'ally' || a.tr == 'enter') ? brd : 1) * (a.tr=='play' ? 1 : .4);
        v += axEvalFx(p,a.fx||[],c,ctx) * m * (G.turn > 14 && a.tr != 'play' ? .6 : 1)
    }
    );
    /* the engine of my own deck: worth playing first (axPlayEng) */
    v += axPlayEng(p, c);
    v += axChain(p, c);
    v += axBlockerNeed(p, c);
    /* a Unit the opponent already sent back to the hand (bounced) is likely to be sent back again: replaying it wastes the Lume */
    if (c.t == 'U' && c.bn)
        v /= 1 + .6 * c.bn;
    return v
}

/* ---- AXIOM SAFETY: Life-for-Lume, Payday life floor, opponent debt transfer ---- */
const AX_LIFE_FLOOR = 5;
const AX_MARGIN = 3;

/* FAIR PLAY. false (default): Axiom plays with what a human sees: the opponent's board, vault, Lume, Life, Echo Debt and the NUMBER of cards in its hand and
   Logistic. It never reads what is IN the opponent's hand or Logistic; what it cannot see it only guesses (AX_GUESS_*).
   true = cheating mode, only for testing: it also counts the debt-moving cards in the opponent's hand and Logistic. */
const AX_KNOWS_DECK = false;
/* the guess for an unseen hand: each card the opponent can pay for (about AX_GUESS_COST Lume each) adds about AX_GUESS_ECHO Echo Debt */
const AX_GUESS_COST = 3;
const AX_GUESS_ECHO = 2;

const axFxList = c => (c.fx || []).concat(...(c.ab || []).filter(a => a.tr == 'play' || a.tr == 'enter' || a.tr == 'act' || a.tr == 'flash').map(a => a.fx || [])).filter(Array.isArray);

/* Life a card makes its owner pay ('dmg' to 'me'); cards with an 'or' choice are not counted */
const axSelfLife = c => (c.fx || []).includes('or') ? 0 : (c.fx || []).filter(f => Array.isArray(f) && f[0] == 'dmg' && f[2] == 'me' && typeof f[1] == 'number').reduce( (s, f) => s + f[1], 0);

const axLumeGain = c => ((c.fx || []).includes('or') ? 0 : (c.fx || []).filter(f => Array.isArray(f) && f[0] == 'lume' && typeof f[1] == 'number').reduce( (s, f) => s + f[1], 0)) + (c.t == 'T' ? 0 : (c.ab || []).filter(a => a.tr == 'play' && !(a.fx || []).includes('or')).reduce( (t, a) => t + (a.fx || []).filter(f => Array.isArray(f) && f[0] == 'lume' && typeof f[1] == 'number' && f[1] > 0).reduce( (q, f) => q + f[1], 0), 0));

/* Echo Debt the opponent can push onto p at its next turn: debt-moving effects on its board/vault, plus (only in the cheating test mode AX_KNOWS_DECK) the best one still in its hand/logistic */
function axDebtThreat(p, soft) {
    const O = G.p[1 - p];
    /* numeric movers (Overcharge: transfer 6) ADD UP: two of them in one turn is normal. A variable mover (Recycler: "up to X, X = your Echo Debt")
       moves everything the opponent has piled up, so it counts as the Echo Debt the opponent can hold by then. */
    const isVar = f => f[0] == 'debt' && f[2] == 'opp' && f[1] == 'debt';
    const num = c => axFxList(c).filter(f => f[0] == 'debt' && f[2] == 'opp' && typeof f[1] == 'number').reduce( (s, f) => s + f[1], 0);
    const hasVar = c => axFxList(c).some(isVar);
    const seen = [...O.front, ...O.vault, ...(AX_KNOWS_DECK ? O.hand : [])];
    const selfDebt = c => (c.ab || []).filter(a => a.tr == 'act').reduce( (s, a) => s + costOf(a).filter(x => x[0] == 'debt' && x[2] == 'me' && typeof x[1] == 'number').reduce( (r, x) => r + x[1], 0), 0);
    const ents = seen.filter(c => num(c) > 0).map(c => ({
        n: num(c),
        s: selfDebt(c)
    }));
    let anyVar = seen.some(hasVar);
    /* soft = only what is already visible (board, vault, hand); the not-yet-drawn Logistic is left out */
    if (AX_KNOWS_DECK && !soft) {
        const top = O.deck.filter(c => num(c) > 0).sort( (a, b) => num(b) - num(a))[0];
        if (top)
            ents.push({
                n: num(top),
                s: selfDebt(top)
            });
        anyVar = anyVar || O.deck.some(hasVar)
    }
    ents.sort( (a, b) => b.n - a.n);
    /* a mover can only move the Echo Debt its owner holds (plus the debt it takes as its own cost) */
    let pool = axMaxDebtOf(1 - p, true)
      , t = 0;
    for (const e of ents.slice(0, 2)) {
        pool += e.s;
        const mv = Math.min(e.n, pool);
        t += mv;
        pool -= mv
    }
                    if (anyVar)
        t += Math.max(0, Math.min(pool, G.p[1 - p].life - 1));
    return Math.min(t, 22)
}

/* Echo Debt player q can hold at its next Payday: its debt now + the Echo of the cards in its hand it can pay for with next turn's Lume (cheapest first).
   blind = q is the OPPONENT: Axiom cannot see that hand, so it only uses what is public (Lume, debt, how many cards) and guesses the rest. */
function axMaxDebtOf(q, blind) {
    const Q = G.p[q];
    let budget = Q.lume + 1 + axIncome(q)
      , d = Q.debt || 0;
    if (blind && !AX_KNOWS_DECK)
        return d + Math.min(Q.hand.length, Math.floor(budget / AX_GUESS_COST)) * AX_GUESS_ECHO;
    [...Q.hand].filter(c => c.e > 0).sort( (a, b) => a.c - b.c).forEach(c => {
        if (c.c <= budget) {
            budget -= c.c;
            d += c.e
        }
    }
    );
    return d
}

            /* LUME / LIFE CHAIN of a set of cards played in the best order: Echo engines first ('aecho' = "whenever you play another card using Echo":
   Synthetic Lume +1 Lume, Recalculate / Prism Cutter / Oracle Array +Life). Each Echo card then pays for the next one, so a set can cost MORE
   than the Lume in hand. Returns null when the set cannot be paid, else {left: Lume left, heal: Life the triggers give}. a max: 1 trigger fires once per turn. */
function axSeq(p, setC) {
    const P = G.p[p], num = v => typeof v == 'number' ? v : 0, trig = [];
    const addEng = c => (c.ab || []).forEach( (a, ix) => {
        if (a.tr != 'aecho')
            return;
        const L = (a.fx || []).filter(Array.isArray), lume = L.filter(f => f[0] == 'lume').reduce( (t, f) => t + num(f[1]), 0), heal = L.filter(f => f[0] == 'heal' && f[2] == 'me').reduce( (t, f) => t + num(f[1]), 0);
        if (lume || heal)
            trig.push({lume, heal, once: a.max == 1, used: !!(c.tu || {})[ix]})
    }
    );
    [...P.front, ...P.vault].forEach(addEng);
    const isEng = c => (c.ab || []).some(a => a.tr == 'aecho');
    let L = P.lume, heal = 0, gained = 0;
    /* a card that gives Lume back when it is played goes first: it can pay for the card after it (a Lume enabler, then the engine it was saving for) */
    for (const c of [...setC].sort( (x, y) => isEng(y) - isEng(x) || (axLumeGain(y) > 0) - (axLumeGain(x) > 0) || x.c - y.c)) {
        if (L < c.c)
            return null;
        L -= c.c;
        const g = axLumeGain(c);
        L += g;
        gained += g;
        if (c.e > 0)
            for (const t of trig) {
                if (t.once && t.used)
                    continue;
                L += t.lume;
                heal += t.heal;
                if (t.once)
                    t.used = true
            }
        addEng(c)
    }
    /* left does NOT include the Lume the set itself gives back (the callers add it as lg) */
    return {left: L - gained, heal}
}

/* DEBT DUMP PLAN: the movers p can fire THIS turn (ready on the board / vault, or in the set of cards about to be played: a Recycler works the turn it is played).
   Order: numbers first (Overcharge takes 5 and moves 6, so it is nearly free), the variable one last (Recycler moves EVERYTHING that is left).
   Returns gross = Echo Debt that lands on the opponent, remain = own debt that stays, life = Life the movers cost. */
function axDumpPlan(p, set, debtAfter) {
    try {
        const P = G.p[p]
          , L = []
          , num = v => typeof v == 'number' ? v : 0;
        const add = (a, fresh) => {
            const fx = (a.fx || []).filter(f => f[0] == 'debt' && f[2] == 'opp');
            if (!fx.length)
                return;
            const cs = costOf(a);
            if (cs.some(c => !((c[0] == 'debt' || c[0] == 'dmg') && c[2] == 'me') && !(c[0] == 'destroy' && c[2] == 'self') && !(c[0] == 'return' && c[2] == 'self') && !(isRestC(c) && !fresh)))
                return;
            if (fresh && cs.some(isRestC))
                return;
            L.push({
                lc: cs.filter(c => c[0] == 'dmg' && c[2] == 'me').reduce( (t, c) => t + num(c[1]), 0),
                self: cs.filter(c => c[0] == 'debt' && c[2] == 'me').reduce( (t, c) => t + num(c[1]), 0),
                isVar: fx.some(f => f[1] == 'debt'), n: fx.reduce( (t, f) => t + num(f[1]), 0), lcVar: cs.some(c => c[0] == 'dmg' && c[1] == 'debt' && c[2] == 'me'), payoff: (a.fx || []).filter(f => f[0] == 'pay' && (!f[2] || f[2] == 'me')).reduce( (t, f) => t + num(f[1]), 0)})
        };
        for (const u of [...P.front, ...P.vault])
            for (const a of acts(u))
                if (canAct(p, u, a))
                    add(a, false);
        for (const c of set || [])
            for (const a of (c.ab || []).filter(a => a.tr == 'act'))
                add(a, true);
        L.sort( (x, y) => x.isVar - y.isVar || y.n - x.n);
        let pool = debtAfter
          , gross = 0
          , life = P.life
          , paid = 0
          , events = 0;
                            for (const e of L) {
            /* the new Recycler costs Life equal to the Echo Debt you hold when it fires: it can never move more debt than your Life allows */
            const lcNow = e.lcVar ? pool + e.self : e.lc;
            if (life - lcNow < 1)
                continue;
            life -= lcNow;
            paid += lcNow;
            pool += e.self;
            const m = e.isVar ? pool : Math.min(e.n, pool);
            gross += m;
            if (m > 0)
                events++;
            pool -= m;
            if (e.payoff)
                pool = Math.max(0, pool - e.payoff)
        }
        return {
            gross,
            remain: pool,
            life: paid,
            events
        }
    } catch (e) {
        return {
            gross: 0,
            remain: debtAfter,
            life: 0
        }
    }
}

const axDumpCap = (p, set, debtAfter) => Math.max(0, debtAfter - axDumpPlan(p, set, debtAfter).remain);

/* The next mover to fire right now (after all cards are played): it must spring the Payday trap, or move a real amount. Overcharge first (also gives Evasion before the attack), Recycler last. */
function axDumpStep() {
    try {
        const P = G.p[ME]
          , O = G.p[OP]
          , pay = O.lume + axExtractIncome(OP)
          , L = []
          , num = v => typeof v == 'number' ? v : 0;
        for (const u of [...P.front, ...P.vault])
            for (const [i,a] of acts(u).entries()) {
                if (!canAct(ME, u, a))
                    continue;
                const fx = (a.fx || []).filter(f => f[0] == 'debt' && f[2] == 'opp');
                if (!fx.length)
                    continue;
                const cs = costOf(a);
                if (cs.some(c => !((c[0] == 'debt' || c[0] == 'dmg') && c[2] == 'me') && !(c[0] == 'destroy' && c[2] == 'self') && !(c[0] == 'return' && c[2] == 'self') && !isRestC(c)))
                    continue;
                const isVar = fx.some(f => f[1] == 'debt');
                L.push({
                    u,
                    i,
                    isVar,
                    n: isVar ? 1e9 : fx.reduce( (t, f) => t + numOf(ME, u, f[1]), 0),
                    lc: cs.filter(c => c[0] == 'dmg' && c[2] == 'me').reduce( (t, c) => t + num(c[1]), 0), lcVar: cs.some(c => c[0] == 'dmg' && c[1] == 'debt' && c[2] == 'me'), self: cs.filter(c => c[0] == 'debt' && c[2] == 'me').reduce( (t, c) => t + num(c[1]), 0)})
            }
        L.sort( (x, y) => x.isVar - y.isVar || y.n - x.n);
        for (const e of L) {
            const lcNow = e.lcVar ? (P.debt || 0) + e.self : e.lc;
            if (P.life - lcNow < 1)
                continue;
            const moved = Math.min(e.n, (P.debt || 0) + e.self), oDebt = (O.debt || 0) + moved, spring = oDebt > pay;
            if (e.lcVar) {
                /* paying Life for the dump is a 1:1 trade: only when it kills, or when it springs the Payday cliff and leaves us ahead in Life */
                if (moved > 0 && (oDebt - pay >= O.life || (spring && P.life - lcNow > O.life - Math.max(0, oDebt - pay))))
                    return e;
                continue
            }
            if (moved > 0 && (spring || moved >= 3))
                return e
        }
    } catch (e) {}
    return null
}

/* DEBT KILL: can the debt movers p can fire THIS turn make the opponent's NEXT Payday lethal? The opponent pays first (its Payday is the start of its turn),
   so its Life can run out before p's own Payday ever happens: Astronav wins by moving Echo Debt, not by Unit power. */
function axDebtKill(p) {
    try {
        const P = G.p[p]
          , Q = G.p[1 - p];
        let pool = P.debt || 0
          , mv = 0
          , myLife = P.life;
        const L = [];
        for (const u of [...P.front, ...P.vault])
            for (const a of acts(u)) {
                if (!canAct(p, u, a) || !(a.fx || []).some(f => f[0] == 'debt' && f[2] == 'opp'))
                    continue;
                const cs = costOf(a);
                if (cs.some(c => !((c[0] == 'debt' || c[0] == 'dmg') && c[2] == 'me') && !isRestC(c) && !(c[0] == 'destroy' && c[2] == 'self') && !(c[0] == 'return' && c[2] == 'self')))
                    continue;
                L.push({u, a, lcVar: cs.some(c => c[0] == 'dmg' && c[1] == 'debt' && c[2] == 'me'), self: cs.filter(c => c[0] == 'debt' && c[2] == 'me').reduce( (t, c) => t + Math.abs(numOf(p, u, c[1])), 0),
                    life: cs.filter(c => c[0] == 'dmg' && c[2] == 'me').reduce( (t, c) => t + Math.abs(numOf(p, u, c[1])), 0)
                })
            }
                            L.sort( (x, y) => (x.lcVar - y.lcVar) || x.self - y.self);
        for (const e of L) {
            const lcNow = e.lcVar ? pool + e.self : e.life;
            if (myLife - lcNow <= 0)
                continue;
            myLife -= lcNow;
            pool += e.self;
            const isV = e.a.fx.some(f => f[0] == 'debt' && f[1] == 'debt' && f[2] == 'opp'), n = isV ? pool : e.a.fx.filter(f => f[0] == 'debt' && f[2] == 'opp').reduce( (t, f) => t + numOf(p, e.u, f[1]), 0), m = Math.min(n, pool);
            mv += m;
            pool -= m;
            pool = Math.max(0, pool - e.a.fx.filter(f => f[0] == 'pay' && (!f[2] || f[2] == 'me')).reduce( (t, f) => t + (typeof f[1] == 'number' ? f[1] : 0), 0))
        }
        const loss = (Q.debt || 0) + mv
          , pay = ECHO_PAYS_LIFE ? 0 : Q.lume + axExtractIncome(Q === G.p[OP] ? OP : ME);
        return mv > 0 && loss - pay >= Q.life
    } catch (e) {
        return false
    }
}

/* After paying lifeCost Life and taking addDebt more Echo Debt, with `leftover` Lume still unspent: would the next Payday leave Axiom above the life floor? */
function axLifeSafe(p, lifeCost, addDebt, leftover, ownOnly, set) {
    const P = G.p[p];
    /* going for the kill: when its Units can finish the opponent this turn, Axiom spends whatever it takes */
    if (P.front.reduce( (t, u) => t + A(p, u), 0) >= G.p[1 - p].life || axDebtKill(p))
        return true;
    /* DESPERATION: when the visible army kills me next turn through every blocker I have, the Payday that comes AFTER that attack cannot matter: anything that could
       help (a body to block, removal, a Lume engine) is allowed. log39: at 1 Life it passed three turns in a row with 2 Lume and 7 cards, "safe from Payday". */
    {
        const ck = axClock(p);
        if (ck.through > 0 && ck.through >= P.life)
            return true
    }
    /* ownOnly = the fallback: only the debt Axiom takes itself is counted, not the worst case the opponent could push on it.
       Axiom cannot stop that debt by sitting still, and a deck made of Echo cards would otherwise never be allowed to play anything. */
    /* NO MARGINS: Astronav lives on risk and reward. Only a play that is CERTAIN death against what is already visible is refused. */
    const own = (P.debt || 0) + addDebt
      , pj = Math.max(0, own - axDumpCap(p, set, own)) + (ownOnly ? 0 : axDebtThreat(p, true));
    /* a low-life Axiom keeps a margin: it no longer gambles its last Life on the Payday */
    return P.life - lifeCost - Math.max(0, pj - axPayAvail(p, leftover)) >= (P.life <= 10 ? AX_MARGIN : 1)
}

/* How much of the Lume that card c makes can Axiom really SPEND this turn on the rest of its hand (or does it reach a Lume Victory goal)? */
function axLumeUse(p, c) {
    const P = G.p[p]
      , n = axLumeGain(c)
      , base = P.lume - c.c;
    if (n <= 0 || base < 0)
        return n;
    if (base + n >= lumeGoal(P))
        return n;
    const others = P.hand.filter(h => h !== c && !(axSelfLife(h) && axLumeGain(h)) && meetsTrigger(p, h) && !axDeckUnsafe(p, h) && axCard(p, h) >= (h.t == 'T' ? 1.8 : .5)).map(h => h.c).filter(x => x > 0).sort( (a, b) => a - b).slice(0, 8);
    let best = 0;
    for (let m = 1; m < 1 << others.length; m++) {
        let t = 0;
        others.forEach( (x, i) => {
            if (m >> i & 1)
                t += x
        }
        );
        if (t <= base + n && t > best)
            best = t
    }
    return Math.min(n, Math.max(0, best - base))
}

/* a Life-for-Lume card (Blood Siphon, Tithe) is only cast when at least 1 Lume per Life paid can actually be used */
const axLumeWorth = (p, c) => !(c.t == 'T' && axSelfLife(c) && axLumeGain(c)) || axLumeUse(p, c) >= axSelfLife(c);

function axMain(m2) {
    const P = G.p[ME];
    /* choose the best SET of cards for this Lume (a small knapsack), then play the engine / removal card of that set first.
       Echo debt is only taken for a small gap, because Payday costs Life when the Lume is not there next turn. */
    const OBJ = axObjective(ME);
    const cand = P.hand.filter(c => worth(ME, c) && !axDeckUnsafe(ME, c) && axLumeWorth(ME, c) && !(pk(c) && !pickList(ME, pickOf(c)).length)).map(c => ({
        c,
        v: axCard(ME, c) + (OBJ.bonus[c.id] || 0)
    })).filter(x => x.v >= (x.c.t == 'T' ? 1.8 : .5)).sort( (a, b) => b.v - a.v).slice(0, axDebtKill(ME) ? 0 : 10);
    /* income per turn (Lume engines in play + the 1 Lume every turn): used to decide whether borrowing can be paid back and whether to SAVE */
    const inc = 1 + axIncome(ME);
    if (axDebtKill(ME) && AX_KILL_T !== G.turn) {
        AX_KILL_T = G.turn;
        mlog('AI DEBT KILL: its debt movers make your next Payday lethal, firing them first')
    }
    /* the best SET for this Lume. reserve = Lume that must stay unspent (saving for a better card next turn, no borrowing then) */
    const pick = (reserve, relax, surv) => {
        let bt = null;
        for (let m = surv ? 0 : 1; m < 1 << cand.length; m++) {
            let cost = 0
              , val = 0
              , dbt = 0
              , lf = 0
              , lg = 0;
            const setC = [];
            cand.forEach( (x, k) => {
                if (m >> k & 1) {
                    setC.push(x.c);
                    cost += x.c.c;
                    val += x.v;
                    lf += axSelfLife(x.c);
                    lg += axLumeGain(x.c);
                    /* a card with Echo always takes its Echo value as Debt */
                    dbt += x.c.e ? Math.min(x.c.e, x.c.c0 == null ? x.c.c : x.c.c0) : 0
                }
            }
            );
                                    const sq = axSeq(ME, setC), need = 0;
            if (!sq || (reserve && sq.left + lg < reserve))
                continue;
            /* objective 'enable-next': a set with the enabler must leave the Lume that pays the engine next turn */
            if (OBJ.keep && OBJ.eid != null && setC.some(c => c.id === OBJ.eid) && sq.left + lg < OBJ.keep)
                continue;
            /* every card played with Echo is one debt event that the opponent's 'odebtup' engines (Sinner) turn into counters */
            const fd = AX_FEED_W * setC.reduce( (t, c) => t + (c.e ? axDebtFeed(ME, 'me', Math.min(c.e, c.c0 == null ? c.c : c.c0)) + axOwnDumpFeed(ME, 'debtup', Math.min(c.e, c.c0 == null ? c.c : c.c0), setC) : 0) + axOwnDumpFeed(ME, 'anyplay', 0, setC), 0);
            /* never pay Life or take Echo Debt that the next Payday (own debt + debt the opponent can move onto us) could turn into a lethal loss of Life */
            const left = sq.left + lg;
            if (!surv && (lf > 0 || dbt > 0) && !axLifeSafe(ME, lf - sq.heal, dbt, left, relax, setC))
                continue;
            if (surv) {
                /* SURVIVAL: no set passes the worst-case check, so pick the set with the smallest EXPOSURE at the next Payday
                   (own debt + new debt + the debt the opponent can already see-push, against the Lume that can pay it). Playing nothing is allowed. */
                const ownD = (P.debt || 0) + dbt
                  , prj = Math.max(0, ownD - axDumpCap(ME, setC, ownD)) + axDebtThreat(ME, true)
                  , pay = axPayAvail(ME, left)
                  , loss = Math.max(0, prj - pay)
                  , lw2 = P.life > 25 ? 1 : P.life > 12 ? 1.4 : 2;
                let ss = val - fd - (loss + lf - sq.heal) * lw2 + (cost - need) * .3;
                if (P.life + sq.heal - lf - loss <= 0)
                    ss -= 1000;
                else if (P.life + sq.heal - lf - loss < AX_LIFE_FLOOR)
                    ss -= 6;
                if (!bt || ss > bt.sc)
                    bt = {
                        sc: ss,
                        m
                    };
                continue
            }
            /* Payday takes (debt - Lume) as Life. The debt is cheap while the Lume left over + next turn's income
               can pay it, and only the EXTRA Life this set would cost (compared with doing nothing) is charged. */
            const off = axDumpCap(ME, setC, (P.debt || 0) + dbt)
              , dEff = Math.max(0, dbt - off)
              , tot = Math.max(0, (P.debt || 0) + dbt - off)
              , avl = axPayAvail(ME, left)
              , lw = P.life > 25 ? 1 : P.life > 12 ? 1.4 : 2.5
              , extra = Math.max(0, tot - avl) - Math.max(0, (P.debt || 0) - (ECHO_PAYS_LIFE ? 0 : P.lume + inc - 1));
            const sc = val - fd - (tot <= avl ? dEff * .7 : Math.max(0, extra) * lw + dEff * .7) + (cost - need) * .25;
            if (!bt || sc > bt.sc)
                bt = {
                    sc,
                    m
                }
        }
        return bt
    }
    ;
    /* STORM: play the Echo cards that stack the MOST debt (each costs ~1 Lume and feeds the Lume / Life engines), then dump it all on the opponent.
       The Payday costs the opponent (its debt - its Lume) as Life. No safety margins: the line that hurts most wins. */
    const storm = () => {
        const O = G.p[OP]
          , pay = ECHO_PAYS_LIFE ? 0 : O.lume + axExtractIncome(OP);
        let bt = null;
        for (let m = 1; m < 1 << cand.length; m++) {
            let cost = 0
              , val = 0
              , dbt = 0
              , lf = 0
              , lg = 0;
            const setC = [];
            cand.forEach( (x, k) => {
                if (m >> k & 1) {
                    setC.push(x.c);
                    cost += x.c.c;
                    val += x.v;
                    lf += axSelfLife(x.c);
                    lg += axLumeGain(x.c);
                    dbt += x.c.e ? Math.min(x.c.e, x.c.c0 == null ? x.c.c : x.c.c0) : 0
                }
            }
            );
                                    const sq = axSeq(ME, setC);
            if (!sq)
                continue;
            const pl = axDumpPlan(ME, setC, (P.debt || 0) + dbt);
            if (pl.gross <= 0)
                continue;
            const left = sq.left + lg, oDebt = (O.debt || 0) + pl.gross
              , oLoss = Math.max(0, oDebt - pay)
              , mine = Math.max(0, pl.remain - axPayAvail(ME, left));
            if (oLoss <= 0 || P.life + sq.heal - lf - pl.life - mine < 1)
                continue;
            /* the dump is several debt events (one per move), and each one fires the opponent's 'debtup' engine again with a bigger debt: add them one by one.
               The cards played with Echo and the AI's own debt movers add more events. */
            const ev = Math.max(1, pl.events || 1);
            let fo = 0;
            for (let i = 1; i <= ev; i++)
                fo += axDebtFeed(ME, 'opp', Math.round(pl.gross * i / ev));
            const feed = oLoss >= O.life ? 0 : AX_FEED_W * (fo + setC.reduce( (t, c) => t + (c.e ? axDebtFeed(ME, 'me', Math.min(c.e, c.c0 == null ? c.c : c.c0)) + axOwnDumpFeed(ME, 'debtup', Math.min(c.e, c.c0 == null ? c.c : c.c0), setC) : 0) + axOwnDumpFeed(ME, 'anyplay', 0, setC), 0));
            /* a Life point the opponent GAINS is worth as much as one it LOSES: both count x3 here (before, only the loss did, so the AI fed engines it should have feared) */
            const sc = (oLoss >= O.life ? 1e6 : (ECHO_PAYS_LIFE ? pl.gross : oLoss) * 3) - feed * 3 - mine * 1.5 - (lf + pl.life) * 1.5 + sq.heal * 1.2 + val * .35 + cost * .2;
            if (!bt || sc > bt.sc)
                bt = {
                    sc,
                    m,
                    oLoss,
                    feed,
                    gross: pl.gross,
                    names: setC.map(c => c.n).join(' + ')
                }
        }
        return bt
    }
    ;
    /* never sit idle because the worst-case check refused every set: fall back to the own-debt-only check */
    const pickAny = r => pick(r) || pick(r, false, true);
    const sb0 = storm()
      , sb = sb0 && (sb0.sc > 0 || !sb0.feed) ? sb0 : null;
    let best = sb || pickAny(0);
    if (sb && AX_KILL_T !== 's' + G.turn) {
        AX_KILL_T = 's' + G.turn;
        mlog(`AI STORM: plays ${sb.names}, then dumps ${sb.gross} Echo Debt -> you lose ${sb.oLoss} Life at Payday (you hold ${G.p[OP].lume} Lume)`)
    }
    if (AX_PLAN_T !== G.turn) {
        AX_PLAN_T = G.turn;
        mlog(`AI PAYDAY PLAN: own debt ${P.debt || 0}, opponent can push up to ${axDebtThreat(ME)} (visible ${axDebtThreat(ME, true)}), Lume that can pay at Payday ~${axPayAvail(ME, P.lume)}, life ${P.life} -> ${pick(0) ? 'safe plays exist' : 'no safe play: survival mode'}`)
    }
    /* SAVING: a strong card that is 1-2 turns away beats a pile of cheap plays now (otherwise a 1 Lume-per-turn economy never casts anything above 2 cost) */
    const pw = G.p[OP].front.reduce( (t, u) => t + A(OP, u), 0);
    if (!sb && P.life > 8 && P.lume > 0 && pw < P.life - 5) {
        const top = P.hand.filter(c => c.t != 'T' && c.c > P.lume && c.c <= P.lume + 2 * inc && !axDeckUnsafe(ME, c) && meetsTrigger(ME, c)).map(c => ({
            c,
            v: axCard(ME, c)
        })).filter(x => x.v >= 5).sort( (a, b) => b.v - a.v)[0];
        if (top && top.v > (best ? best.sc : 0) * 1.3) {
            mlog(`AI SAVES Lume for ${top.c.n} (value ${top.v.toFixed(1)}, cost ${mlCost(top.c)}) instead of playing for ${best ? best.sc.toFixed(1) : 0}`);
            best = pickAny(Math.max(0, top.c.c - inc))
        }
    }
    if (best && !best.m)
        best = null;
    if (best) {
        const set = cand.filter( (x, i) => best.m >> i & 1)
          , gain = c => (c.fx || []).concat(...(c.ab || []).filter(a => a.tr == 'play').map(a => a.fx)).reduce( (s, f) => s + (f[0] == 'lume' && typeof f[1] == 'number' ? f[1] : 0), 0) - c.c;
        set.sort( (a, b) => ((b.c.ab || []).some(q => q.tr == 'aecho') - (a.c.ab || []).some(q => q.tr == 'aecho')) || (axPlayEng(ME, b.c) > 4) - (axPlayEng(ME, a.c) > 4) || gain(b.c) - gain(a.c) || (b.c.t == 'T') - (a.c.t == 'T') || b.v - a.v);
        const c = set[0].c;
        play(ME, c, pk(c) ? aiPickC(ME, c) : 0);
        render();
        return aiLater( () => ai(m2), 1800)
    }
    const ds = axDumpStep();
    if (ds) {
        mlog(`AI DUMP: fires a debt mover, ${G.p[OP].lume} Lume on your side to pay it`);
        activate(ME, ds.u, ds.i);
        render();
        return aiLater( () => ai(m2), 1800)
    }
    let ba = null;
    for (const u of [...P.front, ...P.vault])
        for (const [i,a0] of acts(u).entries())
        for (const [a,X] of xVariants(ME, u, a0)) {
            if (!canAct(ME, u, a) || axDeckUnsafe(ME, {
                t: 'A',
                fx: a.fx,
                ab: []
            }))
                continue;
            let cost = 0
              , ok = 1
              , dme = 0;
            costOf(a).forEach( ([ty,n0,tg]) => {
                const n = Math.abs(numOf(ME, u, n0)) || 1;
                if (isRestC([ty, n0]))
                    cost += u.st == 'S' && !m2 ? A(ME, u) * 1.4 + .6 : .3;
                else if (ty == 'lume' && numOf(ME, u, n0) < 0)
                    P.lume < n ? ok = 0 : cost += n * 1.1;
                else if (ty == 'dmg' && tg == 'me')
                    P.life <= n + 4 ? ok = 0 : cost += n * (P.life < 10 ? 3 : 1.2);
                else if (ty == 'discard')
                    /* the computer throws away its cheapest cards: a full hand pays almost nothing, a thin hand pays for what it loses */
                    P.hand.length <= n ? ok = 0 : cost += n * (P.hand.length >= 7 ? .3 : P.hand.length >= 4 ? .9 : 2);
                else if (ty == 'mill')
                    /* sending cards of its own Logistic to the Wasteland: free while the Logistic is full, never when it could run out */
                    P.deck.length <= n + 8 + 2 * axDrawEng(ME) ? ok = 0 : cost += n * .25;
                else if (ty == 'raze' && tg == 'self')
                    /* a Relic that sacrifices itself (Grave Altar): it loses what the Relic would still make */
                {
                    /* what the Relic would still make AFTER the sacrifice: its other abilities only. The ability being used (and any other self-sacrifice) is a ONE-TIME payoff,
                       it was counted as income every turn (Grave Altar: 5 Lume x act 2 = +10 per turn), so the cost always beat the 5 Lume and the AI never sacrificed it. */
                    /* The Lume of an 'ally' trigger (Unit destroyed) is judged by how often MY Units really die (axSwapRate) over the next ~3 turns, not as a flat income:
                       a deck that swaps Units fast keeps the Relic, a deck that hardly loses Units cashes it in (the 5 Lume are a one-time emergency resource). */
                    const noLume = q => q.tr == 'ally' ? {
                        ...q,
                        fx: (q.fx || []).filter(f => f[0] != 'lume')
                    } : q
                      , stays = {
                        ab: (u.ab || []).filter(q => q !== a0 && q !== a && !costOf(q).some( ([t2,,g2]) => (t2 == 'raze' || t2 == 'destroy') && g2 == 'self')).map(noLume)
                    }
                      , allyL = (u.ab || []).filter(q => q.tr == 'ally' && q !== a0 && q !== a).reduce( (t, q) => t + (q.fx || []).reduce( (r, f) => r + (f[0] == 'lume' && typeof f[1] == 'number' && f[1] > 0 ? f[1] : 0), 0), 0);
                    cost += 1.5 + u.c * .5 + (axEng(ME, stays) * 1.5 + allyL * axSwapRate(ME) * 3) * axThr(ME) * (axRelicThreat(ME) ? .3 : 1)
                }
                else if (ty == 'destroy' && tg == 'self')
                    cost += uVal(ME, u);
                else if (ty == 'uncounter')
                    cost += .6;
                else if ((ty == 'debt' || ty == 'adddebt') && tg == 'me')
                    /* Echo Debt taken as a cost: charged below, minus whatever the ability moves straight back onto the opponent (Overcharge) */
                    dme += n;
                else
                    ok = 0
            }
            );
            if (!ok || !meetsTrigger(ME, {
                t: 'T',
                fx: a.fx
            }))
                continue;
            const movedMax = a.fx.filter(f => f[0] == 'debt' && f[2] == 'opp').reduce( (s, f) => s + numOf(ME, u, f[1]), 0)
              , moved = Math.min(movedMax, (P.debt || 0) + dme)
              , keep = Math.max(0, dme - moved);
            if (keep > 0)
                P.life < 10 ? ok = 0 : cost += keep * 1.8;
            if (!ok)
                continue;
            /* judge the effects as they will be AFTER the cost has been paid (Overcharge: the 5 Debt it takes is what it then moves) */
            /* a SHADOW copy of the player carries the debt this ability would have: changing the real P.debt queues a real "debt rose" event
               and makes the AI's own Gravity Lock / Synthetic Lume / Overcharge fire for a play that was only being judged */
            const realP = G.p[ME];
            G.p[ME] = Object.create(realP, {debt: {value: (realP.debt || 0) + dme, writable: true, enumerable: true}});
            let v;
            try {
                v = axEvalFx(ME,a.fx,u,{}) - cost + axSpendBonus(ME, a.fx.reduce( (t, f) => t + (Array.isArray(f) && f[0] == 'lume' && typeof f[1] == 'number' && f[1] > 0 ? f[1] : 0), 0))
            } finally {
                G.p[ME] = realP
            }
            if (v >= 1.2 && (!ba || v > ba.v))
                ba = {
                    u,
                    i,
                    v,
                    X
                }
        }
    if (ba) {
        activate(ME, ba.u, ba.i, null, ba.X);
        render();
        return aiLater( () => ai(m2), 1800)
    }
    if (m2)
        return aiLater(endT, 1300);
    const at = axAttackers();
    if (!at.length)
        return aiLater(aiMain2, 1300);
    const H = G.p[OP].front.filter(u => u.st != 'R');
    return aiLaunch(at)
}

/* turns each side needs to kill the other if nothing changes */
function axClock() {
    const P = G.p[ME]
      , O = G.p[OP]
      , mine = P.front.reduce( (s, u) => s + A(ME, u), 0)
      , theirs = O.front.reduce( (s, u) => s + A(OP, u), 0);
    return {
        mine: mine ? Math.ceil(O.life / mine) : 99,
        theirs: theirs ? Math.ceil(P.life / theirs) : 99
    }
}

function axAttackers() {
    const rdy = G.p[ME].front.filter(u => u.st == 'S');
    if (!rdy.length)
        return [];
    try {
        return axAttackNew(rdy)
    } catch (e) {
        console.error('axAttack', e);
        return axAttackersOld()
    }
}

/* Which Units attack: every candidate group is played on paper against the opponent's BEST blocks (axBest),
   then the opponent's attack on the next turn is played against the Units left at home. The group with the best total wins. */
function axAttackNew(rdy) {
    /* a Unit with no ATK only rests (and cannot block) for nothing */
    rdy = rdy.filter(u => A(ME, u) > 0);
    if (axDrawEng(ME) && G.p[ME].deck.length <= 3 + 3 * axDrawEng(ME))
        rdy = rdy.filter(u => !hk(u, 'lifesteal'));
    if (!rdy.length)
        return [];
    const P = G.p[ME]
      , O = G.p[OP]
      , D = O.front.filter(u => u.st != 'R')
      , srt = [...rdy].sort( (a, b) => A(ME, b) + axKw(b) - A(ME, a) - axKw(a));
    /* lethal: even if the opponent blocks our biggest Units, the rest gets through */
    if (srt.slice(D.length).reduce( (s, u) => s + A(ME, u), 0) >= O.life)
        return rdy;
    /* (the Lume the opponent's death / ally engines make from dead Units is part of the score in axOutcome, no hard rule) */
    if (axRace(ME) && axFeed(OP) < 2)
        return rdy;
    const sets = new Map()
      , add = L => L.length && sets.set(L.map(u => u.id).sort().join(), L);
    add(srt);
    for (let k = 1; k < srt.length; k++)
        add(srt.slice(0, k));
    srt.slice(0, 8).forEach(u => {
        add([u]);
        add(srt.filter(x => x !== u))
    }
    );
    /* the Units whose attack fires a chain (their own 'attack' triggers, or other cards' 'aattack'): a group of them is always tried, alone and together */
    const chainU = srt.filter(u => axTriggerBatchValue(ME, 'attack', [u]) + axTriggerBatchValue(ME, 'aattack', [u]) > .5);
    if (chainU.length) {
        add(chainU);
        chainU.forEach(u => add([u]))
    }
    const cx1 = axCtx(ME)
      , cx2 = axCtx(OP)
      , tire = u => hk(u, 'tireless');
    const eva = S => {
        const home = P.front.filter(u => u.st != 'R' && (!S.includes(u) || tire(u)));
        /* the opponent's whole army attacks us next turn: what do we lose against the Units that stayed home? */
        const back = O.front.length ? Math.min(0, axBest(OP, O.front, home, cx2).v) : 0;
        const combat = S.length ? -(D.length ? axBest(ME, S, D, cx1).v : axOutcome(ME, S, {}, cx1)) : 0;
        const reactions = S.length ? axEventDelta(ME,'attack',S) : 0;
        return combat + reactions + back * .8
    }
    ;
    let best = {
        v: eva([]),
        S: []
    };
    const tried = [['none', best.v]];
    for (const S of sets.values()) {
        const v = eva(S) + S.length * .15;
        tried.push([S.map(u => u.n).join('+'), v]);
        if (v > best.v + .01)
            best = {
                v,
                S
            }
    }
    /* every option loses to the opponent's next attack: stop defending and hit as hard as possible, the best chance left */
    /* the Logistic is nearly empty: waiting loses by drawing from an empty Logistic, so hit as hard as possible while it still can */
    if (best.v < -1000 || (G.p[ME].deck.length <= 6 && G.p[OP].deck.length > G.p[ME].deck.length + 1)) {
        let bo = null;
        for (const S of [srt, ...sets.values()]) {
            const v = -(D.length ? axBest(ME, S, D, cx1).v : axOutcome(ME, S, {}, cx1));
            if (!bo || v > bo.v)
                bo = {
                    v,
                    S
                }
        }
        if (bo && bo.v > 0)
            best = bo
    }
    tried.sort( (a, b) => b[1] - a[1]);
    mlog(`AI ATTACK PLAN: chose ${best.S.map(u => u.n).join(' + ') || 'no attack'} (score ${best.v.toFixed(1)}); next best: ` + tried.slice(0, 4).map(t => `${t[0]} ${t[1].toFixed(1)}`).join(' ; '));
    return best.S
}

function axAttackersOld() {
    const P = G.p[ME]
      , O = G.p[OP]
      , rdy = P.front.filter(u => u.st == 'S');
    if (!rdy.length)
        return [];
    const D = O.front.filter(u => u.st != 'R')
      , srt = [...rdy].sort( (a, b) => A(ME, b) - A(ME, a));
    /* lethal: even if the opponent blocks our biggest Units, the rest gets through */
    const fd = axFeed(OP);
    if (srt.slice(D.length).reduce( (s, u) => s + A(ME, u), 0) >= O.life)
        return rdy;
    /* the opponent turns every Unit that dies into Lume (death / ally engines): attacking into its blockers only feeds it.
       Only attack when nothing can be blocked, or with a Unit that kills nothing (evasion); keep the rest home and hunt the engine instead. */
    if (fd >= 2)
        return rdy.filter(u => !D.length || hk(u, 'evasion'));
    if (axRace(ME))
        return rdy;
    const ok = u => {
        const hp = HPv(u) - u.dmg;
        return D.every(d => {
            if (hk(u, 'evasion') || !(A(OP, d) >= hp || hk(d, 'toxic')))
                return true;
            const dies = A(ME, u) >= HPv(d) - d.dmg || hk(u, 'toxic');
            return dies && uVal(OP, d) >= uVal(ME, u) * .85
        }
        )
    }
    ;
    let at = rdy.filter(ok);
    const ck = axClock();
    /* behind in the race: only attack with what is safe and keep every other Unit home */
    if (ck.theirs < ck.mine && ck.theirs <= 3)
        at = at.filter(u => D.length == 0 && P.front.filter(x => x.st != 'R').length > 1);
    /* do not leave the home empty when the opponent could hit back for most of our Life */
    const pow = O.front.map(u => A(OP, u)).sort( (a, b) => b - a);
    const risky = () => {
        const home = P.front.filter(u => u.st != 'R' && !at.includes(u) && !hk(u, 'tireless')).length + at.filter(u => hk(u, 'tireless')).length;
        return pow.slice(home).reduce( (s, x) => s + x, 0) >= P.life - 2
    }
    ;
    while (at.length && risky())
        at.splice(at.indexOf(at.reduce( (b, u) => A(ME, u) < A(ME, b) ? u : b)), 1);
    return at
}

/* ---------------- COMBAT SIMULATION (Axiom) ----------------
   axSim plays a whole combat on paper (nothing is changed): damage to blockers in the order chosen, Toxic, Evasion, Stomp, Lifesteal.
   axOutcome turns the result into ONE number for the DEFENDING side (Units killed / lost, Life lost, how close Life is to zero).
   axBest searches the blocks that give the defender the best number (every attacker tries "no block", each single blocker and each pair,
   several passes), so Axiom blocks / attacks by what really happens instead of one rule per card. */
/* what a Unit that dies pays out for its side: its own 'death' effects and the 'ally' effects of the other cards (apart from Lume, which axFeed counts) */
const axAllyPay = (side, u) => [...G.p[side].front, ...G.p[side].vault].reduce( (t, s) => t + (s.ab || []).filter(a => s !== u && axAbilityTrigger(a, 'ally') && ifOk(a.if, side, s) && !(a.of && !cardMatch(u, a.of))).reduce( (q, a) => q + Math.max(0, axEvalFx(side, (a.fx || []).filter(f => !(Array.isArray(f) && f[0] == 'lume')), s, {
    light: 1,
    trigger: u
})) * .82, 0), 0);
const axDeathPay = (side, u) => (axTriggerBatchValue(side, 'death', [u]) + axAllyPay(side, u)) * .8;

function axSim(a, at, pr) {
    const d = 1 - a
      , o = {
        life: 0,
        gain: 0,
        gainD: 0,
        dA: [],
        dD: [],
        sD: [],
        bl: []
    };
    at.forEach(u => {
        const x = A(a, u)
          , dfs = (pr[u.id] || []).map(i => byId[i]).filter(b => b && G.p[d].front.includes(b));
        if (!dfs.length) {
            o.life += x;
            if (hk(u, 'lifesteal'))
                o.gain += x;
            return
        }
        dfs.forEach(b => o.bl.includes(b) || o.bl.push(b));
        const ys = dfs.map(b => A(d, b))
          , evU = hk(u, 'evasion')
          , hit = dfs.filter(b => !hk(b, 'evasion'));
        let left = x;
        if (hk(u, 'toxic'))
            hit.forEach(b => o.dD.push(b));
        else
            hit.forEach( (b, i) => {
                const give = i == hit.length - 1 ? left : Math.min(left, Math.max(0, HPv(b) - b.dmg));
                if (b.dmg + give >= HPv(b))
                    o.dD.push(b);
                left -= give
            }
            );
        dfs.forEach(b => o.dD.includes(b) || o.sD.includes(b) || o.sD.push(b));
        if (!evU && (dfs.some(b => hk(b, 'toxic')) || u.dmg + ys.reduce( (t, y) => t + y, 0) >= HPv(u)))
            o.dA.push(u);
        if (hk(u, 'lifesteal') && hit.length)
            o.gain += x;
        if (!evU)
            dfs.forEach( (b, i) => hk(b, 'lifesteal') && (o.gainD += ys[i]));
        if (hk(u, 'stomp')) {
            o.life += x;
            if (hk(u, 'lifesteal'))
                o.gain += x
        }
    }
    );
    return o
}

const axLifeV = (l, k) => l <= 0 ? -1e4 + l * 20 : 9 * Math.log(1 + l) * k;

/* DEATH CLOCK of player d against the army its opponent has on the board (visible to both): how many turns d lives if nothing changes.
   Every untapped Unit of d stops ONE attacker (the biggest first), the rest gets through. An army with many tokens keeps GROWING (token makers, recruits),
   so every 4 tokens count as one more attacker next turn. urgency 0 = no danger (4+ turns), 1 = dead next turn. log39: with 12 Life against 8 tokens the old
   code saw "2 turns" but kept its own 1/1 back "for value" and died two turns later. */
function axClock(d) {
    const a = 1 - d
      , Pd = G.p[d]
      , Pa = G.p[a]
      , atk = Pa.front.map(u => A(a, u)).sort( (x, y) => y - x)
      , nBl = Pd.front.filter(u => u.st != 'R').length
      , toks = Pa.front.filter(u => u.tok).length
      , grow = toks >= 4 ? Math.floor(toks / 4) : 0
      , through = atk.slice(nBl).reduce( (t, x) => t + x, 0) + grow
      , clk = Pd.life / Math.max(1, through);
    return {
        through,
        clk,
        urgency: clk <= 1 ? 1 : clk >= 4 ? 0 : (4 - clk) / 3,
        next: atk[nBl] || 0
    }
}

function axCtx(a) {
    const d = 1 - a
      , uvC = new Map()
      , ck = axClock(d)
      /* a side that is about to die has no future: its Units are worth less than its Life (what a Unit could do in 3 turns means nothing if the Life is gone in 2) */
      , vs = 1 - .5 * ck.urgency
      , uv = (p, u) => {
        const k = p + ':' + u.id;
        let x = uvC.get(k);
        if (x === undefined)
            uvC.set(k, x = uVal(p, u) * (p === d ? vs : 1));
        return x
    }
    ;
    const pow = G.p[a].front.reduce( (s, u) => s + A(a, u), 0);
    /* FEED SCALE: not blocking "so the engine gets nothing" only makes sense while Life is not at stake. When the attackers' total ATK could take the defender's
       Life in about 2 turns or less the feeding penalty is switched off (0), it fades in up to 4 turns (1). A flood of tokens must be blocked, whatever it feeds. */
    /* only the ATK that can get PAST the blockers threatens Life: every blocker stops one attacker (the defender blocks the biggest first), so a wall of
       cheap tokens makes the clock infinite and feeding it is a real cost (log26: 7 tokens held back 5 attackers, the old clock still counted all their ATK) */
    const nBl = G.p[d].front.filter(u => u.st != 'R').length
      , through = G.p[a].front.map(u => A(a, u)).sort( (x, y) => y - x).slice(nBl).reduce( (t, x) => t + x, 0)
      , clk = G.p[d].life / Math.max(1, through)
      , fs = clk <= 2 ? 0 : clk >= 4 ? 1 : (clk - 2) / 2;
    /* the closer the attacker's total ATK is to the defender's Life, the more every point of Life is worth */
    return {
        uv,
        k: (1 + Math.min(2, pow / Math.max(1, G.p[d].life))) * (1 + 1.8 * ck.urgency),
        fA: Math.min(5, axFeed(a)) * 1.1 * fs,
        fD: Math.min(5, axFeed(d)) * 1.1 * fs,
        fs,
        tv: new Map()
    }
}

function axOutcome(a, at, pr, cx) {
    const d = 1 - a
      , s = axSim(a, at, pr)
      , Pd = G.p[d]
      , Pa = G.p[a];
    let v = s.dA.reduce( (t, u) => t + cx.uv(a, u), 0) - s.dD.reduce( (t, u) => t + cx.uv(d, u), 0);
    v += s.dD.length * cx.fD - s.dA.length * cx.fA;
    /* TRIGGER CHAINS, read from the cards: a blocker fires its 'defend' triggers when it is declared and its 'block' triggers when it survives; a Unit that dies pays
       out its death effect and the 'ally' effects of its side (the Lume part is already in fA / fD). A chain card that this attack FEEDS is a loss for the side that
       feeds it, a chain card of its own that it fires is a gain. (v is the defender's view: positive = good for the defender.) */
    const tv = (k, side, u, f) => {
        const key = k + side + ':' + u.id;
        let x = cx.tv.get(key);
        if (x === undefined)
            cx.tv.set(key, x = f());
        return x
    }
    ;
    s.bl.forEach(b => v += tv('d', d, b, () => axTriggerBatchValue(d, 'defend', [b]) + axTriggerBatchValue(d, 'adefend', [b]) - axTriggerBatchValue(a, 'odefend', [b])));
    s.sD.forEach(b => v += tv('s', d, b, () => axTriggerBatchValue(d, 'block', [b]) + axTriggerBatchValue(d, 'ablock', [b])));
    s.dD.forEach(u => v += tv('x', d, u, () => axDeathPay(d, u)));
    s.dA.forEach(u => v -= tv('x', a, u, () => axDeathPay(a, u) * cx.fs));
    const ld = Pd.life - s.life + s.gainD;
    v += axLifeV(ld, cx.k) - axLifeV(Pd.life, cx.k);
    v -= (s.gain ? 9 * Math.log(1 + Pa.life + s.gain) - 9 * Math.log(1 + Pa.life) : 0) * .8;
    return v
}

/* the best blocks for the side d (Units D) against the attackers `at` of side a: {pr, v} */
function axBest(a, at, D, cx) {
    cx = cx || axCtx(a);
    const seen = {}
      , cand = [];
    [...D].sort( (x, y) => cx.uv(1 - a, x) - cx.uv(1 - a, y)).forEach(u => {
        const k = [u.n, A(1 - a, u), HPv(u) - u.dmg, hk(u, 'toxic'), hk(u, 'evasion'), hk(u, 'lifesteal')].join('|');
        seen[k] = (seen[k] || 0) + 1;
        if (seen[k] <= 2)
            cand.push(u)
    }
    );
    /* a big board (tokens): keep the 6 cheapest (chump blockers) and the 6 best (real blockers) */
    if (cand.length > 12)
        cand.splice(6, cand.length - 12);
    const atk = [...at].sort( (x, y) => A(a, y) + axKw(y) - A(a, x) - axKw(x)).slice(0, 8);
    const score = pr => axOutcome(a, at, pr, cx);
    let pr = {}
      , best = score(pr);
    for (let pass = 0; pass < 3; pass++) {
        let ch = 0;
        for (const u of atk) {
            const other = new Set(Object.keys(pr).filter(k => +k != u.id).flatMap(k => pr[k]))
              , fr = cand.filter(x => !other.has(x.id))
              , opts = fr.map(x => [x.id]);
            const top = fr.slice(0, 6);
            for (let i = 0; i < top.length; i++)
                for (let j = i + 1; j < top.length; j++)
                    opts.push([top[i].id, top[j].id]);
            opts.unshift([]);
            for (const o of opts) {
                const t = Object.assign({}, pr);
                if (o.length)
                    t[u.id] = o;
                else
                    delete t[u.id];
                const s = score(t);
                if (s > best + 1e-9) {
                    best = s;
                    pr = t;
                    ch = 1
                }
            }
        }
        if (!ch)
            break
    }
    return {
        pr,
        v: best
    }
}

function axDef(at) {
    /* the simulated search first; the old rules stay as a fallback */
    try {
        const P = G.p[ME]
          , D = P.front.filter(d => d.st != 'R');
        if (!D.length)
            return {};
        return axBest(OP, at, D).pr
    } catch (e) {
        console.error('axDef', e);
        return axDefOld(at)
    }
}

function axDefOld(at) {
    const P = G.p[ME]
      , pr = {}
      , used = new Set()
      , ds = P.front.filter(d => d.st != 'R');
    const free = () => ds.filter(d => !used.has(d.id));
    const thr = u => A(OP, u) + axKw(u);
    const through = u => hk(u, 'stomp') ? A(OP, u) : pr[u.id] ? 0 : A(OP, u);
    [...at].sort( (a, b) => thr(b) - thr(a)).forEach(u => {
        let best = null;
        const ck = axClock()
          , hp = HPv(u) - u.dmg
          , w = A(OP, u) * (hk(u, 'stomp') ? 0 : P.life < 12 || ck.theirs <= 3 ? .9 : .45);
        free().forEach(d => {
            const kills = !hk(u, 'evasion') && (hk(d, 'toxic') || A(ME, d) >= hp)
              , lives = hk(d, 'evasion') || (!hk(u, 'toxic') && A(OP, u) < HPv(d) - d.dmg);
            const s = (kills ? uVal(OP, u) : 0) - (lives ? 0 : uVal(ME, d)) + w;
            if (s > .5 && (!best || s > best.s))
                best = {
                    s,
                    d: [d]
                }
        }
        );
        /* nobody kills it alone: two blockers together, only if at most one of them can die */
        if ((!best || best.s < uVal(OP, u) * .5) && uVal(OP, u) > 6 && !hk(u, 'toxic')) {
            const f = free();
            for (let i = 0; i < f.length; i++)
                for (let j = i + 1; j < f.length; j++) {
                    const a = f[i]
                      , b = f[j];
                    if (A(ME, a) + A(ME, b) < hp || A(OP, u) >= HPv(a) - a.dmg + HPv(b) - b.dmg)
                        continue;
                    const loss = A(OP, u) >= Math.min(HPv(a) - a.dmg, HPv(b) - b.dmg) ? Math.min(uVal(ME, a), uVal(ME, b)) : 0
                      , s = uVal(OP, u) - loss;
                    if (s > 2 && (!best || s > best.s))
                        best = {
                            s,
                            d: [a, b]
                        }
                }
        }
        if (best) {
            pr[u.id] = best.d.map(d => d.id);
            best.d.forEach(d => used.add(d.id))
        }
    }
    );
    /* never take a lethal hit: chump-block the biggest unblocked attackers with the cheapest Units */
    let inc = at.reduce( (s, u) => s + through(u), 0);
    while (inc >= P.life - 1 && free().length) {
        const u = at.filter(x => !pr[x.id]).sort( (a, b) => A(OP, b) - A(OP, a))[0];
        if (!u)
            break;
        const d = free().sort( (a, b) => uVal(ME, a) - uVal(ME, b))[0];
        pr[u.id] = [d.id];
        used.add(d.id);
        inc = at.reduce( (s, x) => s + through(x), 0)
    }
    return pr
}

function axInstant() {
    const P = G.p[ME];
    let best = null;
    P.hand.forEach(c => {
        if (c.t != 'T' || P.lume < c.c || !worth(ME, c) || (pk(c) && !pickList(ME, pickOf(c)).length))
            return;
        const v = axCard(ME, c, {
            def: 1
        });
        if (v >= 3.5 && (!best || v > best.v))
            best = {
                c,
                v
            }
    }
    );
    if (best) {
        play(ME, best.c, pk(best.c) ? aiPickC(ME, best.c) : 0);
        render()
    }
}

/* the right target for each effect */
function axPickList(p, tg, ty, n, key) {
    const L = pickList(p, tg);
    if (!L.length)
        return [];
    const mine = u => G.p[p].front.includes(u) || G.p[p].vault.includes(u)
      , good = ((GOODFX.includes(ty) || ty == 'hp') && !(n < 0 && ['buff', 'hp', 'surge'].includes(ty))) || (ty == 'state' && tg == 'mypick')
      , pool = tg == 'anypick' || tg == 'anyrelic' ? L.filter(u => good == mine(u)) : L
      , l = pool.length ? pool : L;
    const sc = u => {
        const o = mine(u) ? p : 1 - p;
        if (u.t == 'R')
            return mine(u) ? -(u.c * 1.1) : u.c * .6 + (u.ab || []).filter(a => a.tr != 'passive').length + axEngineScore(o, u) * 2.2;
        if (ty == 'return')
            return mine(u) ? (u.tok ? -99 : (u.dmg || 0) * 3 - uVal(o, u) * .3) : uVal(o, u) * (u.tok ? 1.1 : .6) + (G.atkNow && G.atkNow.has(u.id) ? 2 : 0);
        if (ty == 'counter') {
            const side=ownerAny(u), k=typeof n=='number'?n:Math.max(1,+numOf(p,u,n)||1);
            return (side==p?1:-1) * axCounterEffectValue(side,u,['counter',k,'self',key],{}) + uVal(side,u)*.05;
        }
        if (ty == 'destroy')
            return mine(u) ? -uVal(o, u) : uVal(o, u) * (u.tok ? .5 : 1) + axEngineScore(o, u) * 1.6;
        if (ty == 'heal')
            return u.dmg || 0;
        /* a NEGATIVE buff / hp / surge is a curse: aim it at the enemy Unit it hurts the most (kills first) */
        if (n < 0 && (ty == 'buff' || ty == 'surge' || ty == 'hp'))
            return mine(u) ? -99 : (ty == 'hp' && HPv(u) - u.dmg + n <= 0 ? 50 : 0) + (ty == 'hp' ? 0 : Math.min(A(o, u), -n) * 2) + uVal(o, u) * .5 + (u.st == 'S' ? 1 : 0);
        if (ty == 'buff' || ty == 'surge' || ty == 'hp')
            return A(p, u) + (u.st == 'S' ? 3 : 0);
        if (ty == 'state' && mine(u))
            return u.st == 'S' ? -99 : A(p, u) + (u.st == 'P' ? 3 : 0);
        if (ty == 'rest')
            return u.st == 'R' ? -99 : A(o, u);
        return uVal(o, u) + (u.dmg || 0) * .5 + (G.atkNow && G.atkNow.has(u.id) ? 2 : 0)
    }
    ;
    return [...l].sort( (a, b) => sc(b) - sc(a))
}


/* ---- auto phase advance ----
   The game moves to the next phase by itself when nothing useful can be done:
     Main   -> Battle : no card in hand can be paid for with Lume (Echo included),
                        or none of the payable cards meets its trigger
                        (a Tactical needs a valid target / a real effect)
     Battle -> End    : no Unit on Standby is ready to attack                   */
function meetsTrigger(p, c) {
    if (c.t != 'T')
        return true;
    /* Units and Relics can always be deployed */
    const P = G.p[p]
      , O = G.p[1 - p];
    if (pk(c) && !pickList(p, pickOf(c)).length)
        return false;
    /* X taken from counters (['uncounter', 'x', ...]): with no counter to remove there is no X to pay, so the whole Tactical is not playable,
       even if another effect of it (gain X Life, X Lume) would "work" on its own */
    const xu = normFx(c.fx || []).filter(f => Array.isArray(f) && f[0] == 'uncounter' && isXv(f[1]));
    if (xu.length && !xu.every(f => (PICKS.includes(f[2]) ? pickList(p, f[2]) : tgUnits(p, c, f[2], () => [])).some(u => ctrN(u, f[3]) > 0)))
        return false;
    return c.fx.some( ([ty,n0,tg,nm]) => {
        const n = numOf(p, c, n0);
        if (isRem(n0))
            return false;
        const mine = ['allies', 'self', 'mypick', 'others'].includes(tg) || !!tgSpec(tg) && !/^ehas:/.test(tg)
          , side = mine ? P.front : O.front;
        switch (ty) {
        case 'dmg':
            /* damage to yourself is a cost, not a result */
            return tg == 'me' ? false : (tg == 'opp' || O.front.length > 0);
        case 'heal':
            return tg == 'me' ? true : P.front.some(u => u.dmg > 0);
        case 'buff':
        case 'hp':
            /* a negative amount is a curse: it needs a Unit on the side it targets */
            return tg == 'self' || (tg == 'anypick' ? P.front.length + O.front.length : side.length) > 0;
        case 'surge':
            return n < 0 && !mine ? O.front.length > 0 : P.front.some(u => u.st == 'S');
        case 'rest':
            return O.front.some(u => u.st != 'R');
        case 'state':
            return side.some(u => u.st != (n == 'standby' ? 'S' : n == 'prepare' ? 'P' : 'R'));
        case 'return':
            return tg == 'others' ? P.front.length > 1 : side.length > 0;
        case 'choose':
            return n.some(alt => meetsTrigger(p, {
                t: 'T',
                fx: alt
            }));
        case 'raze':
            return tg == 'self' ? true : tg == 'myrelics' || tg == 'myrelic' ? P.vault.length > 0 : tg == 'allrelics' || tg == 'anyrelic' ? P.vault.length + O.vault.length > 0 : O.vault.length > 0;
        case 'prune':
        case 'destroy':
            return tg == 'others' ? P.front.length > 1 : side.length > 0;
        case 'steal':
            return O.lume > 0;
        case 'lume':
            return true;
        case 'grant':
            return handTg(tg) ? handSides(p, handTg(tg)).some(w => handGrantList(G.p[w], String(nm || ''), Math.max(1, Math.floor(+n) || 1), handTg(tg).ty).length > 0) : side.some(u => u.t == 'U' && !hk(u, String(nm || '')));
        case 'disable':
            {
                const dk = String(nm || '');
                if (dk != 'all' && !KWS[dk])
                    return false;
                if (handTg(tg))
                    return handSides(p, handTg(tg)).some(w => handDisableList(G.p[w], dk, handTg(tg).ty).length > 0);
                const lst = /relic/.test(String(tg)) ? (['myrelic', 'myrelics'].includes(tg) ? P.vault : ['allrelics', 'anyrelic'].includes(tg) ? [...P.vault, ...O.vault] : O.vault) : tg == 'anypick' ? [...P.front, ...O.front] : side;
                return lst.some(u => hasKwOn(u, dk))
            }
        case 'counter':
            return side.length > 0;
        case 'uncounter':
            return side.some(u => ctrN(u, nm) > 0);
        case 'pay':
            return tg == 'opp' ? O.debt > 0 : tg == 'ctrl' ? true : P.debt > 0;
        case 'retrieve':
            return P.waste.length > 0;
        case 'mill':
            return tg == 'opp' ? O.deck.length > 0 : P.deck.length > 0;
        case 'look':
        case 'search':
            return P.deck.length > 0;
        case 'debt':
            return tg == 'opp' ? P.debt > 0 : O.debt > 0;
        case 'shuffle':
            return (tg == 'opp' ? O : P).deck.length > 1;
        case 'recur':
            return P.waste.some(u => u.t == 'U');
        case 'draw':
            return P.deck.length > 0;
        default:
            return true
        }
    }
    )
}

const worth = (p, c) => can(p, c) && meetsTrigger(p, c);

function playable() {
    const M = G.p[0];
    return M.hand.some(c => worth(0, c)) || [...M.front, ...M.vault].some(u => actReady(0, u))
}

/* Battle is over (attack resolved or skipped): second main phase, then End Turn */
function toMain2() {
    if (G.over || !G.started || G.act)
        return;
    G.ph = 'main2';
    G.lock = 0;
    G.sel = [];
    G.selc = null;
    render()
}

/* Main 1 and Main 2 allow the same things: playing cards, Relic / Unit abilities */
function inMain() {
    return G.ph == 'main' || G.ph == 'main2'
}

/* ---- render ---- */
const TN = {U: 'Unit', T: 'Tactical', R: 'Relic'};

/* ---- hook check: tells you in the console (F12) when index.html does not provide something the engine calls ---- */
addEventListener('load', () => {
    const need = ['render', 'snd', 'sfxDiff', 'flash', 'combat', 'resetAnim', 'mlReset', 'matchStarted', 'recordMatch', 'cardCue'];
    const miss = need.filter(n => { try { return typeof (0, eval)(n) != 'function' } catch (e) { return true } });
    if (typeof VQ == 'undefined') miss.push('VQ');
    if (miss.length) console.error('[Aetheris] engine.js needs these from index.html: ' + miss.join(', '));
});
