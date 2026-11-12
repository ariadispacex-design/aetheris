/* database/database/sounds.js - database/sounds: which mp3 plays when. Edit the file names to match your own sound files.

   1) SOUND_FILES   sound name -> your mp3 file (path relative to index.html). A sound can also be { src: 'database/sounds/hit.mp3', volume: .8, rate: 1.1 }
                    (volume 0 to 1, rate = playback speed / pitch). Add as many sound names as you like.
   2) SOUND_MUSIC   the looping background music, one file per screen:  home = the home screen and every menu page,
                    match = only while a match is on (the two never play together; they cross-fade when you press Play / leave a match).
                    '' = a built-in synthesized ambient drone,  'none' = silence.  A plain string ('database/sounds/x.mp3') uses one file for both.
   3) SOUND_IDS     clicking the element with this id (or matching this CSS selector, e.g. '.hs-mode') plays that sound name. '' = silent.
                    Any other <button>, nav tab or filter chip plays SOUND_IDS.default (the 'click' sound).
   4) SOUND_EVENTS  game event -> sound name. Events with an "opp" version (oppDraw, oppPlayUnit ...) fire for the opponent's side;
                    if you do not list the opp version, the plain one plays for both players. Set an opp event to '' to keep it silent.
   5) SOUND_GAP     events that happen at the same moment (attack, hit, destroy ...) are played one after another, this many milliseconds apart.

   Game events fired by the match:
     turnStart  oppTurnStart        a turn begins (yours / the opponent's)
     draw  oppDraw                  a card is drawn          (also: discard, mill, counter, return, enter, cast, lumeup ... any event the engine emits)
     playUnit  playRelic  playTactic  playCard     a card is played (playCard = any type; oppPlayUnit ... for the opponent)
     attack  oppAttack              attackers are declared
     unitHit  oppUnitHit            one of your / the opponent's Units took damage
     unitDestroyed  oppUnitDestroyed
     damageTaken                    YOUR Life went down            damageDealt   the opponent's Life went down
     lifeGain                       YOUR Life went up              oppLifeGain   the opponent's Life went up
     victory  defeat  drawGame      the match ended
   Elsewhere in the code:  AUDIO.play('soundName')  or  AUDIO.event('eventName')  plays a sound from anywhere. */

const SOUND_FILES = {
    /* interface */
    click: 'database/sounds/click.mp3',
    confirm: 'database/sounds/confirm.mp3',
    back: 'database/sounds/back.mp3',
    open: 'database/sounds/open.mp3',
    /* match */
    turnStart: 'database/sounds/turn_start.mp3',
    draw: 'database/sounds/draw.mp3',
    playUnit: 'database/sounds/play_unit.mp3',
    playRelic: 'database/sounds/play_relic.mp3',
    playTactic: 'database/sounds/play_tactic.mp3',
    attack: 'database/sounds/attack.mp3',
    hit: 'database/sounds/hit.mp3',
    destroy: 'database/sounds/destroy.mp3',
    damageTaken: 'database/sounds/damage_taken.mp3',
    damageDealt: 'database/sounds/damage_dealt.mp3',
    heal: 'database/sounds/heal.mp3',
    lume: 'database/sounds/lume.mp3',
    victory: 'database/sounds/victory.mp3',
    defeat: 'database/sounds/defeat.mp3'
};

const SOUND_MUSIC = {
    home: 'database/sounds/home.mp3',        /* home screen, Profile, Decks, Packs ... (change to your own file) */
    match: 'database/sounds/ambient.mp3'      /* only during a match */
};

const SOUND_IDS = {
    default: 'click',
    hmPlay: 'confirm',      /* Play (home screen) */
    hsPlay: 'confirm',      /* Play (match select) */
    hmGear: 'open',         /* Settings gear */
    hsX: 'back',            /* close match select */
    hstX: 'back',           /* close Settings */
    hstDone: 'back'
};

const SOUND_EVENTS = {
    turnStart: 'turnStart',
    draw: 'draw',
    playUnit: 'playUnit',
    playRelic: 'playRelic',
    playTactic: 'playTactic',
    attack: 'attack',
    unitHit: 'hit',
    unitDestroyed: 'destroy',
    damageTaken: 'damageTaken',
    damageDealt: 'damageDealt',
    lifeGain: 'heal',
    lumeup: 'lume',
    victory: 'victory',
    defeat: 'defeat',
    drawGame: 'defeat'
};

const SOUND_GAP = 90;
