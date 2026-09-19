/*
 * The calculator panel itself.
 *
 * Rhino notes, both learned the hard way:
 * - never declare `const` inside a function (evaluated once in loops), use `let`;
 * - Table.table(fn) and Table.button(fn, style, fn) are ambiguous overloads
 *   for Rhino and crash the game, so use sub() and contentButton() below.
 */

const calc = require("calc");
const i18n = require("i18n");
const t = i18n.t;

const spriteName = "production-calculator-calc";

let dialog = null;
let head = null;
let body = null;

/** {kind, c} of the resource being produced */
let target = null;
let amount = 10;
let perMinute = false;
let planet = null;
let planetSet = false;
/** true: mined/pumped resources are expanded into drills and pumps */
let expandExtraction = true;
/** resource key -> recipe id or calc.RAW */
let choices = {};
let result = null;

// ---------------------------------------------------------------- helpers

/** Same as parent.table(builder). */
function sub(parent, builder){
    let table = new Table();
    builder(table);
    return parent.add(table);
}

/** Same as parent.button(builder, style, listener). */
function contentButton(parent, style, builder, listener){
    let button = new Button(style);
    builder(button);
    button.clicked(listener);
    return parent.add(button);
}

function drawable(region){
    return new TextureRegionDrawable(region);
}

/** Icon for the HUD button: mod sprite if it packed, otherwise a built-in one. */
function buttonIcon(){
    try{
        if(Core.atlas.has(spriteName)) return drawable(Core.atlas.find(spriteName));
    }catch(e){}
    return Icon.book;
}

function heatIcon(){
    try{
        return StatusEffects.burning.uiIcon;
    }catch(e){
        return Core.atlas.find("error");
    }
}

/** TextureRegion of a resource; heat has no content of its own. */
function iconOf(kind, content){
    return kind === "heat" ? heatIcon() : content.uiIcon;
}

function nameOf(kind, content){
    return kind === "heat" ? t("heat") : String(content.localizedName);
}

function fixed(value){
    if(!(value > 0)) return "0";
    if(value >= 1000) return String(Strings.autoFixed(value, 0));
    if(value >= 100) return String(Strings.autoFixed(value, 1));
    return String(Strings.autoFixed(value, 2));
}

/** Items and liquids are flows in the selected unit; heat is a steady amount. */
function amountText(kind, perSecond){
    if(kind === "heat") return fixed(perSecond) + " " + t("heatunit");
    return fixed(perMinute ? perSecond * 60 : perSecond) + t(perMinute ? "permin" : "persec");
}

function wholeCount(count){
    return Math.ceil(count - 0.0001);
}

function columns(){
    return Math.max(2, Math.min(5, Math.floor(Core.graphics.getWidth() / Scl.scl(300))));
}

function planetOptions(){
    let list = [null];
    try{ if(Planets.serpulo != null) list.push(Planets.serpulo); }catch(e){}
    try{ if(Planets.erekir != null) list.push(Planets.erekir); }catch(e){}
    return list;
}

function defaultPlanet(){
    try{
        if(Vars.state.isGame() && Vars.state.rules.planet != null) return Vars.state.rules.planet;
    }catch(e){}
    try{ return Planets.serpulo; }catch(e){}
    return null;
}

function planetName(){
    return planet == null ? t("planet.any") : String(planet.localizedName);
}

function cyclePlanet(){
    let list = planetOptions();
    let index = 0;
    for(let i = 0; i < list.length; i++){
        if(calc.samePlanet(list[i], planet) || (list[i] == null && planet == null)) index = i;
    }
    planet = list[(index + 1) % list.length];
}

function hidden(content){
    try{ return content.isHidden(); }catch(e){ return false; }
}

/** The current map only matters when planning for the planet it is on. */
function planningForThisMap(){
    try{
        if(!Vars.state.isGame()) return false;
        return planet == null || calc.samePlanet(planet, Vars.state.rules.planet);
    }catch(e){
        return false;
    }
}

function options(){
    return {planet: planet, expandExtraction: expandExtraction, onMap: planningForThisMap()};
}

/** Where a recipe works: ore, water, walls, vents... Empty when anywhere. */
function terrainText(recipe){
    let terrain = recipe.terrain;
    if(terrain == null) return "";
    let list = terrain.names.join(", ");

    if(terrain.type === "ore") return t("terrain.ore") + ": " + list;
    if(terrain.type === "wallore") return t("terrain.wallore") + ": " + list;
    if(terrain.type === "floor") return t("terrain.floor") + ": " + list + (recipe.variant !== 1 ? " (x" + fixed(recipe.variant) + ")" : "");
    if(terrain.type === "walls") return t("terrain.walls") + ": " + list + " (" + t("terrain.upto") + " x" + fixed(terrain.best) + ")";
    if(terrain.type === "attribute") return t("terrain.attribute") + ": " + list;
    if(terrain.type === "unit") return t("terrain.unit");
    return "";
}

/** Warnings shown under a recipe in the chooser. */
function recipeWarnings(recipe){
    let out = [];
    let reason = calc.unavailable(recipe);
    if(reason != null) out.push(t("avail." + reason));
    if(!calc.onPlanet(recipe, planet)) out.push(t("avail.planet"));
    if(planningForThisMap() && calc.terrainOnMap(recipe) === false) out.push(t("avail.map"));
    if(recipe.random) out.push(t("random"));
    if(recipe.unknown) out.push(t("unknown"));
    return out;
}

/** Where the numbers of a recipe come from, when not simply the block card. */
function originText(recipe){
    if(recipe.origin === "calc") return t("origin.calc");
    if(recipe.origin === "unit") return t("origin.unit");
    return "";
}

// ------------------------------------------------------------------ panel

function show(){
    if(dialog == null) create();
    if(!planetSet){
        planet = defaultPlanet();
        planetSet = true;
    }
    refresh();
    dialog.show();
}

function create(){
    calc.build();

    dialog = new BaseDialog(t("title"));
    dialog.addCloseButton();
    dialog.buttons.button(t("copy"), Icon.copy, () => copySummary()).size(200, 60).disabled(b => result == null);
    dialog.buttons.button(t("reset"), Icon.refresh, () => {
        choices = {};
        refresh();
    }).size(200, 60);

    sub(dialog.cont, table => head = table).growX().pad(4).row();
    dialog.cont.image().color(Pal.accent).height(4).growX().pad(2).row();
    dialog.cont.pane(pane => {
        body = pane;
        pane.top().left();
    }).grow();
}

function refresh(){
    rebuildHead();
    rebuildBody();
}

function rebuildHead(){
    if(head == null) return;
    head.clear();
    head.left();

    sub(head, row => {
        row.left();
        row.add(t("target")).color(Pal.accent).padRight(8);
        row.button(target == null ? Icon.add : drawable(iconOf(target.kind, target.c)), Styles.cleari, 32, () => showPicker())
            .size(50).padRight(8).tooltip(t("select"));
        row.add(target == null ? t("select") : nameOf(target.kind, target.c)).padRight(8);
    }).growX().left().row();

    sub(head, row => {
        row.left();
        row.add(t("rate")).color(Pal.accent).padRight(8);
        row.field("" + amount, text => {
            let value = parseFloat(text);
            if(!isNaN(value) && value > 0){
                amount = value;
                rebuildBody();
            }
        }).width(110).padRight(8);

        row.button(perMinute ? t("unit.min") : t("unit.sec"), () => {
            perMinute = !perMinute;
            refresh();
        }).width(150).height(46).padRight(16);

        row.add(t("planet")).color(Pal.accent).padRight(8);
        row.button(planetName(), () => {
            cyclePlanet();
            refresh();
        }).width(170).height(46).tooltip(t("planet.hint"));
    }).growX().left().padTop(4).row();

    sub(head, row => {
        row.left();
        row.add(t("extract")).color(Pal.accent).padRight(8);
        row.button(expandExtraction ? t("extract.on") : t("extract.off"), () => {
            expandExtraction = !expandExtraction;
            refresh();
        }).width(330).height(46).tooltip(t("extract.hint"));
    }).growX().left().padTop(4);
}

function rebuildBody(){
    if(body == null) return;
    body.clear();
    body.top().left();

    if(target == null){
        body.add(t("empty")).color(Color.lightGray).wrap().width(460).pad(20);
        result = null;
        return;
    }

    //heat is a steady amount, never converted per minute
    let perSecond = perMinute && target.kind !== "heat" ? amount / 60 : amount;
    result = calc.solve(calc.entryKey(target), perSecond, choices, options());

    if(result.truncated){
        body.add(t("truncated")).color(Pal.remove).wrap().width(460).pad(4).row();
    }

    buildSummary();
    buildRaw();
    buildByproducts();
    buildCost();
    buildChain();
}

/** A titled frame used for every block of the result. */
function section(title, builder){
    body.table(Tex.pane, frame => {
        frame.left().top().margin(8);
        frame.defaults().left();
        frame.add(title).color(Pal.accent).padBottom(6).row();
        sub(frame, inner => {
            inner.left().top();
            inner.defaults().left();
            builder(inner);
        }).growX().left();
    }).growX().pad(4).row();
}

/** icon + text chip, wrapped into a grid */
function chip(table, region, text, index){
    sub(table, cell => {
        cell.left();
        if(region != null) cell.image(region).size(28).padRight(6);
        cell.add(text).left();
    }).left().padRight(14).padBottom(4);
    if((index + 1) % columns() === 0) table.row();
}

function buildSummary(){
    section(t("summary"), table => {
        sub(table, row => {
            row.left();
            for(let i = 0; i < result.blockList.length; i++){
                let entry = result.blockList[i];
                chip(row, entry.source.uiIcon,
                    "[white]x" + wholeCount(entry.count) + " [lightgray]" + String(entry.source.localizedName), i);
            }
        }).growX().left().row();

        table.add("").height(6).row();

        let power = result.power - result.powerOut;
        table.add(t("power") + ": [accent]" + fixed(Math.abs(power)) + t("persec") +
            (power < 0 ? " [lightgray](" + t("powerout") + ")" : "")).left().row();

        if(result.heat > 0){
            table.add(t("heat") + ": [accent]" + fixed(result.heat) + " " + t("heatunit")).left().row();
        }

        table.add(t("area") + ": [accent]" + result.area + " " + t("tiles")).left().row();
    });
}

function buildRaw(){
    if(result.rawList.length === 0) return;

    section(t("raw"), table => {
        sub(table, row => {
            row.left();
            for(let i = 0; i < result.rawList.length; i++){
                let entry = result.rawList[i];
                chip(row, iconOf(entry.kind, entry.c), "[white]" + amountText(entry.kind, entry.rate) + " [lightgray]" + nameOf(entry.kind, entry.c), i);
            }
        }).growX().left().row();

        //how many drills, pumps or units each raw input would take
        let any = false;
        for(let i = 0; i < result.rawList.length; i++){
            let entry = result.rawList[i];
            let key = calc.entryKey(entry);
            let extractors = calc.extractorsFor(key, options());
            if(extractors.length === 0) continue;

            if(!any){
                any = true;
                table.add("").height(6).row();
                table.add(t("extraction")).color(Color.lightGray).wrap().growX().row();
            }

            sub(table, row => {
                row.left();
                row.image(iconOf(entry.kind, entry.c)).size(26).padRight(6);
                row.add(nameOf(entry.kind, entry.c)).color(Color.lightGray).padRight(10);
                for(let j = 0; j < extractors.length && j < 5; j++){
                    let recipe = extractors[j];
                    let rate = calc.outputRate(recipe, key);
                    row.image(recipe.source.uiIcon).size(26).padRight(4);
                    row.add("x" + wholeCount(entry.rate / rate)).padRight(12)
                        .tooltip(String(recipe.source.localizedName) + ": " + amountText(entry.kind, rate) + "\n" + terrainText(recipe));
                }
            }).left().padTop(2).row();
        }
    });
}

function buildByproducts(){
    if(result.byproductList.length === 0) return;

    section(t("byproducts"), table => {
        sub(table, row => {
            row.left();
            for(let i = 0; i < result.byproductList.length; i++){
                let entry = result.byproductList[i];
                chip(row, iconOf(entry.kind, entry.c), "[white]" + amountText(entry.kind, entry.rate) + " [lightgray]" + nameOf(entry.kind, entry.c), i);
            }
        }).growX().left();
    });
}

function buildCost(){
    if(result.costList.length === 0) return;

    section(t("buildcost"), table => {
        sub(table, row => {
            row.left();
            for(let i = 0; i < result.costList.length; i++){
                let entry = result.costList[i];
                chip(row, entry.c.uiIcon, "[white]" + Math.round(entry.rate) + " [lightgray]" + String(entry.c.localizedName), i);
            }
        }).growX().left();
    });
}

function buildChain(){
    section(t("chain"), table => {
        walk(table, result.root);
    });
}

function walk(table, node){
    sub(table, row => {
        row.left();
        row.add("").width(node.depth * 16);
        if(node.depth > 0) row.add("| ").color(Color.gray);

        row.image(iconOf(node.kind, node.c)).size(30).padRight(6);
        row.add(amountText(node.kind, node.rate)).color(Pal.accent).padRight(8);
        row.add(nameOf(node.kind, node.c)).padRight(12);

        if(node.recipe != null){
            let source = node.recipe.source;
            row.add("<-").color(Color.gray).padRight(8);
            row.image(source.uiIcon).size(30).padRight(6);
            row.add("x" + wholeCount(node.buildings)).padRight(6);
            row.add("(" + fixed(node.buildings) + ")").color(Color.gray).padRight(6);
            row.add(String(source.localizedName)).color(Color.lightGray).padRight(6);
        }else{
            //no square brackets here: labels read those as colour markup
            row.add("(" + (node.cycle ? t("cycle") : t("rawinput")) + ")").color(Color.lightGray).padRight(6);
        }

        if(node.alternatives > 0){
            row.button(Icon.edit, Styles.cleari, 22, () => showRecipes(node)).size(34).tooltip(t("recipe"));
        }
    }).growX().left().padBottom(2).row();

    for(let i = 0; i < node.children.length; i++) walk(table, node.children[i]);
}

// ---------------------------------------------------------------- pickers

function showPicker(){
    let picker = new BaseDialog(t("select"));
    picker.addCloseButton();

    let search = "";
    let grid = null;

    let rebuild = () => {
        if(grid == null) return;
        grid.clear();
        grid.top().left();

        addGroup(grid, t("items"), seqToArray(Vars.content.items()), "item", search, picker);
        addGroup(grid, t("liquids"), seqToArray(Vars.content.liquids()), "liquid", search, picker);
        addGroup(grid, t("other"), [calc.contentOf(calc.HEAT_KEY)], "heat", search, picker);
    };

    sub(picker.cont, row => {
        row.image(Icon.zoom).size(28).padRight(8);
        row.field("", text => {
            search = String(text).toLowerCase();
            rebuild();
        }).growX();
    }).growX().pad(6).row();

    picker.cont.pane(pane => {
        grid = pane;
        pane.top().left();
    }).grow();

    rebuild();
    picker.show();
}

function seqToArray(seq){
    let out = [];
    for(let i = 0; i < seq.size; i++) out.push(seq.get(i));
    return out;
}

function addGroup(grid, title, contents, kind, search, picker){
    let matches = [];
    for(let i = 0; i < contents.length; i++){
        let content = contents[i];
        if(kind !== "heat" && hidden(content)) continue;
        if(search.length > 0){
            let name = nameOf(kind, content).toLowerCase();
            let id = String(content.name).toLowerCase();
            if(name.indexOf(search) < 0 && id.indexOf(search) < 0) continue;
        }
        matches.push(content);
    }
    if(matches.length === 0) return;

    grid.add(title).color(Pal.accent).left().padTop(8).padBottom(4).row();
    sub(grid, table => {
        table.left();
        let cols = columns();
        for(let i = 0; i < matches.length; i++){
            let content = matches[i];
            let producers = calc.producersOf(calc.entryKey({kind: kind, c: content}));

            contentButton(table, Styles.defaultb, cell => {
                cell.left().margin(6);
                cell.image(iconOf(kind, content)).size(32).padRight(8);
                cell.add(nameOf(kind, content)).left().growX();
                if(producers.length === 0) cell.add("[gray]" + t("nosource")).padLeft(6);
            }, () => {
                target = {kind: kind, c: content};
                picker.hide();
                refresh();
            }).width(260).height(50).pad(3);

            if((i + 1) % cols === 0) table.row();
        }
    }).growX().left().row();
}

function showRecipes(node){
    let chooser = new BaseDialog(t("recipe"));
    chooser.addCloseButton();
    let list = calc.ranked(node.key, options());

    chooser.cont.pane(pane => {
        pane.top().left();
        sub(pane, row => {
            row.image(iconOf(node.kind, node.c)).size(34).padRight(8);
            row.add(nameOf(node.kind, node.c)).color(Pal.accent);
        }).left().pad(6).row();

        //supply it yourself
        contentButton(pane, Styles.defaultb, cell => {
            cell.left().margin(8);
            cell.image(Icon.hammer).size(32).padRight(8);
            cell.add((node.raw ? "[accent]" : "") + t("asraw")).left().growX();
        }, () => {
            choices[node.key] = calc.RAW;
            chooser.hide();
            rebuildBody();
        }).width(580).pad(3).row();

        addRecipeGroup(pane, chooser, node, list, true, t("group.extraction"));
        addRecipeGroup(pane, chooser, node, list, false, t("group.production"));
    }).grow();

    chooser.show();
}

function addRecipeGroup(pane, chooser, node, list, extraction, title){
    let group = [];
    for(let i = 0; i < list.length; i++){
        if(calc.isExtraction(list[i]) === extraction) group.push(list[i]);
    }
    if(group.length === 0) return;

    pane.add(title).color(Pal.accent).left().padTop(10).padBottom(2).row();
    for(let i = 0; i < group.length; i++) addRecipeButton(pane, chooser, node, group[i]);
}

function addRecipeButton(pane, chooser, node, recipe){
    let selected = node.recipe != null && String(node.recipe.id) === String(recipe.id);
    let warnings = recipeWarnings(recipe);
    let terrain = terrainText(recipe);
    let origin = originText(recipe);

    contentButton(pane, Styles.defaultb, cell => {
        cell.left().margin(8);
        cell.image(recipe.source.uiIcon).size(34).padRight(8);
        sub(cell, info => {
            info.left().defaults().left();
            info.add((selected ? "[accent]" : "") + String(recipe.source.localizedName)).row();
            sub(info, inputs => {
                inputs.left();
                for(let j = 0; j < recipe.ins.length; j++){
                    let input = recipe.ins[j];
                    inputs.image(iconOf(input.kind, input.c)).size(22).padRight(3);
                    inputs.add(amountText(input.kind, input.rate)).color(Color.lightGray).padRight(8);
                }
                if(recipe.power > 0){
                    inputs.add(fixed(recipe.power) + t("persec") + " " + t("power")).color(Pal.accent).padRight(8);
                }
            }).left().row();
            if(terrain.length > 0) info.add(terrain).color(Color.gray).wrap().width(420).row();
            if(origin.length > 0) info.add(origin).color(Color.gray).wrap().width(420).row();
            if(warnings.length > 0) info.add(warnings.join(", ")).color(Pal.remove).wrap().width(420).row();
        }).growX();
        cell.add(amountText(node.kind, calc.outputRate(recipe, node.key))).color(Pal.accent).padLeft(8);
    }, () => {
        choices[node.key] = String(recipe.id);
        chooser.hide();
        rebuildBody();
    }).width(580).pad(3).row();
}

// ------------------------------------------------------------- clipboard

function copySummary(){
    if(result == null || target == null) return;

    let lines = [];
    lines.push(nameOf(target.kind, target.c) + ": " + amountText(target.kind, result.root.rate));
    lines.push("");
    lines.push(t("summary") + ":");

    for(let i = 0; i < result.blockList.length; i++){
        let entry = result.blockList[i];
        lines.push("  " + String(entry.source.localizedName) + " x" + wholeCount(entry.count) +
            " (" + fixed(entry.count) + ")");
    }

    let power = result.power - result.powerOut;
    lines.push("  " + t("power") + ": " + fixed(Math.abs(power)) + t("persec") + (power < 0 ? " (" + t("powerout") + ")" : ""));
    if(result.heat > 0) lines.push("  " + t("heat") + ": " + fixed(result.heat) + " " + t("heatunit"));
    lines.push("  " + t("area") + ": " + result.area + " " + t("tiles"));

    if(result.rawList.length > 0){
        lines.push("");
        lines.push(t("raw") + ":");
        for(let i = 0; i < result.rawList.length; i++){
            let entry = result.rawList[i];
            lines.push("  " + nameOf(entry.kind, entry.c) + ": " + amountText(entry.kind, entry.rate));
        }
    }

    if(result.byproductList.length > 0){
        lines.push("");
        lines.push(t("byproducts") + ":");
        for(let i = 0; i < result.byproductList.length; i++){
            let entry = result.byproductList[i];
            lines.push("  " + nameOf(entry.kind, entry.c) + ": " + amountText(entry.kind, entry.rate));
        }
    }

    if(result.costList.length > 0){
        lines.push("");
        lines.push(t("buildcost") + ":");
        for(let i = 0; i < result.costList.length; i++){
            let entry = result.costList[i];
            lines.push("  " + String(entry.c.localizedName) + ": " + Math.round(entry.rate));
        }
    }

    lines.push("");
    lines.push(t("chain") + ":");
    writeChain(lines, result.root);

    Core.app.setClipboardText(lines.join("\n"));
    Vars.ui.showInfoFade(t("copied"));
}

function writeChain(lines, node){
    let indent = "";
    for(let i = 0; i < node.depth; i++) indent += "  ";

    let line = indent + amountText(node.kind, node.rate) + " " + nameOf(node.kind, node.c);
    if(node.recipe != null){
        line += " <- " + String(node.recipe.source.localizedName) + " x" + wholeCount(node.buildings);
    }else{
        line += " (" + (node.cycle ? t("cycle") : t("rawinput")) + ")";
    }
    lines.push(line);

    for(let i = 0; i < node.children.length; i++) writeChain(lines, node.children[i]);
}

/** True when the calculator is the dialog on top of the screen. */
function isOnTop(){
    if(dialog == null || !dialog.isShown()) return false;
    try{
        let top = Core.scene.getDialog();
        return top === dialog || (top != null && top.equals(dialog));
    }catch(e){
        return false;
    }
}

/** For the key: open the calculator, or close it when it is on top. */
function toggle(){
    if(isOnTop()) dialog.hide();
    else if(!Core.scene.hasDialog()) show();
}

exports.show = show;
exports.toggle = toggle;
exports.buttonIcon = buttonIcon;
