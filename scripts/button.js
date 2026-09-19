/*
 * The HUD button: where it sits, dragging it around, preset positions.
 *
 * The position is kept as fractions of the free screen space (0,0 is the
 * bottom-left corner, 1,1 the top-right one), so it survives resolution and
 * window size changes.
 *
 * Rhino notes: no `const` inside functions, no JS functions passed to
 * overloaded Java methods, and never Core.settings.put() a JS number - it
 * arrives as a Double and Settings rejects it ("Invalid object stored").
 */

const i18n = require("i18n");
const ui = require("ui");

const enabledKey = "prodcalc-enabled";
const lockedKey = "prodcalc-locked";
/** slider setting: 0 = custom (dragged), 1.. = presets below */
const presetKey = "prodcalc-position";
/** "x,y" fractions as a string */
const positionKey = "prodcalc-pos";

/** [x, y] per preset index; index 0 means "wherever it was dragged". */
const presets = [
    null,
    [0, 0.5],   //left, middle
    [0, 1],     //left, top
    [0, 0],     //left, bottom
    [1, 0.5],   //right, middle
    [1, 1],     //right, top
    [1, 0],     //right, bottom
    [0.5, 1],   //top, middle
    [0.5, 0]    //bottom, middle
];
const defaultPreset = 1;

/** Drag starts only after the pointer moves this far, so taps stay clicks. */
const dragThreshold = 10;

let posX = 0;
let posY = 0.5;
let dragging = false;

function clamp(value){
    return Math.max(0, Math.min(1, value));
}

function hudShown(){
    try{
        return Vars.ui.hudfrag.shown;
    }catch(e){
        return true;
    }
}

function load(){
    let text = "";
    try{
        text = String(Core.settings.getString(positionKey, ""));
    }catch(e){}

    let parts = text.split(",");
    if(parts.length === 2 && !isNaN(parseFloat(parts[0])) && !isNaN(parseFloat(parts[1]))){
        posX = clamp(parseFloat(parts[0]));
        posY = clamp(parseFloat(parts[1]));
        return;
    }

    let preset = presets[defaultPreset];
    try{
        let index = Core.settings.getInt(presetKey, defaultPreset);
        if(presets[index] != null) preset = presets[index];
    }catch(e){}
    posX = preset[0];
    posY = preset[1];
}

function save(){
    //a string, see the note at the top of the file
    Core.settings.put(positionKey, posX.toFixed(4) + "," + posY.toFixed(4));
}

/** Called by the settings slider. */
function applyPreset(index){
    let preset = presets[index];
    if(preset == null) return;
    posX = preset[0];
    posY = preset[1];
    save();
}

/** After a drag the settings slider should say "custom" instead of the last preset. */
function markCustom(){
    try{
        //an Integer object, not a JS number (see the note at the top)
        Core.settings.put(presetKey, new java.lang.Integer(0));
        Vars.ui.settings.game.rebuild();
    }catch(e){}
}

function presetName(index){
    return i18n.t("pos." + index);
}

/** Moves the button to its saved spot inside its parent. */
function place(wrap){
    if(dragging) return;
    let parent = wrap.parent;
    if(parent == null) return;
    let freeX = Math.max(0, parent.getWidth() - wrap.getWidth());
    let freeY = Math.max(0, parent.getHeight() - wrap.getHeight());
    wrap.setPosition(posX * freeX, posY * freeY);
}

function isClass(object, name){
    try{
        let type = object.getClass();
        while(type != null){
            if(String(type.getSimpleName()) === name) return true;
            type = type.getSuperclass();
        }
    }catch(e){}
    return false;
}

/**
 * Stops the pending click once a press turns into a drag. A button has more
 * than one click listener: its own (pressed look) and the one clicked(...)
 * added to open the calculator, so all of them are cancelled.
 */
function cancelClicks(button){
    let listeners = button.getListeners();
    for(let i = 0; i < listeners.size; i++){
        let listener = listeners.get(i);
        if(isClass(listener, "ClickListener")) listener.cancel();
    }
}

/** Press and drag the button to move it; a plain tap still opens the calculator. */
function dragListener(wrap, button){
    let start = null;

    return new JavaAdapter(InputListener, {
        touchDown: (event, x, y, pointer, key) => {
            if(Core.settings.getBool(lockedKey)) return false;
            start = {x: event.stageX, y: event.stageY, wrapX: wrap.x, wrapY: wrap.y};
            dragging = false;
            return true;
        },

        touchDragged: (event, x, y, pointer) => {
            if(start == null) return;
            let dx = event.stageX - start.x;
            let dy = event.stageY - start.y;

            if(!dragging){
                if(Math.abs(dx) + Math.abs(dy) < Scl.scl(dragThreshold)) return;
                dragging = true;
                //the press became a drag: releasing must not open the calculator
                cancelClicks(button);
            }

            let parent = wrap.parent;
            if(parent == null) return;
            let freeX = Math.max(1, parent.getWidth() - wrap.getWidth());
            let freeY = Math.max(1, parent.getHeight() - wrap.getHeight());
            posX = clamp((start.wrapX + dx) / freeX);
            posY = clamp((start.wrapY + dy) / freeY);
            wrap.setPosition(posX * freeX, posY * freeY);
        },

        touchUp: (event, x, y, pointer, key) => {
            if(dragging){
                save();
                markCustom();
            }
            dragging = false;
            start = null;
        }
    });
}

/** Adds the settings entries: show button, lock it, preset position. */
function addSettings(){
    let game = Vars.ui.settings.game;
    game.checkPref(enabledKey, true);
    game.checkPref(lockedKey, false);
    //seven arguments: the only sliderPref overload with that many, so Rhino can pick it
    game.sliderPref(presetKey, defaultPreset, 0, presets.length - 1, 1, index => presetName(index), index => applyPreset(index));
}

/** Builds the button and puts it on the HUD. */
function create(){
    load();

    //Group.fill(fn) is ambiguous for Rhino (fill(Cons) vs fill(DrawRect)), so
    //the table is built and added by hand; it only wraps the button, and is
    //moved around absolutely by place()
    let wrap = new Table();
    wrap.name = "production-calculator";
    wrap.touchable = Touchable.childrenOnly;

    let cell = wrap.button(ui.buttonIcon(), Styles.cleari, 34, () => ui.show())
        .size(54)
        .name("prodcalc-open")
        .tooltip(i18n.t("button"));
    let button = cell.get();
    wrap.pack();

    //element.visible(fn) resolves to the boolean field in Rhino, not the
    //method, so the visibility provider is assigned directly
    wrap.visibility = () => Core.settings.getBool(enabledKey) && hudShown();
    wrap.update(() => place(wrap));
    button.addListener(dragListener(wrap, button));

    Vars.ui.hudGroup.addChild(wrap);
    place(wrap);
    return wrap;
}

exports.create = create;
exports.addSettings = addSettings;
exports.applyPreset = applyPreset;
exports.position = () => [posX, posY];
