/*
 * Production Calculator
 *
 * Adds a calculator button to the in-game HUD and a rebindable key that opens
 * it. Settings -> Game: show/lock the button and pick its position (it can
 * also be dragged). Settings -> Controls: the key.
 */

const i18n = require("i18n");
const calc = require("calc");
const ui = require("ui");
const button = require("button");

/**
 * Open/close key. Registered at load time so the Controls dialog lists it
 * under its own "Production calculator" category, where it can be rebound.
 */
const toggleKey = KeyBind.add("prodcalc_toggle", KeyCode.k, "prodcalc");

function loadKey(){
    //add() starts from the default key; the player's own choice is in settings
    try{
        toggleKey.load();
    }catch(e){}
}

loadKey();

Events.on(ClientLoadEvent, () => {
    button.addSettings();
    loadKey();
    button.create();
    Log.info("[production-calculator] loaded");
});

//the key works even when the button is hidden, but never while typing
Events.run(Packages.mindustry.game.EventType.Trigger.update, () => {
    if(!Vars.state.isGame() || Core.scene == null || Core.scene.hasField()) return;
    if(Core.input.keyTap(toggleKey)) ui.toggle();
});

//block cards depend on the map (drills only list ores that are on it), so
//everything read from them is thrown away when another map loads
Events.on(Packages.mindustry.game.EventType.WorldLoadEvent, () => calc.reset());
