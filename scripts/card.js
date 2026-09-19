/*
 * Reads what the game writes in a block's info card (the stats shown by the
 * (i) button and in the Database), so the calculator uses the game's own
 * numbers instead of re-deriving them.
 *
 * Stats are not stored as numbers: each one is a small piece of code that
 * draws a row of the card. So every row we need is drawn into a detached
 * table and read back: item/liquid icons tell which resource it is, the
 * labels next to them carry the numbers ("2", "1.5/sec", "41%", "3 heat").
 *
 * Rhino notes: never declare `const` inside a function (use `let`), and do
 * not pass JS functions to overloaded Java methods.
 */

/** Stats the calculator reads; everything else on the card is ignored. */
const wanted = ["input", "output", "productionTime", "powerUse", "basePowerGeneration",
    "drillTier", "drillSpeed", "mineTier", "mineSpeed"];

let unitText = null;
let lookups = null;

// -------------------------------------------------------------- helpers

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

/** Localized unit suffixes exactly as the card prints them. */
function units(){
    if(unitText == null){
        unitText = {};
        let names = ["perSecond", "seconds", "powerSecond", "heatUnits", "liquidSecond", "itemsSecond", "percent"];
        let StatUnit = Packages.mindustry.world.meta.StatUnit;
        for(let i = 0; i < names.length; i++){
            try{
                unitText[names[i]] = String(StatUnit[names[i]].localized()).trim();
            }catch(e){
                unitText[names[i]] = null;
            }
        }
    }
    return unitText;
}

function has(text, unit){
    return unit != null && unit.length > 0 && text.indexOf(unit) >= 0;
}

/** Icon region -> content, for everything a card can show. */
function lookup(){
    if(lookups == null){
        lookups = [];
        let groups = [Vars.content.items(), Vars.content.liquids(), Vars.content.blocks()];
        for(let g = 0; g < groups.length; g++){
            let seq = groups[g];
            for(let i = 0; i < seq.size; i++){
                let content = seq.get(i);
                //blocks only matter as ore floors and ore walls on drill cards
                if(g === 2 && content.itemDrop == null) continue;
                if(content.uiIcon != null) lookups.push(content);
            }
        }
    }
    return lookups;
}

function contentFor(region){
    if(region == null) return null;
    let list = lookup();
    for(let i = 0; i < list.length; i++){
        let icon = list[i].uiIcon;
        if(icon === region) return list[i];
    }
    for(let i = 0; i < list.length; i++){
        try{
            if(region.equals(list[i].uiIcon)) return list[i];
        }catch(e){}
    }
    return null;
}

function kindOf(content){
    if(isClass(content, "Item")) return "item";
    if(isClass(content, "Liquid")) return "liquid";
    return "block";
}

/** Card text without colour markup: "[lightgray]1.5/sec" -> "1.5/sec". */
function plain(text){
    return String(text).replace(/\[[^\]]*\]/g, "");
}

/*
 * Numbers are scanned by hand: in Mindustry's Rhino a `+` in a regular
 * expression behaves like `*`, so /\d+/ happily matches an empty string.
 */

function isDigit(ch){
    return ch >= "0" && ch <= "9";
}

/** Every number in a string, in order: {value, start, end}. Handles "1.2k". */
function scan(text){
    let out = [];
    let i = 0;
    while(i < text.length){
        let start = i;
        if(text.charAt(i) === "-" && i + 1 < text.length && isDigit(text.charAt(i + 1))) i++;
        if(!isDigit(text.charAt(i))){
            i = start + 1;
            continue;
        }
        while(i < text.length && isDigit(text.charAt(i))) i++;
        if(i + 1 < text.length && text.charAt(i) === "." && isDigit(text.charAt(i + 1))){
            i++;
            while(i < text.length && isDigit(text.charAt(i))) i++;
        }
        let value = parseFloat(text.substring(start, i));
        let suffix = i < text.length ? text.charAt(i) : "";
        if(suffix === "k" || suffix === "K"){ value *= 1000; i++; }
        else if(suffix === "m" || suffix === "M"){ value *= 1000000; i++; }
        out.push({value: value, start: start, end: i});
    }
    return out;
}

/** Last number in the last line of a label ("Coal\n1.5/sec" -> 1.5). */
function numberIn(text){
    let lines = plain(text).split(/[\n|]/);
    let found = scan(lines[lines.length - 1]);
    return found.length === 0 ? null : found[found.length - 1].value;
}

/** A label that is nothing but a number: the amount printed on an icon. */
function isPureNumber(text){
    let trimmed = plain(text).trim();
    if(trimmed.length === 0) return false;
    let found = scan(trimmed);
    return found.length === 1 && found[0].start === 0 && found[0].end === trimmed.length;
}

// -------------------------------------------------------------- drawing

/** Draws one stat value and flattens it into [{region} | {text}] in reading order. */
function tokens(value){
    let table = new Table();
    value.display(table);
    let out = [];
    flatten(table, out);
    return out;
}

function flatten(element, out){
    if(isClass(element, "Label")){
        out.push({text: String(element.getText())});
    }else if(isClass(element, "Image")){
        let region = null;
        try{
            let drawable = element.getDrawable();
            if(drawable != null && drawable.getRegion != null) region = drawable.getRegion();
        }catch(e){}
        out.push({region: region});
    }
    try{
        let children = element.getChildren();
        if(children != null){
            for(let i = 0; i < children.size; i++) flatten(children.get(i), out);
        }
    }catch(e){}
}

/**
 * Splits a drawn stat value into resource groups: an icon of an item/liquid
 * (or ore block) followed by the labels that belong to it.
 */
function groups(list){
    //foreign: an icon that is not a resource (a unit on a factory card, a block
    //on a constructor card) - such rows list costs of something else
    let result = {lead: [], groups: [], foreign: false};
    let current = null;
    for(let i = 0; i < list.length; i++){
        let token = list[i];
        if(token.text == null){
            let content = contentFor(token.region);
            if(content == null){
                result.foreign = true;
                continue;
            }
            current = {content: content, kind: kindOf(content), labels: []};
            result.groups.push(current);
        }else if(current == null){
            result.lead.push(token.text);
        }else{
            current.labels.push(token.text);
        }
    }
    return result;
}

/**
 * What one resource group says: amount per craft, rate per second, or a
 * percent chance. Any of them can be missing.
 */
function readGroup(group){
    let u = units();
    let info = {content: group.content, kind: group.kind, amount: null, rate: null, percent: null};
    let standalonePerSecond = false;

    for(let i = 0; i < group.labels.length; i++){
        let text = plain(group.labels[i]);
        let trimmed = text.trim();
        if(trimmed.length === 0) continue;

        if(info.amount == null && isPureNumber(text)){
            info.amount = numberIn(text);
        }else if(has(text, u.perSecond) && trimmed !== u.perSecond && numberIn(text) != null){
            info.rate = numberIn(text);
        }else if(trimmed === u.perSecond){
            standalonePerSecond = true;
        }else if(text.indexOf("%") >= 0 && numberIn(text) != null){
            info.percent = numberIn(text);
        }
    }

    //liquids print the per-second amount on the icon, then a bare "/sec"
    if(info.rate == null && standalonePerSecond && info.amount != null){
        info.rate = info.amount;
        info.amount = null;
    }
    return info;
}

/**
 * "Any of these" lists (flammable items for a combustion generator, any
 * coolant) are not one resource. They show items without per-craft amounts,
 * or "/" between the choices.
 */
function isChoice(split){
    let bare = 0;
    for(let i = 0; i < split.groups.length; i++){
        let group = split.groups[i];
        for(let j = 0; j < group.labels.length; j++){
            if(plain(group.labels[j]).trim() === "/") return true;
        }
        if(group.kind === "item" && readGroup(group).amount == null) bare++;
    }
    for(let i = 0; i < split.lead.length; i++){
        if(plain(split.lead[i]).trim() === "/") return true;
    }
    return bare >= 2;
}

/** A value with no icons: "3 heat units", "66 power/sec", "0.583 seconds". */
function readNumber(split){
    let text = split.lead.join(" ");
    return {text: plain(text), value: numberIn(split.lead.length > 0 ? split.lead[0] : "")};
}

// ------------------------------------------------------------------ read

/**
 * Everything the calculator needs from one card. Missing parts stay empty;
 * `ok` is false when the card could not be read at all.
 */
function read(content){
    let card = {
        ok: false,
        //card rows that exist, even if they list nothing (a drill on a map without its ores)
        seen: {},
        inputs: [], outputs: [], choices: 0,
        heatIn: 0, heatOut: 0,
        power: 0, powerOut: 0,
        time: null,
        ores: [], drillSpeed: null,
        pumpRate: null, outputContent: [],
        mineSpeed: null
    };

    let map = null;
    try{
        content.checkStats();
        map = content.stats.toMap();
    }catch(e){
        return card;
    }

    let u = units();
    let categories = map.orderedKeys();
    for(let c = 0; c < categories.size; c++){
        let inner = map.get(categories.get(c));
        let stats = inner.orderedKeys();
        for(let s = 0; s < stats.size; s++){
            let stat = stats.get(s);
            let name = String(stat.name);
            if(wanted.indexOf(name) < 0) continue;
            card.seen[name] = true;

            let values = inner.get(stat);
            for(let v = 0; v < values.size; v++){
                let split = null;
                try{
                    split = groups(tokens(values.get(v)));
                }catch(e){
                    continue;
                }
                card.ok = true;
                readValue(card, name, split, u);
            }
        }
    }

    //items that only state an amount per craft are converted with the craft time
    let lists = [card.inputs, card.outputs];
    for(let l = 0; l < lists.length; l++){
        for(let i = 0; i < lists[l].length; i++){
            let entry = lists[l][i];
            if(entry.rate != null) continue;
            if(entry.percent != null && card.time > 0) entry.rate = entry.percent / 100 / card.time;
            else if(entry.amount != null && card.time > 0) entry.rate = entry.amount / card.time;
        }
    }
    return card;
}

function readValue(card, name, split, u){
    if(split.groups.length === 0){
        let number = readNumber(split);
        if(number.value == null) return;

        if(name === "productionTime") card.time = number.value;
        else if(name === "powerUse") card.power += number.value;
        else if(name === "basePowerGeneration") card.powerOut += number.value;
        else if(name === "drillSpeed") card.drillSpeed = number.value;
        else if(name === "mineSpeed") card.mineSpeed = number.value;
        else if(name === "input" && has(number.text, u.heatUnits)) card.heatIn += number.value;
        else if(name === "output" && has(number.text, u.heatUnits)) card.heatOut += number.value;
        else if(name === "output" && has(number.text, u.liquidSecond)) card.pumpRate = number.value;
        return;
    }

    if(name === "drillTier" || name === "mineTier"){
        for(let i = 0; i < split.groups.length; i++){
            let group = split.groups[i];
            if(group.kind !== "block" || group.content.itemDrop == null) continue;
            card.ores.push({block: group.content, item: group.content.itemDrop, rate: readGroup(group).rate});
        }
        return;
    }

    if(name === "input" || name === "output"){
        if(split.foreign) return;
        if(name === "input" && isChoice(split)){
            card.choices++;
            return;
        }
        let list = name === "input" ? card.inputs : card.outputs;
        for(let i = 0; i < split.groups.length; i++){
            let group = split.groups[i];
            if(group.kind === "block") continue;
            let info = readGroup(group);
            if(info.rate == null && info.amount == null && info.percent == null){
                //a bare icon: "produces sand" on cliff crushers, rate comes from drillSpeed
                if(name === "output") card.outputContent.push(info);
                continue;
            }
            list.push(info);
        }
    }
}

exports.read = read;
exports.numberIn = numberIn;
exports.plain = plain;
