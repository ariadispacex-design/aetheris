/*  =====================================================================
    database/cards.js   -   AETHERIS CARD DATABASE  +  COMPLETE CARD WRITING GUIDE
    =====================================================================
    This is the ONE place where every card is defined. Add / edit / remove a card here and nowhere else:
    decks, rules text, print IDs, artwork lookup and the Card Index panel are all built from CARD_DB.
    The rules text printed on a card is WRITTEN BY THE GAME from the data (you never type it), so the text and the real behaviour can never disagree.

    CONTENTS
      1  Files and folders                    9  Targets
      2  The card record: every field         10  Variables (a number that is counted live)
      3  Keywords                             11  Passive abilities (always on)
      4  Abilities: the fields of one         12  Activated abilities (cost + fx)
      5  Triggers                             13  Counters
      6  Conditions: if / of / ctr / max      14  Tokens (summon)
      7  Effects: anatomy + every effect      15  Rules quick reference
      8  Choice (or)                          16  Checklist and the console checker

    ---------------------------------------------------------------------
    1  FILES AND FOLDERS
    ---------------------------------------------------------------------
        index.html                <- the game engine: rules, rules-text builder, console checker, AI
        user.js                   <- player profile (name, gold, match history, settings)
        database/
            cards.js              <- this file: FACTIONS + CARD_DB
            decks.js              <- the Logistic (deck) lists of both players
            sounds.js             <- your mp3 files and which game event plays which sound
            art/                  <- card artwork, one file per print ID:  art/V-47962.webp   (Token artwork: art/tokens/)
            art/sleeves/          <- card sleeves, .png files (default.png is the opponent's sleeve; the pile edge takes its colour from the sleeve)
            logs/                 <- match logs the game writes after each match (log1.txt, log2.txt ...)
                                   each log = header, BALANCE SUMMARY (both decks, Lume / Life / Echo Debt gained and lost per card, cards played,
                                   attacks, blocks, deaths, per-turn table) and then every event of the match
    "database" is the folder this file sits in (the game finds it from the <script src=".../cards.js"> tag).
    The "art" field of a card is relative to THIS folder (database/). A full URL, a data: URI or a path starting with / is used as it is.
    After editing this file just reload the page (F5). Open the console (F12) to read the checker messages (chapter 16).

    ---------------------------------------------------------------------
    2  THE CARD RECORD: every field
    ---------------------------------------------------------------------
    A card is one object in CARD_DB:
        {
            id: 'V-47962', name: 'Veriel, Scout Leader', type: 'U', faction: 'veyrani', sub: 'Scout',
            cost: 3, atk: 2, hp: 3,
            keyword: [['swift']],
            abilities: [ {tr: 'play', fx: [['draw', 1]]} ],
            flavor: 'He reads the wind before the sand moves.',
            art: 'art/V-47962.webp'
        },

    field      needed for           what it is
    ---------  -------------------  ---------------------------------------------------------------------------------------------------------------
    id         every card           Permanent print ID:  <faction letter>-<5 digits>.  UNIQUE.  Printed on the card and used as the artwork file name.
                                    Letters:  V Veyrani   A Astronav   C Caelor   K Vulkar   B Veilborn
    name       every card           The card name. UNIQUE. Decks, the artwork lookup and Token records find a card by its name.
    type       every card           'U' Unit   'T' Tactical (a one-time spell)   'R' Relic (stays in the Vault)
    faction    every card           veyrani | astronav | caelor | vulkar | veilborn   (the keys of FACTIONS at the bottom of this comment)
    sub        Units ONLY           Sub type shown on the card ('Scout', 'Elder', ...). Every Unit has one. Relics and Tacticals never do.
    cost       every card           Lume cost (a number, 0 is allowed)
    atk, hp    Units ONLY           Attack and health. Both required for a Unit.
    keyword    optional (Units)     List of keywords, see chapter 3
    abilities  optional (a Tactical needs a flash ability)   List of abilities, see chapter 4
    flavor     every card           Flavor text shown at the bottom of the card
    art        every card           Artwork file of this card, relative to database/. Loaded automatically when the file exists.
    token      Tokens only          token: true = a card that is only created by an effect (summon), never put in a deck. See chapter 14.

    ---------------------------------------------------------------------
    3  KEYWORDS
    ---------------------------------------------------------------------
    keyword: a LIST. Each keyword is [name], or [name, n] for a keyword that has a number:   keyword: [['echo', 2], ['drawdown', 1], ['stomp'], ['swift']]
        echo n      Echo n: can borrow up to n Lume as Echo Debt (needs a number n)
        drawdown n  Drawdown n: this card costs n less Lume to play (needs a number n). Works on Units, Relics and Tacticals. No Echo Debt is taken.
                    The Lume you pay is  cost - n  (never below 0). It adds to Echo:  cost 5 + echo 2 + drawdown 1  costs 2 Lume,
                    and the Echo Debt is still only the Echo value. The printed cost stays on the card for the deck builder;
                    logs and deck lists show it as  cost 4 drawdown 2.
        swift       enters ready to attack (it enters Standby instead of Prepare)
        lifesteal   combat damage heals you (damage that is ignored by Evasion does not heal)
        tireless    attacking does not make this Unit Rest
        toxic       a Unit paired with it, attacking OR blocking, is always destroyed, whatever its ATK
        stomp       when blocked, its ATK damage hits the blocker AND the opponent. If its blockers are gone before damage, it still hits the opponent
        evasion     ignores the combat damage (Toxic included) of the Unit it is paired with, attacking or blocking
    A keyword without a number shows as a green pill on the card, a keyword with a number gets a black number pill.
    Each keyword is listed once per card. The checker reports an unknown name, a missing number, a number on a keyword that takes none.
    The explanation of every keyword a card has (printed or granted) is shown in the side box next to the card preview.
    Keywords can also be given by an effect: ['grant', 0, target, 'keyword'] (chapter 7). Every keyword except echo and drawdown can be granted to Units on the board (those two only change the Lume cost of playing a card). A keyword can also be granted to the cards in a HAND (targets: chapter 9): ['grant', 'uhand', 'swift'] gives Swift to the Units in your hand. Echo and Drawdown reach every card type, any other keyword only Unit cards; the keyword stays on the card when it is played. Echo and Drawdown can be granted to a hand only: ['grant', 1, 'hand', 'drawdown'] gives every card in your hand Drawdown 1, ['grant', 2, 'ehand', 'echo'] gives every card in the enemy hand Echo 2 (cheaper, but they take the Echo Debt). They ADD UP, they never replace: a card with Echo 1 that is granted Echo 2 has Echo 3 (the Lume cost drops with every grant, but Echo + Drawdown together never go past the printed cost - 1: a cost 3 card can get at most 2 in all, at least 1 Lume is always paid; a grant only fills up to that limit). A NEGATIVE number takes it away again: ['grant', -2, 'hand', 'echo'] lowers Echo by 2, down to 0 = the keyword is gone (and the cost is back); a card that does not have the keyword is skipped.
    (An old-style  echo: 2  field on a card record still counts as the keyword Echo 2, but write it as a keyword.)

    ---------------------------------------------------------------------
    4  ABILITIES: the fields of one ability
    ---------------------------------------------------------------------
    EVERY rule of a card is an ability:    abilities: [ {tr: <trigger>, fx: [<effect>, ...]}, ... ]
    The list is read in order, and it is also the order of the card text. A Unit / Relic can have any number of abilities.

    field   used by            what it is
    ------  -----------------  ------------------------------------------------------------------------------------------------------------------
    tr      every ability      THE TRIGGER: when does it happen. One of the names in chapter 5, or 'passive', 'flash', 'act'.   (required)
                               A triggered ability can list SEVERAL triggers:  tr: ['mill', 'discard']  = ONE ability that happens on any of them
                               (the text joins them with "or"). Only use triggers from chapter 5 in such a list.
    fx      every ability      What happens: a LIST of effects, chapter 7. They run in order.   (required)
                               A single effect may be written without the outer list:  fx: ['draw', 1]  =  fx: [['draw', 1]]
    cost    'act' only         What you pay to use it: a LIST of effects, written exactly like fx. Chapter 12.
    if      triggers           A condition on the card itself ("if you control another Elder"). Chapter 6.
    of      some triggers      A filter on the card that CAUSED the trigger ("whenever another Scout enters"). Chapter 6.
    ctr     counter triggers   Only for the 'counter' / 'ocounter' triggers: react to this counter name only. Chapter 13.
    max     triggers + 'act'   max: n = the ability works at most n times each turn (whole number, 1 or more). THIS IS THE ONLY PER-TURN LIMIT: there is no
                               once: true any more (the checker reports it, write max: 1). The number is written as a word on the card:
                                   max: 1  "Once per turn"      max: 2  "Twice per turn"      max: 3  "Up to three times per turn"   (four, five, six ...)
                               - on a triggered ability: after the n-th time, further triggers that turn do nothing. The text prints
                                 "Once per turn if ..." / "Up to three times per turn if ..." instead of "When ...".
                               - on 'act': it prints "Once per turn <cost>: <effects>" and the button is greyed out after the n-th use.
                               Every ability counts on its own. An 'act' ability with max needs no cost: it is allowed without one. Not for passive / flash.

    Rules per kind of ability
        Tactical    only  {tr: 'flash', fx: [...]}  -  the one-time effects resolved when it is played. No if / cost / max / of / ctr.
        Unit/Relic  any number of triggered abilities, passive abilities and activated abilities. Never flash.
        passive     no if / cost / max / of / ctr (always on). Chapter 11.

    ---------------------------------------------------------------------
    5  TRIGGERS    (tr: ...)
    ---------------------------------------------------------------------
    play        When this card enters play: a Unit enters the Frontline, a Relic enters the Vault
    anyplay     When you play another card (max 3)
    oanyplay    When enemy play a card (anyplay, oanyplay = every player play a card) (max 3)
    death       When this Unit is destroyed
    attack      When this Unit is declared as an attacker
    aattack     Whenever ANOTHER of your Units is declared as an attacker (this card never reacts to its own attack). Accepts  of: {sub, faction}.
    oattack     Whenever an ENEMY Unit is declared as an attacker. Accepts  of: {sub, faction} (it filters the enemy attacker).
                aattack / oattack fire when the attack is declared, before blockers are chosen, so they can still change the combat (disable Evasion,
                -ATK, damage ...). Use the target 'trigger' to hit the attacking Unit itself, e.g.
                {tr: 'oattack', fx: [['disable', 'trigger', 'evasion', 'turn']]}   -> "Whenever an enemy Unit attacks, it loses Evasion until end of turn."
    echo        When this card is played using Echo (it was played by borrowing Lume. Fires right after play)
    aecho       Whenever you play ANOTHER card (Unit, Relic or Tactical) using Echo (echo is for the card that was itself played with Echo)
                aecho (your other cards) and oaecho (the opponent's cards). A Unit's 'enter' triggers (enter / oenter) come last.
    extract     At Extraction: your turn starts. After your Units wake, you gain Lume, lose Life equal to your Echo Debt (Payday) and draw
    end         At End Turn: your turn ends
    cast        Whenever you play a Tactical (after the Tactical has resolved)
    ally        Whenever your Unit is destroyed
    enter       When another of your Units enters
    draw        Whenever you draw
    discard     Whenever you discard a card (discard effect or cost)
    mill        When cards of your Logistic are milled (sent to the Wasteland by a mill effect)
    relog       When cards return to your Logistic: a retrieve to 'logistic' / 'shuffle', the unchosen cards of a look, cards a search puts on top.
                ONE event per move (not per card); the variable 'delta' = how many cards returned, e.g.
                {tr: 'relog', fx: [['draw', 'delta']]}   -> "When cards return to your Logistic, draw X cards, where X is the number of cards returned to the Logistic."
    counter     When a counter is put on your Unit
    lumeup      When your Lume increases              lumedown   When your Lume decreases
    lifeup      When your Life increases              lifedown   When your Life decreases
    debtup      When your Echo Debt increases         debtdown   When your Echo Debt decreases
    prepare     When your Unit is set to Prepare      standby    ... set to Standby        rest       ... set to Rest
    return      When your Unit is returned to your hand (return effect)
    block       When this Unit blocks and survives: it was paired with an attacker, fought it, and is still in play after combat damage and
                destruction (a blocker that dies, or whose attacker was removed before damage, does not trigger it). Fires once per combat.
    ablock      Whenever another of your Units blocks and survives (same rule; this card never reacts to its own block). Accepts  of: {sub, faction}.
    oablock     Whenever an ENEMY Unit blocks and survives (same rule as ablock). Accepts  of: {sub, faction} (it filters the enemy blocker). Target 'trigger' = that blocker.
    defend      When this Unit is declared as a blocker, whether it survives the combat or not (BEFORE any damage, so it can still change the fight).
    adefend     Whenever ANOTHER of your Units is declared as a blocker (same timing; this card never reacts to its own block). Accepts  of: {sub, faction}.
    odefend     Whenever an ENEMY Unit is declared as a blocker, whether it survives the combat or not. Fires once per blocker, BEFORE any damage, so it can still
                change the fight. Accepts  of: {sub, faction} (it filters the enemy blocker). Target 'trigger' = that blocker, e.g.
                {tr: 'odefend', fx: [['dmg', 1, 'trigger']]}   -> "Whenever an enemy Unit blocks, deal 1 damage to it."
    o...        Every trigger that starts with o is the same event happening on the OPPONENT's side:
                oattack oablock odefend ocast odiscard odraw omill orelog oenter ocounter olumeup olumedown olifeup olifedown odebtup odebtdown oprepare ostandby orest oreturn oaecho oaact
                (oenter = When an enemy Unit enters, odraw = When the opponent draws, oaecho = Whenever the opponent plays a card using Echo, oaact = Whenever the opponent activates a card's ability, ...)
    passive     Unit / Relic: always on while in play, no trigger. Chapter 11.
    flash       Tactical: the one-time effects of the card, resolved when it is played.
    act         Manual: the player clicks it, it runs when its cost can be paid. Chapter 12.
    aact        Whenever you activate ANOTHER card's ability (an act ability, after it resolved; the card that was activated never reacts to itself)
    Trigger chains stop after 3 levels, so effects can never loop forever.
    A card never reacts to a Lume or Life change that its own ability (or a chain that started from it) caused.
    Order when a card is played using Echo: a Unit / Relic 'play' first, a Tactical resolves and 'cast' fires first; then echo (the card itself),

    ---------------------------------------------------------------------
    6  CONDITIONS:  if / of / ctr / max
    ---------------------------------------------------------------------
    if   (a condition on the card itself, checked when the trigger fires)
        if: 'ally'                         if you control another Unit
        if: {sub: 'elder'}                 if you control another Elder (another Unit OR Relic whose sub type contains 'elder')
        if: {faction: 'veyrani', n: 2}     if you control at least 2 OTHER Veyrani cards   (n is optional, default 1)
        if: {sub: 'x', faction: 'y'}       both filters together
        if: {ctr: 'Dust', n: 3}            if THIS Unit has 3 or more Dust counters
        if: {var: 'debt', min: 20}         if a live number is at least min and / or at most max. var = any variable of chapter 10
        if: {var: 'hand', max: 2}              ("if your Echo Debt is 20 or more," / "if the number of cards in your hand is 2 or less,")
        if: {var: 'elife', min: 5, max: 10}    both limits = "is between 5 and 10". Needs min and / or max (a number). 'k*name' and 'name/k' work too.
        The condition is only for triggered abilities (not passive, not act, not flash). If it is false when the trigger fires, nothing happens.
    of   (a filter on the card that CAUSED the trigger)   of: {sub: 'scout', faction: 'veyrani'}
        Uses {sub, faction}. Works with: ally, ablock, oablock, adefend, odefend, aattack, oattack, enter, oenter, prepare, oprepare, standby, ostandby, rest, orest, return, oreturn,
        cast, ocast, discard, odiscard, aecho, oaecho, aact, oaact  (the triggers that come with a source card: the Unit that entered, the card that was discarded...).
        The checker reports of on any other trigger (also when it is one of the triggers in a tr list).
    ctr  (counter triggers only)   {tr: 'counter', ctr: 'Dust', fx: [...]}   see chapter 13
    max  (see chapter 4)   {tr: 'draw', max: 1, fx: [['lume', 1]]}      -> "Once per turn if you draw, gain 1 Lume."
                       {tr: 'draw', max: 2, fx: [['lume', 1]]}      -> "Twice per turn if you draw, gain 1 Lume."
                       {tr: 'draw', max: 3, fx: [['lume', 1]]}      -> "Up to three times per turn if you draw, gain 1 Lume."

    ---------------------------------------------------------------------
    7  EFFECTS
    ---------------------------------------------------------------------
    7.1  ANATOMY OF AN EFFECT:  an effect is a LIST of up to 4 items

            [ 'buff',   2,        'allies',    'counter:Dust' ]
               |        |           |             |
               |        |           |             4th  EXTRA   a counter name, a keyword, a "for each" or a look option (only some effects)
               |        |           3rd  TARGET   who or what it works on, chapter 9 (only some effects)
               |        2nd  AMOUNT   a number, or a VARIABLE (chapter 10, incl. 'delta'). Effects that need no amount use 0.
               1st  TYPE     which effect it is (the names below)

        - The 2nd item is not always an amount: state takes 'rest' / 'standby' / 'prepare', uncounter can take 'all',
          summon takes the Token description {...}, look takes how many cards to look at.
        - The 3rd item is a target for most effects. For mill / debt / shuffle / retrieve it is a SIDE OPTION ('opp', 'me', 'logistic', 'shuffle').
        - An effect with a missing or wrong target does nothing, and the checker tells you in the console.

    7.2  FIELD MEANING PER EFFECT
        effect      2nd (amount)          3rd                       4th
        ----------  --------------------  ------------------------  --------------------------------------
        dmg         damage                Unit target | opp | me
        heal        amount restored       Unit target | me
        draw        cards
        lume        Lume (negative = pay)
        buff        ATK                   Unit target               (passive only) "for each", chapter 11
        hp          HP                    Unit target               (passive only) "for each", chapter 11
        surge       ATK this turn         Unit target
        rest        0                     Unit target
        state       'rest' 'standby' 'prepare'   Unit target
        grant       0 | number | 'removed'  Unit target or HAND target   keyword name  (5th item 'turn' = this turn only; a number is only for Echo / Drawdown)
        disable     0                     any card target           keyword name or 'all'  (5th item 'turn' / 'next' = temporary)
        prune       0                     Unit target
        raze        how many Relics       Relic target
        steal       Lume
        return      how many              Unit target
        recur       how many
        retrieve    how many              (none) | 'logistic' | 'shuffle'
        shuffle     0                     (none) | 'opp'
        look        cards to look at      cards to TAKE (default 1) where the rest go: 'bottom' | 'top' | 'shuffle'
        destroy     how many              Unit target
        peek        -
        summon      {Token description}   -
        drain       Life
        pay         Echo Debt to pay off
        discard     cards
        mill        cards                 (none) | 'opp'
        debt        Echo Debt             (none) | 'opp' | 'me'
        adddebt     New Echo Debt         'me' | 'opp'
        counter     counters              Unit target               counter name
        uncounter   counters or 'all'     Unit target               counter name
        hold        0                     Unit target               counter name  (passive only)

    7.3  EVERY EFFECT
        dmg         ['dmg', n, target]                  Damage n to a Unit target, to 'opp' (opponent's Life) or to 'me' (you PAY n Life: it is a cost, printed "Pay n Life").
        heal        ['heal', n, target]                 Restore n to a Unit target. 'me': gain n Life.
        draw        ['draw', n]                         Draw n cards, one at a time. If a card MUST be drawn and your Logistic is empty,
                                                        you LOSE the game. (An empty Logistic alone is not a defeat: only a failed draw is.)
        lume        ['lume', n]                         Gain n Lume. Lume from effects has no cap. A NEGATIVE n pays Lume: ['lume', -1] = pay 1 Lume.
        buff        ['buff', n, target]                 Target Unit(s) get +n ATK, permanently. Negative numbers reduce ATK.
        hp          ['hp', n, target]                   Target Unit(s) get +n HP, permanently. Negative numbers reduce HP.
        surge       ['surge', n, target]                Target Unit(s) get +n ATK this turn only.
        rest        ['rest', 0, target]                 Set target Unit(s) to Rest.
        state       ['state', 'type', target]           Set target Unit(s) to a state. type: 'prepare' | 'standby' | 'rest'.
        grant       ['grant', target, 'keyword']        Give the keyword to target Unit(s): ['grant', 'allies', 'swift'].
                    ['grant', 'hand' | 'ehand', 'keyword']   The cards in a hand get the keyword, e.g. ['grant', 'uhand', 'swift'] (see HAND targets; Echo / Drawdown: any card type, others: Unit cards only).
                    ['grant', target, 'keyword', 'turn' | 'next']   'turn' = until end of turn, 'next' = until your next turn (cleared at your Extraction).
                    ['grant', n, target, 'keyword']     Long form: n is the keyword's number (1 or more) for a keyword that has one; Echo / Drawdown on a HAND also take a
                                                        negative n (see below: they add up, a negative n subtracts); a keyword without a number
                                                        IGNORES n (write 0, or use the short form). ['grant', 0, 'allies', 'swift', 'turn'] still works.
                    ['grant', 'removed', 'ehand', 'echo']   n can also be 'removed' (after an uncounter in the same ability: the number of counters just removed) or a
                                                        variable (chapter 10). If it works out to 0 for a keyword with a number, nothing is given. A string that is the name of a
                                                        target is always the short form, so 'removed' / a variable never clashes with a target. Echo / Drawdown given to a hand are
                                                        permanent: a 'turn' / 'next' item is ignored (the checker says so), so leave it out.
                                                        Echo / Drawdown NUMBERS ADD UP: Echo 1 + ['grant', 2, 'hand', 'echo'] = Echo 3. A negative n subtracts: ['grant', -2, 'hand', 'echo']
                                                        (never below 0; at 0 the keyword is gone; cards without it are skipped). The AI does not plan around negative grants yet.
        disable     ['disable', target, 'keyword']      Switch the keyword OFF on the target card(s) for good: ['disable', 'enemies', 'evasion'].
                    ['disable', target, 'all']          Switch off EVERY keyword (printed and granted) on the target card(s).
                    ['disable', target, 'keyword', 'turn' | 'next']   'turn' = until end of turn, 'next' = until your next turn (cleared at your Extraction).
                    The target is any target the engine has: Unit targets (allies, enemies, pick, mypick, anypick, self ...), Relic targets (relic, myrelic,
                    anyrelic, relics ...) and the HAND targets (hand, ehand, ahand, uhand ... see HAND targets). Echo and Drawdown only exist in a hand: there
                    they are switched off for good and the card cost is recalculated. A disabled keyword stays off even if it is granted again later, and the
                    card text of the Unit stops showing it. The short form (no number) is the normal way to write it; ['disable', 0, 'enemies', 'evasion'] also works.
        prune       ['prune', 0, target]                Remove target Unit(s) from play to The Void: no Wasteland and no "destroyed" triggers.
        destroy     ['destroy', n, target]              Destroy target Unit(s), yours or the enemy's: they go to the Wasteland and their
                                                        "When destroyed" abilities fire. Your OWN Units (targets self / mypick / allies / others / sub: / faction: / has:)
                                                        are printed as a sacrifice: "Sacrifice this Unit", "Sacrifice a Unit you control", enemy targets stay "Destroy ...".
        raze        ['raze', n, relic target]           Destroy target Relics: they leave the Vault for the Wasteland.
                    ['raze', 1, 'self']                 A Relic destroys itself. The text prints "Sacrifice this Relic" (Relics only). Your own Relics (myrelic / myrelics) are
                                                        printed "Sacrifice a Relic you control" / "Sacrifice every Relic you control"; enemy Relics stay "Destroy ...".
        return      ['return', n, target]               Return target Unit(s) from the board to their owner's hand. Damage, counters and bonuses
                                                        are lost. A Token just disappears.
                                                        With a pick target (pick, mypick, anypick) and n above 1 you choose up to n DIFFERENT
                                                        Units. destroy and raze work the same way.
        steal       ['steal', n]                        Take n Lume from the opponent (at most what they have).
        recur       ['recur', n]                        Return Units from your Wasteland to your hand, choosing the strongest first.
        retrieve    ['retrieve', n]                     Return n cards from your Wasteland to your hand.
                    ['retrieve', n, 'logistic']         Return n cards from your Wasteland to the top of your Logistic.
                    ['retrieve', n, 'shuffle']          Send n cards from your Wasteland to your Logistic and shuffle it.
        shuffle     ['shuffle', 0]                      Shuffle your Logistic.
                    ['shuffle', 0, 'opp']               Shuffle your opponent's Logistic.
        look        ['look', x]                         Look at the top x cards of YOUR Logistic, take 1 into your hand, the others go to the bottom.
                    ['look', x, take]                   Take `take` cards into your hand instead of 1.
                    ['look', x, take, where]            where = what happens to the cards you did NOT take (the order is kept):
                                                            'bottom' (default) | 'top' (back on top) | 'shuffle' (shuffled into the Logistic)
                                                        e.g. ['look', 4, 1]   ['look', 5, 2, 'top']   ['look', 3, 1, 'shuffle']
                                                        The 3rd and 4th items are NOT a target: look always works on your own Logistic.
                                                        You choose the cards on a card screen, the computer takes the cards it likes best.
                                                        If the Logistic has fewer than x cards you look at all of them.
        peek        ['peek']                            Look at the opponent's hand.
        summon      ['summon', {...}]                   Recruit a Token. See chapter 13.
        drain       ['drain', n]                        The opponent loses n Life and you gain n.
        pay         ['pay', n, 'me']                    pay off n your echo debt
                    ['pay', n, 'opp']                   pay off n enemy echo debt
                    ['pay', n, 'ctrl']                  debt controller Unit that fire the trigger decreases n
        discard     ['discard', n]                      Discard n cards from your hand (you choose; the computer discards its cheapest).
        mill        ['mill', n]                         Send the top n cards of your Logistic to the Wasteland.
                    ['mill', n, 'opp']                  Send the top n cards of the opponent's Logistic to the Wasteland.
        debt        ['debt', n]                         Take up to n Echo Debt from the opponent (a transfer).
                    ['debt', n, 'opp']                  Transfer up to n of your Echo Debt to the opponent.
                    ['debt', n, 'me']                   Take n Echo Debt yourself.
        adddebt     ['adddebt', n, 'me']                Take n NEW Echo Debt yourself.
                    ['adddebt', n, 'opp']               The opponent takes n NEW Echo Debt. Nothing moves: your own debt stays.
                    The target (3rd item) is required. n may be a number or a variable, e.g. ['adddebt', 'debt', 'opp'].
        counter     ['counter', n, target, 'Name']              Put n counters named 'Name' on the target Unit(s).
        uncounter   ['uncounter', n or 'all', target, 'Name']   Remove n (or all) Name counters from the target Unit(s).
        hold        ['hold', 0, target, 'Name']                 Passive ability only: Units with a Name counter do not wake at Extraction.
        search      ['search', n, 'Card Name']                  copy goes to hand, then the Logistic is shuffled
                    ['search', n, 'Card Name', 'top']           up to 2 copies; shuffle, then they go on top of the Logistic
                    ['search', 1, 'type:unit']                  any Unit from your Logistic to hand
                    ['search', 1, 'type:relic']                 any Relic
                    ['search', 2, 'type:tactical', 'top']       choose 2 Tacticals, shuffle, put them on top
                    ['search', 1, 'sub:scout']                  any card whose sub type contains "scout"
                    ['search', 1, 'faction:vulkar']             any Vulkar card
                    ['search', 1, 'faction:vulkar+type:unit']   a Vulkar Unit
                    ['search', 2, 'sub:elder+type:unit', 'top'] choose 2, shuffle, put on top

    ---------------------------------------------------------------------
    8  CHOICE   (or)
    ---------------------------------------------------------------------
       ----------- CHOICE ('or') -----------
    Put the word 'or' between effects and the player chooses ONE side when the ability resolves.
    - Syntax   fx: [['pay', 1], 'or', ['lume', 2]]            -> the card prints one line per choice:
                                                                    "Choose one:"
                                                                    "- Pay off 1 Echo Debt"
                                                                    "- Gain 2 Lume."
    - Several effects on a side   fx: [['draw', 1], ['dmg', 1, 'opp'], 'or', ['lume', 3]]   (everything before 'or' is one choice, everything after is the next)
    - Three or more choices   [A, 'or', B, 'or', C]   (each choice gets its own "- " line)
    - AFTER the choice: 'then'   fx: [['pay', 2], 'or', ['lume', 2], 'then', ['draw', 1]]
        Everything after 'then' happens ONCE, after the chosen side is done, whichever side it was. Without 'then', an effect written after 'or' belongs to
        that side only (["pay 2", 'or', "lume 2", "draw 1"] draws only if you choose the Lume side).
        Both sides and the 'then' part can hold several effects:   [A1, A2, 'or', B1, 'then', C1, C2]
        'then' does not decide which sides are possible (a side that cannot be done is still greyed out, even if the 'then' part could be done).
        The text prints a last line "If you do, draw 1." and the choice window shows it under the buttons. 'then' needs an 'or' before it.
    - BEFORE the choice (a cost): the word 'choose' starts the choice, the effects written before it are done FIRST
        fx: [['dmg', 1, 'me'], 'choose', ['raze', 1, 'relic'], 'or', ['destroy', 1, 'pick']]
            -> "Pay 1 Life, then choose one:  - Destroy a Relic.  - Destroy a Unit."
        Without the word 'choose', an effect before the first 'or' belongs to the FIRST side only.
        The first part is paid once, when the choice starts, and only if at least one side can be done (if no side is possible nothing happens, nothing is paid).
        'choose' and 'then' can be used together:   [COST, 'choose', A, 'or', B, 'then', AFTER]
    - A side that cannot be done is greyed out. If only one side is possible it happens automatically.
    - The AI picks the side it values most. Both sides need at least one effect.

    ---------------------------------------------------------------------
    9  TARGETS   (the 3rd item of an effect)
    ---------------------------------------------------------------------
    UNIT targets   (dmg heal buff hp surge rest state grant disable prune return destroy counter uncounter hold)
        ctrl            whoever controls the unit
        self            this Unit only
        trigger         the Unit that set off the trigger (the attacker of aattack / oattack, the Unit of enter / oenter / ablock ...), only while it is still on the board
        allies          all Units you control
        others          all your Units except this card
        enemies         all Units the opponent controls
        pick            you CHOOSE one enemy Unit
        mypick          you CHOOSE one of your Units
        anypick         you CHOOSE any Unit, yours or the enemy's
        'sub:elder'     your Units whose sub type contains "elder"
        'faction:veyrani'   your Veyrani Units
        'has:Dust'      your Units that have a Dust counter
        'ehas:Frost'    enemy Units that have a Frost counter
    HAND targets   (grant and disable)  [e|a][u|t|r]hand
        prefix   none = your hand      e = the enemy hand      a = BOTH hands
        type     none = every card     u = Unit cards     t = Tactical cards     r = Relic cards
        hand   ehand   ahand        every card in your / the enemy / both hands
        uhand  euhand  auhand       only the Units
        thand  ethand  athand       only the Tacticals
        rhand  erhand  arhand       only the Relics
        Echo and Drawdown work on every card type; other keywords only on Units (use uhand / euhand / auhand).
    RELIC targets  (raze, disable)
        self            this Relic (a Relic destroying itself)
        relic           you CHOOSE one enemy Relic            relics     all enemy Relics
        myrelic         you CHOOSE one of your Relics         myrelics   all your Relics
        anyrelic        you CHOOSE any Relic                  allrelics  every Relic
    PLAYER targets
        opp             the opposing player (dmg; side option of mill, debt, shuffle)
        me              you, the player (dmg, heal; side option of debt)
    Choosing targets (pick, mypick, anypick, relic, myrelic, anyrelic): you are asked when the effect resolves; the computer picks for itself.
    They are NOT allowed in activated abilities or in costs (there is no moment to ask), the checker reports it.

    ---------------------------------------------------------------------
    10  VARIABLES   (a number that is counted live when the effect runs)
    ---------------------------------------------------------------------
    The AMOUNT (2nd item) of ANY effect, also of a passive effect, can be the NAME of something in the game instead of a fixed number:
        ['draw', 'hand']    ['lume', '2*relics']    ['buff', '-hand', 'enemies']    ['heal', 'waste/2', 'me']
    Written form:   'name' = its value  |  '-name' = negative  |  'k*name' = times k  |  'name/k' = divided by k, rounded down
        hand   deck   waste   life   lume   debt        yours: cards in hand / Logistic / Wasteland, your Life, Lume, Echo Debt
        ehand  edeck  ewaste  elife  elume  edebt       the opponent's
        units  others  enemies  relics  erelics          your Units / your other Units / enemy Units / your Relics / the opponent's Relics
        turn                                              the turn number
        delta       ONE variable, two meanings (it replaces the older 'removed', which still works):
                    1. After an uncounter effect in the same ability: the number of counters that uncounter just removed (chapter 13).
                    2. Anywhere else: the NUMBER OF THE TRIGGER that fired the ability:
                         lumeup / lumedown / lifeup / lifedown / debtup / debtdown (and o... versions)  the amount it changed by
                         echo / aecho / oaecho      the Echo Debt that play took
                         mill / omill               the number of cards milled
                         relog / orelog             the number of cards returned to the Logistic
                         every other trigger (play, enter, draw, discard, attack, death, end ...)  1, because it is one event
                         (draw and discard fire once per card, so delta is 1 each time)
                    {tr: 'oaecho', fx: [['lume', '2*delta']]}   -> "Whenever the opponent plays a card using Echo, gain double X Lume, where X is the amount it changed by."
                    {tr: 'debtdown', fx: [['retrieve', 'delta', 'shuffle']]}   -> pay 3 Echo Debt = send 3 cards from the Wasteland to the Logistic and shuffle it.
                    {tr: 'mill', fx: [['debt', 'delta', 'opp']]}   -> X = the number of cards milled.

        counter:Name  counters:Name  ecounters:Name       Name counters on this card / on your Units / on enemy Units
    The card text prints X and explains it, e.g. "All enemy Units get -X ATK, where X is the number of cards in your hand."
    With several different variables in one ability the text letters them X, Y, Z.
    dmg, heal, draw, lume, buff, hp, counter, mill, discard, pay and debt take a number or a variable as the amount: any other word is reported by the checker.
    A passive effect with a variable follows the game live: its value is recounted every time it matters.
    Example, a Unit whose ATK and HP equal your Relics (printed atk 0, hp 0 or higher):
        abilities: [ {tr: 'passive', fx: [['buff', 'relics', 'self'], ['hp', 'relics', 'self']]} ]
    The special amount 'delta' after an uncounter in the same ability ('removed' is the old name and still works) is the number of counters just removed (chapter 13).
    '-delta' ('-removed') is the same number with a minus sign. It works for buff, hp and surge only:
        [['uncounter', 'all', 'self', 'Politic'], ['buff', '-delta', 'enemies']]  ->  "Enemies get -X ATK, where X is the number of counters removed."
        (an hp effect with a minus can destroy a Unit that falls to 0 HP)
    A CAP on that number: write it after a colon, 'delta:3' (or '-delta:3', 'removed:3') = the number of counters removed, but at most 3:
        [['uncounter', 'all', 'allies', 'Politic'], ['heal', 'delta:3', 'me']]  ->  "Gain X Life, where X is the number of counters removed (at most 3)."
        removed:3 with 5 counters removed = 3, with 2 removed = 2. It works everywhere 'removed' works (heal, draw, lume, buff, hp, grant ...).

    ---------------------------------------------------------------------
    11  PASSIVE ABILITIES  {tr: 'passive', fx: [...]}   Unit / Relic, always on while the card is in play
    ---------------------------------------------------------------------
    - Only buff, hp and hold are allowed. They are not "done once": they are recounted all the time (they vanish when the card leaves play).
    - Target must be: self | allies | others | enemies   (hold: one of these plus a counter name as the 4th item)
    - No if / cost / max / of / ctr.
    - Amount: a number or a variable (chapter 10).
    - FOR EACH: an optional 4th item makes a passive buff / hp grow with something:  ['buff', 1, 'self', 'others'] = +1 ATK for each other Unit you control
        others          for each other Unit you control (not counting this one)
        units           for each Unit you control
        enemies         for each enemy Unit
        relics          for each Relic you control
        waste           for each card in your Wasteland
        counter:Name    for each Name counter on this Unit
        counters:Name   for each Name counter on your Units
        ecounters:Name  for each Name counter on enemy Units
    - A buff and an hp with the same target and the same 4th item are printed together:
      ['buff', 1, 'self', 'others'], ['hp', 1, 'self', 'others'] = "+1 ATK and +1 HP for each other Unit you control".
    - A permanent bonus that GROWS (-1, -2, -3 ...) is not a passive: put the buff on a trigger, e.g. {tr: 'extract', fx: [['buff', -1, 'enemies']]}.

    ---------------------------------------------------------------------
    12  ACTIVATED ABILITIES  {tr: 'act', cost: [<effect>, ...], fx: [<effect>, ...], max: 1}
    ---------------------------------------------------------------------
    The cost is NOT a separate system: it is a list of ordinary effects, written exactly like fx.
    Using the ability runs the cost effects first, then the fx. It can only be used when EVERY cost effect can be done (else the button is disabled).
    A cost or max: n is required. A cost cannot use a choosing target (pick, mypick, anypick, relic ...).
    An activated ability can only be used in your Main phase (Main or Main 2), never during Battle or while a choice is open.
        rest this Unit              cost: [['state', 'rest', 'self']]           needs a ready (Standby) Unit
        take n Echo Debt            cost: [['adddebt', n, 'me']]
        pay n Lume                  cost: [['lume', -n]]                        a negative amount takes Lume away
        pay n Life                  cost: [['dmg', n, 'me']]
        sacrifice this Unit         cost: [['destroy', 1, 'self']]
        remove n counters           cost: [['uncounter', n, 'self', 'Name']]
        send n cards to Wasteland   cost: [['mill', n]]
        discard n cards             cost: [['discard', n]]                      you choose the cards
        take n Echo Debt            cost: [['debt', n, 'me']]
        pay x cost 'any'            cost: [['lume', '-x']] (-x = pay x cost, -x:3 = pay x cost max 3)

    X IN A TACTICAL (the player chooses an amount when casting it)
        A Tactical can use the variable x in its flash fx. When you cast it a bar appears:  [-]  X = 3  [+]  [Max]  [Play]  [Cancel].
            {tr: 'flash', fx: [['uncounter', 'x', 'mypick', 'Order'], ['heal', 'x', 'me']]}
                -> "Remove X Order counters from a Unit you choose, gain X Life, where X is the amount you choose."
        - Largest X: the cap 'x:5' if written, and never more than the most counters of that name on one Unit the uncounter can reach.
        - A Tactical with x MUST have a limit (an 'x:N' cap or an uncounter that uses x), the checker warns otherwise (X is then at most 10).
        - With several Units as the target (allies, others, 'has:Order' ...), X is the TOTAL number of counters removed from those Units, and the
          largest X is the total number of that counter on them (your side only for allies). The Unit with the most counters loses them first.
          A single target (mypick, pick) is limited to the counters on that one Unit.
        - The computer always takes the biggest X. The cost of the Tactical itself is paid as usual; X is not a Lume cost.
    A Relic cannot pay a Unit cost on itself (rest / destroy / uncounter with 'self').
    A Relic CAN destroy itself as part of the fx:  ['raze', 1, 'self'].

    ---------------------------------------------------------------------
    13  COUNTERS
    ---------------------------------------------------------------------
    A counter is a named marker on a Unit. The plain name is its only identifier ('Dust', 'Frost').
    Names are compared without capitals, are 1 to 20 characters, and may contain letters, numbers, spaces, apostrophes and hyphens.
    A counter has no meaning of its own: it does what the cards that mention its name say.
    Counters exist only on Units in play and disappear when the Unit leaves play.
    - Put and remove     ['counter', 2, 'self', 'Dust'], ['uncounter', 1, 'self', 'Dust'], ['uncounter', 'all', 'allies', 'Frost'].
                         Any Unit target works. Removing more than a Unit has just removes what it has.
    - Scale a stat       ['buff', 1, 'self', 'counter:Dust'], also counters:Name and ecounters:Name (chapter 11).
    - Trigger            {tr: 'counter', ctr: 'Dust', fx: [...]} fires when a Dust counter is put on your Unit. Leave ctr out to react to any counter.
                         ocounter watches enemy Units.
    - Condition          if: {ctr: 'Dust', n: 3} = this Unit has 3 or more Dust counters.
    - Pay as a cost      cost: [['uncounter', 2, 'self', 'Dust']] on an activated ability.
    - Target by counter  'has:Dust' (your Units with a Dust counter) or 'ehas:Frost' (enemy Units with a Frost counter) in any effect.
    - Hold asleep        ['hold', 0, 'enemies', 'Frost'] as a passive effect: enemy Units with a Frost counter do not wake at Extraction.
    - Count what was removed   After an uncounter in the same ability, use the amount 'removed' in a later effect:
                         [['uncounter', 'all', 'self', 'Dust'], ['draw', 'removed']]. The text adds "where X is the number of counters removed".

    ---------------------------------------------------------------------
    14  TOKENS   (['summon', {...}])
    ---------------------------------------------------------------------
    ['summon', {name: 'Veyr Walker', atk: 1, hp: 1, faction: 'veyrani', sub: 'Scout', keyword: [['swift']], abilities: [...]}]
        name        the Token's name. Default 'Token'.   The artwork and the print ID are found BY THIS NAME (see the Token record below).
        atk, hp     default 1 and 1.   ['summon', [atk, hp]] is a short way to write just the stats.
        faction     faction of the Token (frame colour). Default: none.      sub  sub type. Default: none.
        keyword     list of keywords, like a card's keyword field.            Default: none.
        abilities   the Token's own abilities, written exactly like a card's abilities (any trigger, passive and act included, but NOT flash).
        Every field is optional. A Token has at least 0 ATK and 1 HP. An ability without tr or fx is ignored; the checker reports an unknown
        faction, keyword or trigger in a summon, and a flash ability on a Token.
    TOKEN RECORD:  a card with  token: true  gives every Token of that NAME its print ID and artwork:
        { id: 'V-63861', name: 'Veyr Walker', type: 'U', faction: 'veyrani', sub: 'Scout', cost: 0, atk: 1, hp: 1,
          keyword: [['swift']], token: true, flavor: '...', art: 'art/tokens/V-63861.webp' }
        - ONE record is reused by EVERY summon with that name, whatever stats or abilities that summon gives. Keep the name identical.
        - The record gives the print ID and the artwork. The Token's stats, faction, sub type, keywords and abilities come from the summon effect.
        - A different picture needs a different Token record with a different name.
        - A summon without a name is just "Token" and gets no custom artwork.

    ---------------------------------------------------------------------
    15  RULES QUICK REFERENCE
    ---------------------------------------------------------------------
    Start     Both players start with 20 Life and draw 7 cards.
    Zones     Logistic = your deck.  Hand.  Frontline = Units in play.  Vault = Relics in play.  Wasteland = discard pile.  The Void = removed (prune).
    Turn      Extraction (your Units wake, you gain 1 Lume, lose Life equal to your Echo Debt (Payday; Lume does not pay it), draw, then your "At Extraction" abilities) > Main > Battle > Main 2 > End.
    Unit      enters in PREPARE: it can block, but cannot attack before your next turn (Swift enters ready).
    states    STANDBY = ready.   REST = it attacked (it wakes at your next Extraction, unless a 'hold' effect keeps it asleep); a Resting Unit can neither
              attack nor block. A Tireless Unit does not Rest when it attacks.
    Lume      what you spend to play cards. The +1 Lume of each Extraction only fills up to 10 (the starting cap). Lume above 10 comes from effects and has no cap.
    Echo      a card with the Echo n keyword can be played with Lume you do not have yet (the missing Lume, up to n, becomes Echo Debt).
              At Extraction the Debt is paid from your Lume. If you cannot pay it all, you lose Life equal to the Debt instead, and the Debt is cleared.
    You WIN   when the opponent's Life is 0, or by LUME VICTORY: at the end of your turn you hold at least 30 Lume, then at least 90 at the end of your next turn,
              then at least 180 at the end of the turn after that: three turns IN A ROW. Missing a goal starts again at 30.
              Or when the opponent must draw a card and their Logistic is empty.
    You LOSE  by the same rules the other way round. Both at once = a draw.

    ---------------------------------------------------------------------
    16  CHECKLIST AND THE CONSOLE CHECKER
    ---------------------------------------------------------------------
    New card checklist
      [ ] id: faction letter + 5 digits, unique, same letter as the faction
      [ ] name unique;  type U / T / R;  faction one of the five
      [ ] Unit: sub, atk and hp.  Relic / Tactical: NO sub.   cost is a number.
      [ ] flavor and art are filled.   The artwork file exists at database/<art path>.
      [ ] Tactical: has {tr: 'flash', fx: [...]}.
      [ ] every effect has the right 2nd / 3rd / 4th item (chapter 7.2) and a real target (chapter 9)
      [ ] passive: only buff / hp / hold, target self | allies | others | enemies
      [ ] act: has a cost or max: n, and no pick target in the COST (a pick target in the fx is fine: the game asks you, the AI chooses)
      [ ] an ability that reacts to several events uses one tr list (tr: ['mill', 'discard']) with triggers from chapter 5
    When the page loads it checks every card. Open the console (F12): "CARD_DB problems" lists each mistake as  <card name>: <what is wrong>.
    The checker also reports duplicate print IDs and duplicate card names, and unknown keywords, triggers, effects and targets. Nothing is listed when everything is fine. A card with a mistake may behave wrongly, so fix the list before playing.

    FACTIONS  (shown at the bottom of this comment)
    ===================================================================== */

const FACTIONS = {
    veyrani: {name: 'Veyrani', letter: 'V', identity: 'Harmony / Survival'},
    astronav: {name: 'Astronav', letter: 'A', identity: 'Logic / Perfection'},
    caelor: {name: 'Caelor', letter: 'C', identity: 'Order / Civilization'},
    vulkar: {name: 'Vulkar', letter: 'K', identity: 'Passion / Freedom / Action'},
    veilborn: {name: 'Veilborn', letter: 'B', identity: 'Power / Sacrifice'}
};

const CARD_DB = [
    /* ---------- VEYRANI (Harmony / Survival) ---------- */
    {
        id: 'V-47962',
        name: 'Veriel, Scout Leader',
        type: 'U',
        faction: 'veyrani',
        sub: 'Leaders',
        cost: 1,
        atk: 1,
        hp: 2,
        keyword: [['toxic']],
        abilities: [
            {
                tr: 'act',
                cost: [['state', 'rest', 'self']],
                fx: [['summon', {name: 'Veyr Walker', faction: 'veyrani', sub: 'Scout', keyword: 'swift'}]]}
        ],
        flavor: 'Sahra-thalen veyra-ren, rahan-khar!',
        art: 'art/V-47962.webp'
    },
    {
        id: 'V-68245',
        name: 'Qarseem, Sand Warden',
        type: 'U',
        faction: 'veyrani',
        sub: 'Guardian',
        cost: 2,
        atk: 2,
        hp: 3,
        abilities: [
            {tr: 'enter', fx: [['lume', 1]]}
        ],
        flavor: 'Nara veylan a esh, nara en velath a esh.',
        art: 'art/V-68245.webp'
    },
    {
        id: 'V-24597',
        name: 'Shaqari, Caravan Elder',
        type: 'U',
        faction: 'veyrani',
        sub: 'Elders',
        cost: 2,
        atk: 2,
        hp: 3,
        abilities: [
            {tr: 'extract', if: 'ally', fx: [['lume', 1]]}
        ],
        flavor: 'Veyra-ren vel, rahan khar!',
        art: 'art/V-24597.webp'
    },
    {
        id: 'V-55093',
        name: 'Veyr Beacon',
        type: 'R',
        faction: 'veyrani',
        cost: 1,
        abilities: [
            {tr: 'ally', fx: [['summon', {name: 'Veyr Walker', faction: 'veyrani', sub: 'Scout', keyword: [['swift']]}]]}
        ],
        flavor: 'Nara Veyrani, nara en veylan a esh.',
        art: 'art/V-55093.webp'
    },
    {
        id: 'V-93174',
        name: 'Thareq, Wormrider Elder',
        type: 'U',
        faction: 'veyrani',
        sub: 'Elders',
        cost: 5,
        atk: 0,
        hp: 3,
        keyword: [['stomp']],
        abilities: [
            {
                tr: 'passive',
                fx: [['buff', 1, 'self', 'others']]
            }
        ],
        flavor: 'Velath sahel!',
        art: 'art/V-93174.webp'
    },
    {
        id: 'V-12463',
        name: 'Sqietch Reservoir',
        type: 'R',
        faction: 'veyrani',
        cost: 2,
        abilities: [
            {
                tr: 'ally',
                fx: [['lume', 1]]
            }
        ],
        flavor: 'Velan saren velir a halen.',
        art: 'art/V-12463.webp'
    },
    {
        id: 'V-30851',
        name: 'Sqietch Resupply',
        type: 'R',
        faction: 'veyrani',
        cost: 1,
        abilities: [
            {
                tr: 'act',
                cost: [['mill', 1]],
                fx: [['state', 'standby', 'mypick']],
                max: 1
            }
        ],
        flavor: 'Sahra sahel khar!',
        art: 'art/V-30851.webp'
    },
    {
        id: 'V-66786',
        name: 'Sqietch Device',
        type: 'R',
        faction: 'veyrani',
        cost: 1,
        abilities: [
            {
                tr: 'act',
                cost: [['lume', -1]],
                fx: [['summon', {name: 'Veyr Walker', faction: 'veyrani', sub: 'Scout', abilities: [{tr: 'death', fx: [['lume', 1]]}]}]],
                max: 1
            }
        ],
        flavor: 'Veyra ren khar!',
        art: 'art/V-66786.webp'
    },
    {
        id: 'V-52041',
        name: 'Scout Mission',
        type: 'T',
        faction: 'veyrani',
        cost: 1,
        abilities: [
            {
                tr: 'flash',
                fx: [['summon', {name: 'Veyr Walker', faction: 'veyrani', sub: 'Scout', keyword: 'swift'}]]
            }
        ],
        flavor: 'Nara sahra a zai.',
        art: 'art/V-52041.webp'
    },
    {
        id: 'V-63861',
        name: 'Veyr Walker',
        type: 'U',
        faction: 'veyrani',
        sub: 'Scout',
        cost: 0,
        atk: 0,
        hp: 0,
        keyword: [],
        token: true,
        flavor: 'Nara Veyrani veylan a esh.',
        art: 'art/tokens/V-63861.webp'
    },
    /* ============ OPERATORS (Units) ============ */
    {
        id: 'A-35443',
        name: 'Ex-syn, The Recycler',
        type: 'U',
        faction: 'astronav',
        sub: 'Engineer',
        cost: 3,
        atk: 1,
        hp: 1,
        keyword: [['echo', 2]],
        abilities: [
            {
                tr: 'act',
                max: 1,
                cost: [['mill', 1]],
                fx: [['draw', 1]],
            }
        ],
        flavor: 'Omik ion-um-i-ta nul ex-as',
        art: 'art/A-35443.webp'
    },
    {
        id: 'A-23665',
        name: 'Omnix, Vector Sentinel',
        type: 'U',
        faction: 'astronav',
        sub: 'Analyst',
        cost: 3,
        atk: 1,
        hp: 1,
        keyword: [['echo', 2]],
        abilities: [
            {
                tr: 'mill',
                fx: [['debt', 1, 'opp']],
            }
        ],
        flavor: 'Kelei-on ion-o-ta kel-a.',
        art: 'art/A-23665.webp'
    },
    {
        id: 'A-27693',
        name: 'Synaxion, Path Navigator',
        type: 'U',
        faction: 'astronav',
        sub: 'Navigators',
        cost: 3,
        atk: 1,
        hp: 1,
        keyword: [['echo', 2]],
        abilities: [
            {
                tr: 'debtup',
                fx: [['debt', 1, 'opp']],
            }
        ],
        flavor: 'Omik nav kelei.',
        art: 'art/A-27693.webp'
    },
    {
        id: 'A-33358',
        name: 'Kry, The Calibrator',
        type: 'U',
        faction: 'astronav',
        sub: 'Technician Engineer',
        cost: 4,
        atk: 1,
        hp: 1,
        keyword: [['echo', 3]],
        abilities: [
            {
                tr: 'debtdown',
                fx: [['retrieve', 1, 'shuffle']],
            }
        ],
        flavor: 'Vex exum.',
        art: 'art/A-33358.webp'
    },
    {
        id: 'A-37372',
        name: 'Ix, The Oracle Array',
        type: 'U',
        faction: 'astronav',
        sub: 'Array Machine',
        cost: 5,
        atk: 1,
        hp: 1,
        keyword: [['echo', 4]],
        abilities: [
            {
                tr: 'debtup',
                fx: [['mill', 1]]
            }
        ],
        flavor: 'Nai ion-va-on ion-o-en kry-um-ta kelka.',
        art: 'art/A-37372.webp'
    },
    {
        id: 'A-33084',
        name: 'Arkh, Lume Heart',
        type: 'U',
        faction: 'astronav',
        sub: 'Heart Engine',
        cost: 6,
        atk: 1,
        hp: 1,
        keyword: [['echo', 5]],
        abilities: [
            {
                tr: 'debtdown',
                fx: ['retrieve', 'delta', 'shuffle'],
            }
        ],
        flavor: 'Omik axik ionum ixikim nul nava, ion-o-ir kryka.',
        art: 'art/A-33084.webp'
    },
    {
        id: 'A-35180',
        name: 'Theta, Prism Cutter',
        type: 'U',
        faction: 'astronav',
        sub: 'Cutter Technician',
        cost: 6,
        atk: 1,
        hp: 1,
        keyword: [['echo', 5]],
        abilities: [
            {
                tr: 'mill',
                fx: [['debt', 'delta', 'opp']],
            }
        ],
        flavor: 'Omik ion-um kelei-en.',
        art: 'art/A-35180.webp'
    },
    /* ============ TOOLS (Relics) ============ */
    {
        id: 'A-58381',
        name: 'Recalculate',
        type: 'R',
        faction: 'astronav',
        cost: 3,
        keyword: [['echo', 2]],
        abilities: [
            {
                tr: 'act',
                max: 1,
                cost: [['mill', 1]],
                fx: [['debt', 1, 'opp']]
            }
        ],
        flavor: 'Nai arkh-en mir-en ionum-ta kel-a.',
        art: 'art/A-58381.webp'
    },
    {
        id: 'A-58429',
        name: 'Synthetic Lume',
        type: 'R',
        faction: 'astronav',
        cost: 3,
        keyword: [['echo', 2]],
        abilities: [
            {
                tr: 'mill',
                max: 1,
                fx: [['lume', 3]]
            }
        ],
        flavor: 'Kry-ek ion-um ion-a.',
        art: 'art/A-58429.webp'
    },
    {
        id: 'A-35462',
        name: 'Biofuel Recycle',
        type: 'R',
        faction: 'astronav',
        cost: 4,
        keyword: [['echo', 3]],
        abilities: [
            {
                tr: 'debtup',
                max: 1,
                fx: [['debt', 2, 'opp']]
            }
        ],
        flavor: 'Axion-va ion-um-i kryik.',
        art: 'art/A-35462.webp'
    },
    {
        id: 'A-58430',
        name: 'Decommission',
        type: 'R',
        faction: 'astronav',
        cost: 4,
        keyword: [['echo', 3]],
        abilities: [
            {
                tr: 'mill',
                fx: [['retrieve', 1, 'shuffle']]
            }
        ],
        flavor: 'Ionum nul ex-as, ion-a.',
        art: 'art/A-58430.webp'
    },
    {
        id: 'A-34084',
        name: 'Gravity Lock',
        type: 'R',
        faction: 'astronav',
        cost: 4,
        keyword: [['echo', 3]],
        abilities: [
            {
                tr: 'act',
                max: 1,
                cost: [['debt', 1, 'me']],
                fx: [['retrieve', 1, 'shuffle']]
            }
        ],
        flavor: 'Rha axik.',
        art: 'art/A-34084.webp'
    },
    {
        id: 'A-52716',
        name: 'Archive Core',
        type: 'R',
        faction: 'astronav',
        cost: 5,
        keyword: [['echo', 4]],
        abilities: [
            {
                tr: 'relog',
                fx: [['steal', 1]]
            }
        ],
        flavor: 'Omik ion-i-ta mirke.',
        art: 'art/A-52716.webp'
    },
    {
        id: 'A-35461',
        name: 'Overcharge',
        type: 'R',
        faction: 'astronav',
        cost: 5,
        keyword: [['echo', 4]],
        abilities: [
            {
                tr: 'relog',
                fx: [['drain', 1]],
            }
        ],
        flavor: 'Ionum nul omik, ion-a.',
        art: 'art/A-35461.webp'
    },
    /* ============ TOOLS (Tactical) ============ */
    {
        id: 'A-52718',
        name: 'Factory Reset',
        type: 'T',
        faction: 'astronav',
        cost: 5,
        keyword: [['echo', 4]],
        abilities: [
            {
                tr: 'flash',
                fx: [['adddebt', 'debt', 'opp']]
            }
        ],
        flavor: 'Omik ion-i-ta mirke.',
        art: 'art/A-52718.webp'
    },

    /* ---------- CAELOR  (Order / Civilization) ---------- */

    /* CAELOR  UNIT */
    {
        id: 'C-30981',
        name: 'Oasiacustod, The Guard',
        type: 'U',
        faction: 'caelor',
        sub: 'Resources Minister',
        cost: 1,
        atk: 1,
        hp: 2,
        abilities: [
            {
                tr: 'act',
                max: 1,
                fx: [['counter', 1, 'mypick', 'Politic'], ['lume', 1]],
            }
        ],
        flavor: 'Ordo servat.',
        art: 'art/C-30981.webp'
    },
    {
        id: 'C-57100',
        name: 'Signumar, Bannerbearer',
        type: 'U',
        faction: 'caelor',
        sub: 'Defense Minister',
        cost: 2,
        atk: 1,
        hp: 3,
        abilities: [
            {
                tr: 'act',
                max: 1,
                fx: [['uncounter', 'all', 'self', 'Politic'], ['lume', 'removed']]
            }
        ],
        flavor: 'Lev the flaga. Valid tua peden.',
        art: 'art/C-57100.webp'
    },
    {
        id: 'C-62724',
        name: 'Vitagladium, The Lifeblade',
        type: 'U',
        faction: 'caelor',
        sub: 'Millitary Minister',
        cost: 2,
        atk: 1,
        hp: 4,
        abilities: [
            {
                tr: 'act',
                max: 1,
                fx: [['uncounter', 'all', 'self', 'Politic'], ['heal', 'removed:10', 'me']]
            }
        ],
        flavor: 'Un gladium pactat ad custod.',
        art: 'art/C-62724.webp'
    },
    {
        id: 'C-65498',
        name: 'Phalanx Legate',
        type: 'U',
        faction: 'caelor',
        sub: 'Resources Minister',
        cost: 2,
        atk: 1,
        hp: 4,
        abilities: [
            {
                tr: 'act',
                max: 1,
                fx: [['uncounter', 'all', 'self', 'Politic'], ['disable', 'ehand', 'all', 'next'], ['disable', 'enemies', 'all', 'next']]
            }
        ],
        flavor: 'Per concordia, pax.',
        art: 'art/C-65498.webp'
    },
    {
        id: 'C-39564',
        name: 'Praetorum, Aurelion Titan',
        type: 'U',
        faction: 'caelor',
        sub: 'Defense Minister',
        cost: 4,
        atk: 2,
        hp: 4,
        abilities: [
            {
                tr: 'act',
                max: 1,
                fx: [['uncounter', 'all', 'self', 'Politic'], ['hp', 1, 'allies']]
            }
        ],
        flavor: 'Potestas hav.',
        art: 'art/C-39564.webp'
    },
    {
        id: 'C-29515',
        name: 'Rector Auresol',
        type: 'U',
        faction: 'caelor',
        sub: 'Defense Minister',
        cost: 4,
        atk: 2,
        hp: 5,
        abilities: [
            {
                tr: 'act',
                max: 1,
                fx: [['uncounter', 'all', 'self', 'Politic'], ['buff', -1, 'enemies']]
            }
        ],
        flavor: 'The regia da. Ordo distribut.',
        art: 'art/C-29515.webp'
    },
    /* CAELOR  TACTICAL */
    {
        id: 'C-29330',
        name: 'Mobil the flota',
        type: 'T',
        faction: 'caelor',
        cost: 2,
        abilities: [
            {
                tr: 'flash',
                fx: [['counter', 2, 'allies', 'Politic']]
            }
        ],
        flavor: 'Potestas hav pondus.',
        art: 'art/C-29330.webp'
    },
    {
        id: 'C-29331',
        name: 'Aqualacum',
        type: 'T',
        faction: 'caelor',
        cost: 2,
        abilities: [
            {
                tr: 'flash',
                fx: [['counter', 'others', 'allies', 'Politic']]
            }
        ],
        flavor: 'Lume es il mater mas sanctum de galaxia.',
        art: 'art/C-29331.webp'
    },
    /* CAELOR  RELIC */
    {
        id: 'C-57101',
        name: 'Praedicolum',
        type: 'R',
        faction: 'caelor',
        cost: 3,
        abilities: [
            {
                tr: 'aattack',
                max: 3,
                fx: [['counter', 1, 'allies', 'Politic']]
            }
        ],
        flavor: 'Liberia sine structum es ruina.',
        art: 'art/C-57101.webp'
    },
    {
        id: 'C-57104',
        name: 'Sinner',
        type: 'R',
        faction: 'caelor',
        cost: 3,
        abilities: [
            {
                tr: ['odebtup', 'debtup'],
                max: 3,
                fx: [['counter', 'debt', 'allies', 'Politic']]
            }
        ],
        flavor: 'Echia de sin!.',
        art: 'art/C-57104.webp'
    },
    {
        id: 'C-57102',
        name: 'Senatum Revisio',
        type: 'R',
        faction: 'caelor',
        cost: 2,
        abilities: [
            {
                tr: 'oanyplay',
                max: 3,
                fx: [['counter', 1, 'allies', 'Politic']]
            }
        ],
        flavor: 'Strategia es potestas primar.',
        art: 'art/C-57102.webp'
    },
    {
        id: 'C-36461',
        name: 'Aurastelar',
        type: 'R',
        faction: 'caelor',
        cost: 2,
        abilities: [
            {
                tr: 'anyplay',
                max: 3,
                fx: [['counter', 1, 'allies', 'Politic']]
            }
        ],
        flavor: 'Ordo es the via tantum ad sustin civilia de enair.',
        art: 'art/C-36461.webp'
    },

    /* ---------- VULKAR  (Passion / Freedom / Action) ---------- */
    /* ---------- UNITS ---------- */
    {
        id: 'K-23665',
        name: 'Dune Skirmisher',
        type: 'U',
        faction: 'vulkar',
        sub: 'Skirmisher',
        cost: 1,
        atk: 1,
        hp: 1,
        keyword: [['swift']],
        flavor: 'Take what calls you.',
        art: 'art/K-23665.webp'
    },
    {
        id: 'K-25316',
        name: 'Sahri Raider',
        type: 'U',
        faction: 'vulkar',
        sub: 'Marauder',
        cost: 1,
        atk: 1,
        hp: 1,
        keyword: [['swift']],
        abilities: [
            {
                tr: 'attack',
                fx: [['dmg', 1, 'enemies']]
            }
        ],
        flavor: 'Hesitation is the only enemy.',
        art: 'art/K-25316.webp'
    },
    {
        id: 'K-50524',
        name: 'Ember Lancer',
        type: 'U',
        faction: 'vulkar',
        sub: 'Cavalry',
        cost: 2,
        atk: 2,
        hp: 1,
        abilities: [
            {
                tr: 'attack',
                fx: [['dmg', 2, 'opp']]
            }
        ],
        flavor: 'A spark on the horizon, then the charge.',
        art: 'art/K-50524.webp'
    },
    {
        id: 'K-63121',
        name: 'Glasshide Brute',
        type: 'U',
        faction: 'vulkar',
        sub: 'Juggernaut',
        cost: 3,
        atk: 2,
        hp: 2,
        keyword: [['echo', 1]],
        abilities: [
            {
                tr: 'attack',
                fx: [['surge', 1, 'allies']]
            }
        ],
        flavor: 'Forged in the heat of two suns.',
        art: 'art/K-63121.webp'
    },
    {
        id: 'K-55819',
        name: 'Dust Colossus',
        type: 'U',
        faction: 'vulkar',
        sub: 'Colossus',
        cost: 4,
        atk: 3,
        hp: 2,
        keyword: [['echo', 2]],
        abilities: [
            {
                tr: 'attack',
                fx: [['surge', -2, 'enemies']]
            }
        ],
        flavor: 'Burn forward.',
        art: 'art/K-55819.webp'
    },
    /* ---------- TACTICAL ---------- */
    {
        id: 'K-52716',
        name: 'Burn Forward',
        type: 'T',
        faction: 'vulkar',
        cost: 1,
        abilities: [
            {
                tr: 'flash',
                fx: [['dmg', 3, 'me'], ['buff', 2, 'allies']]
            }
        ],
        flavor: 'No brakes. No regrets.',
        art: 'art/K-52716.webp'
    },
    {
        id: 'K-50709',
        name: 'Solar Flare',
        type: 'T',
        faction: 'vulkar',
        cost: 1,
        abilities: [
            {
                tr: 'flash',
                fx: [['dmg', 2, 'enemies']]
            }
        ],
        flavor: 'Both suns blink. Then, silence.',
        art: 'art/K-50709.webp'
    },
    
    /* ---------- VEILBORN  (Power / Sacrifice) ---------- */
    {
        id: 'B-64772',
        name: 'Echo Drifter',
        type: 'U',
        faction: 'veilborn',
        sub: 'Drifter Borrower',
        cost: 3,
        atk: 1,
        hp: 3,
        keyword: [['echo', 2], ['lifesteal']],
        abilities: [
            {
                tr: 'echo',
                fx: [['draw', 1]]
            }
        ],
        flavor: 'Tomorrow\'s debt, today\'s strength.',
        art: 'art/B-64772.webp'
    },
    {
        id: 'B-58381',
        name: 'Rite Priest',
        type: 'U',
        faction: 'veilborn',
        sub: 'Priest Ritualist',
        cost: 3,
        atk: 1,
        hp: 2,
        abilities: [
            {
                tr: 'play',
                fx: [['destroy', 1, 'mypick'], ['draw', 2]]
            }
        ],
        flavor: 'Ascend through sacrifice.',
        art: 'art/B-58381.webp'
    },
    {
        id: 'B-60018',
        name: 'Ashen Revenant',
        type: 'U',
        faction: 'veilborn',
        sub: 'Revenant Remnant',
        cost: 4,
        atk: 2,
        hp: 2,
        abilities: [
            {
                tr: 'play',
                fx: [['dmg', 2, 'me'], ['recur', 1]]
            }
        ],
        flavor: 'Death is only a deferred payment.',
        art: 'art/B-60018.webp'
    },
    {
        id: 'B-58382',
        name: 'Void Reaver',
        type: 'U',
        faction: 'veilborn',
        sub: 'Reaver Raider',
        cost: 5,
        atk: 4,
        hp: 2,
        keyword: [['echo', 3]],
        abilities: [
            {
                tr: 'attack',
                fx: [['dmg', 2, 'pick']]
            }
        ],
        flavor: 'Power that was paid for.',
        art: 'art/B-58382.webp'
    },
    {
        id: 'B-63676',
        name: 'Grave Tapper',
        type: 'U',
        faction: 'veilborn',
        sub: 'Tapper Ghoul',
        cost: 3,
        atk: 2,
        hp: 1,
        abilities: [
            {
                tr: 'death',
                fx: [['lume', 3]]
            }
        ],
        flavor: 'Even silence leaves a charge.',
        art: 'art/B-63676.webp'
    },
    {
        id: 'B-19624',
        name: 'Tithe',
        type: 'T',
        faction: 'veilborn',
        cost: 1,
        abilities: [
            {
                tr: 'flash',
                fx: [['dmg', 2, 'me'], ['destroy', 1, 'pick']]
            }
        ],
        flavor: 'Cost reveals worth.',
        art: 'art/B-19624.webp'
    },
    {
        id: 'B-37975',
        name: 'Reprieve',
        type: 'T',
        faction: 'veilborn',
        cost: 1,
        abilities: [
            {
                tr: 'flash',
                fx: [['pay', 2], 'or', ['lume', 2], 'then', ['draw', 1]]
            }
        ],
        flavor: 'A debt forgiven is a debt deferred.',
        art: 'art/B-37975.webp'
    },
    {
        id: 'B-59532',
        name: 'Ossuary',
        type: 'R',
        faction: 'veilborn',
        cost: 2,
        abilities: [
            {
                tr: 'oenter',
                fx: [['steal', 1]]
            }
        ],
        flavor: 'The fallen still pay their dues.',
        art: 'art/B-59532.webp'
    },
    {
        id: 'B-64957',
        name: 'Grave Altar',
        type: 'R',
        faction: 'veilborn',
        cost: 2,
        abilities: [
            {
                tr: 'ally',
                fx: [['lume', 2]]
            },
            {
                tr: 'act',
                cost: [['raze', 1, 'self']],
                fx: [['lume', 5]]
            }
        ],
        flavor: 'Every end is an offering.',
        art: 'art/B-64957.webp'
    },
    {
        id: 'B-57100',
        name: 'Blood Siphon',
        type: 'T',
        faction: 'veilborn',
        cost: 1,
        abilities: [
            {
                tr: 'flash',
                fx: [['dmg', 3, 'me'], 'choose', ['raze', 1, 'relic'], 'or', ['destroy', 1, 'pick']]
            }
        ],
        flavor: 'Pain is a currency. Spend it.',
        art: 'art/B-57100.webp'
    },
];