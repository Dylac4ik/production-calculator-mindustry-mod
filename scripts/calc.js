/*
 * Recipe index and production chain solver.
 *
 * Pure data: this file never touches the UI or changes game state. Every rate
 * here is "units per second for one building running at 100% efficiency",
 * which is exactly what the game shows in block stats. Heat is the exception:
 * it is a steady amount (heat units), not a flow, but it scales with the
 * number of buildings the same way, so the solver treats it like a rate.
 *
 * Rhino note: never declare `const` inside a function here - Mindustry's
 * Rhino evaluates a `const` in a loop body only once. Use `let`.
 */

const cards = require("card");

/** Choice value meaning "I supply this myself, do not expand it". */
const RAW = "@raw";
const HEAT_KEY = "h:heat";

const maxNodes = 400;
const maxDepth = 24;

/** Stand-in "content" for heat, which is not a real item or liquid. */
const HEAT = {name: "heat"};

let built = false;

let recipes = [];
/** resource key -> array of recipes producing it */
const byOutput = {};
/** item key -> {item, floor: [Floor], wall: [Block]} - where it can be mined */
const ores = {};
/** liquid key -> {liquid, floors: [Floor]} - where it can be pumped */
const liquidFloors = {};
/** unit type names that some factory, reconstructor or assembler can make */
const buildableUnits = {};
/** blocks that are sandbox or editor tools, never real production */
let excludedVisibility = null;

// --------------------------------------------------------------------- utils

/** Reads a java field as a number, with a fallback when it is missing/null. */
function num(value, def){
    try{
        if(value == null) return def;
        let n = Number(value);
        return isNaN(n) ? def : n;
    }catch(e){
        return def;
    }
}

/** instanceof by class name - survives renamed/missing classes between versions. */
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

function itemKey(item){
    return "i:" + item.name;
}

function liquidKey(liquid){
    return "l:" + liquid.name;
}

function prefix(kind){
    return kind === "item" ? "i:" : kind === "liquid" ? "l:" : "h:";
}

function entryKey(entry){
    return prefix(entry.kind) + entry.c.name;
}

function kindOf(key){
    let p = key.charAt(0);
    return p === "i" ? "item" : p === "l" ? "liquid" : "heat";
}

function isItemKey(key){
    return key.charAt(0) === "i";
}

/** Item, Liquid or the HEAT stand-in for a resource key. */
function contentOf(key){
    let kind = kindOf(key);
    if(kind === "heat") return HEAT;
    return Vars.content.getByName(kind === "item" ? ContentType.item : ContentType.liquid, key.substring(2));
}

/** Adds a rate to a list of {kind, c, rate}, merging duplicates. */
function add(list, kind, content, rate){
    if(content == null || !(rate > 0)) return;
    for(let i = 0; i < list.length; i++){
        if(list[i].kind === kind && String(list[i].c.name) === String(content.name)){
            list[i].rate += rate;
            return;
        }
    }
    list.push({kind: kind, c: content, rate: rate});
}

/** Converts an ItemStack[]/LiquidStack[] into per-second entries. */
function addStacks(list, stacks, kind, multiplier){
    if(stacks == null) return;
    for(let i = 0; i < stacks.length; i++){
        let stack = stacks[i];
        if(stack == null) continue;
        add(list, kind, kind === "item" ? stack.item : stack.liquid, num(stack.amount, 0) * multiplier);
    }
}

function names(contents, limit){
    let out = [];
    let more = false;
    for(let i = 0; i < contents.length; i++){
        let name = String(contents[i].localizedName);
        if(out.indexOf(name) >= 0) continue;
        if(out.length >= limit){
            more = true;
            break;
        }
        out.push(name);
    }
    if(more) out.push("...");
    return out;
}

/** Sandbox/editor-only blocks (item source, heat source, ...) are not production. */
function excluded(block){
    if(excludedVisibility == null){
        excludedVisibility = [];
        let visibility = Packages.mindustry.world.meta.BuildVisibility;
        let banned = ["sandboxOnly", "hidden", "debugOnly", "editorOnly"];
        for(let i = 0; i < banned.length; i++){
            try{
                let value = visibility[banned[i]];
                if(value != null) excludedVisibility.push(value);
            }catch(e){}
        }
    }
    try{
        for(let i = 0; i < excludedVisibility.length; i++){
            if(block.buildVisibility != null && block.buildVisibility.equals(excludedVisibility[i])) return true;
        }
    }catch(e){}
    return false;
}

/** Old fallback for planet detection, used when isOnPlanet() is missing. */
function planetOf(content){
    try{
        let node = content.techNode;
        if(node == null && content.techNodes != null && content.techNodes.size > 0) node = content.techNodes.get(0);
        while(node != null){
            if(node.planet != null) return node.planet;
            node = node.parent;
        }
    }catch(e){}
    return null;
}

function samePlanet(a, b){
    return a != null && b != null && String(a.name) === String(b.name);
}

/** Whether a block/unit belongs to the planet the player is planning for. */
function onPlanet(recipe, planet){
    if(planet == null) return true;
    try{
        return recipe.source.isOnPlanet(planet) === true;
    }catch(e){}
    let own = planetOf(recipe.source);
    return own == null || samePlanet(own, planet);
}

/**
 * Why a recipe cannot be used right now, or null if it can.
 * "research" - not researched yet (campaign), "banned" - banned by the map rules.
 */
function unavailable(recipe){
    try{
        if(recipe.source.unlockedNow() === false) return "research";
    }catch(e){}
    try{
        if(recipe.source.isBanned() === true) return "banned";
    }catch(e){}
    return null;
}

/**
 * Whether the ground a recipe needs (ore, water, walls, vents) exists on the
 * current map: true/false, or null when unknown (not in game, no terrain).
 */
function terrainOnMap(recipe){
    let terrain = recipe.terrain;
    if(terrain == null || terrain.blocks == null || terrain.blocks.length === 0) return null;
    try{
        if(!Vars.state.isGame() || Vars.indexer == null) return null;
        for(let i = 0; i < terrain.blocks.length; i++){
            if(Vars.indexer.isBlockPresent(terrain.blocks[i]) === true) return true;
        }
        return false;
    }catch(e){
        return null;
    }
}

// ----------------------------------------------------------------- terrain

function collectTerrain(block){
    let drop = block.itemDrop;
    if(drop != null){
        let key = itemKey(drop);
        let ore = ores[key];
        if(ore == null) ore = ores[key] = {item: drop, floor: [], wall: []};
        if(block.wallOre === true || isClass(block, "StaticWall")) ore.wall.push(block);
        else if(isClass(block, "Floor")) ore.floor.push(block);
    }

    let liquid = block.liquidDrop;
    if(liquid != null && isClass(block, "Floor")){
        let key = liquidKey(liquid);
        let entry = liquidFloors[key];
        if(entry == null) entry = liquidFloors[key] = {liquid: liquid, floors: []};
        entry.floors.push(block);
    }

    //factories, reconstructors and assemblers tell which units can be built
    try{
        if(block.plans != null){
            for(let i = 0; i < block.plans.size; i++){
                let plan = block.plans.get(i);
                if(plan != null && plan.unit != null) buildableUnits[String(plan.unit.name)] = true;
            }
        }
    }catch(e){}
    try{
        if(block.upgrades != null){
            for(let i = 0; i < block.upgrades.size; i++){
                let pair = block.upgrades.get(i);
                if(pair != null && pair.length > 1 && pair[1] != null) buildableUnits[String(pair[1].name)] = true;
            }
        }
    }catch(e){}
}

/** Floors or walls that carry an attribute (steam vents, oily sand, ...). */
function withAttribute(attribute, walls){
    let found = [];
    let best = 0;
    let blocks = Vars.content.blocks();
    for(let i = 0; i < blocks.size; i++){
        let block = blocks.get(i);
        let value = 0;
        try{ value = num(block.attributes.get(attribute), 0); }catch(e){}
        if(value <= 0) continue;
        if(walls ? !isClass(block, "StaticWall") : !isClass(block, "Floor")) continue;
        found.push(block);
        if(value > best) best = value;
    }
    return {blocks: found, best: best};
}

/** Terrain note for crafters that only work on special ground. */
function attributeTerrain(block){
    let attribute = block.attribute;
    if(attribute == null) return null;

    //thermal generators always need the attribute; crafters only when their
    //base efficiency is zero (vent condenser, oil extractor)
    if(!isClass(block, "ThermalGenerator") && num(block.baseEfficiency, 1) > 0) return null;

    let found = withAttribute(attribute, false);
    return {type: "attribute", names: names(found.blocks, 3), blocks: found.blocks};
}

// ----------------------------------------------------------------- recipes

function consumption(block, period, recipe){
    let consumers = block.consumers;
    if(consumers == null) return;

    for(let i = 0; i < consumers.length; i++){
        let consume = consumers[i];
        if(consume == null) continue;
        let boost = consume.optional === true || consume.booster === true;
        let list = boost ? recipe.optional : recipe.ins;

        if(consume.items != null){
            //ConsumeItems
            if(period > 0) addStacks(list, consume.items, "item", 60 / period);
            else if(!boost) recipe.unknown = true;
        }else if(consume.liquids != null){
            //ConsumeLiquids
            addStacks(list, consume.liquids, "liquid", 60);
        }else if(consume.liquid != null){
            //ConsumeLiquid
            add(list, "liquid", consume.liquid, num(consume.amount, 0) * 60);
        }else if(consume.usage != null && !boost){
            //ConsumePower
            recipe.power += num(consume.usage, 0) * 60;
        }
        //filter based consumers (any flammable item, coolant, ...) cannot be
        //resolved to a single resource, so they are left out on purpose
    }
}

function newRecipe(kind, source, id){
    return {
        id: id,
        kind: kind,
        source: source,
        isUnit: kind === "unit",
        out: [],
        ins: [],
        optional: [],
        power: 0,
        powerOut: 0,
        heat: 0,
        unknown: false,
        random: false,
        variant: 1,
        terrain: null,
        //"card": numbers from the block's info card; "calc": the card does
        //not show this, computed by the mod; "unit": items from the card,
        //speed computed (unit cards do not show it)
        origin: null
    };
}

/**
 * A crafting recipe: factories, heaters, generators with a by-product, solid
 * pumps. Returns null when the block does not make anything.
 */
function craftRecipe(block){
    let recipe = newRecipe("craft", block, String(block.name));
    let craftTime = num(block.craftTime, 0);
    let thermal = isClass(block, "ThermalGenerator");
    //thermal generators scale with the attribute under every tile
    let scale = thermal ? num(block.size, 1) * num(block.size, 1) : 1;

    if(craftTime > 0){
        let per = 60 / craftTime;

        //GenericCrafter and everything extending it
        if(block.outputItems != null) addStacks(recipe.out, block.outputItems, "item", per);
        else if(block.outputItem != null) addStacks(recipe.out, [block.outputItem], "item", per);

        //separators roll one random result per craft, weighted by amount
        if(recipe.out.length === 0 && block.results != null){
            let total = 0;
            for(let i = 0; i < block.results.length; i++) total += num(block.results[i].amount, 0);
            if(total > 0){
                recipe.random = true;
                for(let i = 0; i < block.results.length; i++){
                    let stack = block.results[i];
                    if(stack == null) continue;
                    add(recipe.out, "item", stack.item, num(stack.amount, 0) / total * per);
                }
            }
        }
    }

    //liquid outputs are per tick for crafters and generators alike
    if(block.outputLiquids != null) addStacks(recipe.out, block.outputLiquids, "liquid", 60 * scale);
    else if(block.outputLiquid != null) addStacks(recipe.out, [block.outputLiquid], "liquid", 60 * scale);

    //solid pumps with a fixed result: oil extractor, water extractor
    if(block.result != null && block.pumpAmount != null){
        add(recipe.out, "liquid", block.result, num(block.pumpAmount, 0) * 60);
    }

    //heat for Erekir crafters; other blocks reuse the field name for other things
    if(isClass(block, "HeatProducer") || isClass(block, "HeaterGenerator")){
        add(recipe.out, "heat", HEAT, num(block.heatOutput, 0));
    }

    if(recipe.out.length === 0) return null;

    //time between item consumptions: crafters, frackers and burners all differ
    let period = craftTime;
    if(period <= 0) period = num(block.itemUseTime, 0);
    if(period <= 0) period = num(block.itemDuration, 0);
    consumption(block, period, recipe);

    recipe.heat = num(block.heatRequirement, 0);
    if(recipe.heat > 0) add(recipe.ins, "heat", HEAT, recipe.heat);
    recipe.powerOut = num(block.powerProduction, 0) * 60 * scale;
    recipe.terrain = attributeTerrain(block);
    return recipe;
}

/** Items per second for one drill, fully covered in ore, without boost. */
function drillRate(block, item, beam){
    let hardness = num(item.hardness, 0);
    if(hardness > num(block.tier, 0)) return 0;
    try{
        if(block.blockedItems != null && block.blockedItems.contains(item)) return 0;
    }catch(e){}

    let multiplier = 1;
    try{
        if(block.drillMultipliers != null) multiplier = num(block.drillMultipliers.get(item, 1), 1);
    }catch(e){}

    let base = num(block.drillTime, 0);
    let size = num(block.size, 1);
    //same formula the game uses for the "drillable" stat
    let time = Math.max(base + (beam ? 0 : num(block.hardnessDrillMultiplier, 0)) * hardness, base) / multiplier;
    return time > 0 ? 60 / time * (beam ? size : size * size) : 0;
}

function unitRate(unit, item){
    //MinerComp: one item every 50 + 15 * hardness ticks, sped up by mineSpeed
    let hardness = num(item.hardness, 0);
    let threshold = 50 + (unit.mineHardnessScaling === false ? 15 : hardness * 15);
    return 60 * num(unit.mineSpeed, 0) / threshold;
}

/** Floors that give a liquid, grouped by multiplier (deep water is x1.5). */
function pumpGroups(entry){
    let groups = {};
    for(let i = 0; i < entry.floors.length; i++){
        let floor = entry.floors[i];
        let multiplier = num(floor.liquidMultiplier, 1);
        if(multiplier <= 0) continue;
        if(groups[multiplier] == null) groups[multiplier] = [];
        groups[multiplier].push(floor);
    }
    return groups;
}

// ------------------------------------------------ recipes from the block card

/**
 * The card rounds what it prints (0.36/sec for a drill that makes 0.369/sec,
 * 41% for 5/12). When the exact figure from the block's own fields agrees
 * with the card within that rounding, the exact one is used so errors do not
 * pile up along a chain. When they disagree, the card wins.
 */
function refine(shown, exact){
    if(shown == null) return exact;
    if(exact == null || !(exact > 0)) return shown;
    let tolerance = Math.max(0.011, Math.max(shown, exact) * 0.05);
    return Math.abs(shown - exact) <= tolerance ? exact : shown;
}

function exactRate(list, kind, content){
    if(list == null) return null;
    for(let i = 0; i < list.length; i++){
        if(list[i].kind === kind && String(list[i].c.name) === String(content.name)) return list[i].rate;
    }
    return null;
}

/** Inputs, power and heat from the card, refined with the exact figures. */
function cardInputs(card, recipe, exact){
    for(let i = 0; i < card.inputs.length; i++){
        let input = card.inputs[i];
        if(input.rate == null){
            recipe.unknown = true;
            continue;
        }
        add(recipe.ins, input.kind, input.content, refine(input.rate, exactRate(exact == null ? null : exact.ins, input.kind, input.content)));
    }
    //the card decides whether there is any power use at all
    recipe.power = card.power > 0 ? refine(card.power, exact == null ? null : exact.power) : 0;
    recipe.powerOut = card.powerOut > 0 ? refine(card.powerOut, exact == null ? null : exact.powerOut) : 0;
    if(card.heatIn > 0){
        recipe.heat = refine(card.heatIn, exact == null ? null : exact.heat);
        add(recipe.ins, "heat", HEAT, recipe.heat);
    }
}

/** Factories, heaters, generators with a by-product, solid pumps. */
function cardCraft(block, card){
    let exact = craftRecipe(block);
    let recipe = newRecipe("craft", block, String(block.name));
    recipe.origin = "card";

    for(let i = 0; i < card.outputs.length; i++){
        let output = card.outputs[i];
        let rate = output.rate;
        if(output.percent != null) recipe.random = true;
        rate = refine(rate, exactRate(exact == null ? null : exact.out, output.kind, output.content));
        if(rate == null || !(rate > 0)) continue;
        add(recipe.out, output.kind, output.content, rate);
    }
    if(card.heatOut > 0){
        add(recipe.out, "heat", HEAT, refine(card.heatOut, exactRate(exact == null ? null : exact.out, "heat", HEAT)));
    }
    if(recipe.out.length === 0) return null;

    cardInputs(card, recipe, exact);
    recipe.terrain = exact != null ? exact.terrain : attributeTerrain(block);
    return recipe;
}

/** Drills: the card lists every ore the drill can mine here, with its speed. */
function cardDrills(block, card){
    let beam = isClass(block, "BeamDrill");
    let exact = newRecipe("drill", block, "");
    consumption(block, 0, exact);

    let byItem = {};
    let order = [];
    for(let i = 0; i < card.ores.length; i++){
        let row = card.ores[i];
        let key = itemKey(row.item);
        if(byItem[key] == null){
            byItem[key] = {item: row.item, rate: row.rate, blocks: []};
            order.push(key);
        }
        byItem[key].blocks.push(row.block);
    }

    let out = [];
    for(let i = 0; i < order.length; i++){
        let entry = byItem[order[i]];
        let rate = refine(entry.rate, drillRate(block, entry.item, beam));
        if(rate == null || !(rate > 0)) continue;

        let recipe = newRecipe("drill", block, String(block.name));
        recipe.origin = entry.rate != null ? "card" : "calc";
        add(recipe.out, "item", entry.item, rate);
        cardInputs(card, recipe, exact);
        recipe.terrain = {type: beam ? "wallore" : "ore", names: names(entry.blocks, 3), blocks: entry.blocks};
        out.push(recipe);
    }
    return out;
}

/**
 * Pumps: the card gives the speed on a full tile of liquid; which liquid comes
 * out depends on the floor, so the floors are read from the floor blocks.
 */
function pumpList(block, card){
    let out = [];
    let size = num(block.size, 1);
    let exact = newRecipe("pump", block, "");
    consumption(block, 0, exact);
    let shownRate = card == null ? null : card.pumpRate;

    for(let key in liquidFloors){
        let entry = liquidFloors[key];
        let groups = pumpGroups(entry);
        for(let multiplier in groups){
            let value = Number(multiplier);
            let base = 60 * num(block.pumpAmount, 0) * size * size;
            let rate = shownRate == null ? base * value : refine(shownRate, base) * value;

            let recipe = newRecipe("pump", block, String(block.name) + "@" + multiplier);
            recipe.origin = shownRate == null ? "calc" : "card";
            recipe.variant = value;
            add(recipe.out, "liquid", entry.liquid, rate);
            if(card == null) consumption(block, 0, recipe);
            else cardInputs(card, recipe, exact);
            recipe.terrain = {type: "floor", names: names(groups[multiplier], 3), blocks: groups[multiplier]};
            out.push(recipe);
        }
    }
    return out;
}

/** Cliff crushers: the card names the item and the speed next to plain walls. */
function wallCrafter(block, card){
    let time = num(block.drillTime, 0);
    let exactRateValue = time > 0 ? 60 / time * num(block.size, 1) : null;
    let item = block.output;
    if(card != null){
        if(card.outputs.length > 0) item = card.outputs[0].content;
        else if(card.outputContent.length > 0) item = card.outputContent[0].content;
    }
    if(item == null) return null;

    let rate = refine(card == null ? null : card.drillSpeed, exactRateValue);
    if(rate == null || !(rate > 0)) return null;

    let exact = newRecipe("wall", block, "");
    consumption(block, 0, exact);
    let found = withAttribute(block.attribute, true);

    let recipe = newRecipe("wall", block, String(block.name));
    recipe.origin = card != null && card.drillSpeed != null ? "card" : "calc";
    add(recipe.out, "item", item, rate);
    if(card != null) cardInputs(card, recipe, exact);
    else{
        recipe.ins = exact.ins;
        recipe.power = exact.power;
    }
    recipe.terrain = {type: "walls", names: names(found.blocks, 3), blocks: found.blocks, best: found.best};
    return recipe;
}

function isDrill(block){
    return num(block.drillTime, 0) > 0 && block.tier != null;
}

/** Drill recipes from the block's own fields, for drills whose card has no ore list. */
function fieldDrills(block){
    let out = [];
    let beam = isClass(block, "BeamDrill");
    for(let key in ores){
        let ore = ores[key];
        let spots = beam ? ore.wall : ore.floor;
        if(spots.length === 0) continue;
        let rate = drillRate(block, ore.item, beam);
        if(rate <= 0) continue;
        let drill = newRecipe("drill", block, String(block.name));
        drill.origin = "calc";
        add(drill.out, "item", ore.item, rate);
        consumption(block, 0, drill);
        drill.terrain = {type: beam ? "wallore" : "ore", names: names(spots, 3), blocks: spots};
        out.push(drill);
    }
    return out;
}

/**
 * Every recipe of a block. What the card shows wins; the block's own fields
 * are only used for a part the card does not show at all (unusual modded
 * blocks), and such recipes are marked origin "calc".
 */
function recipesFor(block){
    let card = null;
    try{
        card = cards.read(block);
    }catch(e){
        card = null;
    }
    if(card != null && !card.ok) card = null;
    let seen = card == null ? {} : card.seen;
    let out = [];

    if(isClass(block, "WallCrafter")){
        let wall = wallCrafter(block, seen.drillSpeed ? card : null);
        if(wall != null) out.push(wall);
        return out;
    }

    let craft = null;
    if(seen.output && (card.outputs.length > 0 || card.heatOut > 0)) craft = cardCraft(block, card);
    if(craft == null){
        craft = craftRecipe(block);
        if(craft != null) craft.origin = "calc";
    }
    if(craft != null) out.push(craft);

    if(seen.drillTier) out = out.concat(cardDrills(block, card));
    else if(isDrill(block)) out = out.concat(fieldDrills(block));

    if(block.pumpAmount != null && block.result == null && isClass(block, "Pump")){
        out = out.concat(pumpList(block, card != null && card.pumpRate != null ? card : null));
    }
    return out;
}

/**
 * Mining units: the unit card lists which ores it can mine; how fast is not
 * on the card, so the rate comes from the unit's mining speed.
 */
function unitRecipes(){
    let units = Vars.content.units();
    for(let i = 0; i < units.size; i++){
        let unit = units.get(i);
        let tier = num(unit.mineTier, -1);
        if(tier < 0 || num(unit.mineSpeed, 0) <= 0 || !buildableUnits[String(unit.name)]) continue;

        let rows = [];
        let fromCard = false;
        try{
            let card = cards.read(unit);
            if(card.ok && card.ores.length > 0){
                rows = card.ores;
                fromCard = true;
            }
        }catch(e){}

        //no readable card: fall back to what the unit's fields allow
        if(!fromCard){
            for(let key in ores){
                let ore = ores[key];
                if(num(ore.item.hardness, 0) > tier) continue;
                try{
                    if(unit.mineItems != null && !unit.mineItems.contains(ore.item)) continue;
                }catch(e){}
                let spots = [];
                if(unit.mineFloor !== false) spots = spots.concat(ore.floor);
                if(unit.mineWalls === true) spots = spots.concat(ore.wall);
                for(let s = 0; s < spots.length; s++) rows.push({block: spots[s], item: ore.item});
            }
        }

        let byItem = {};
        let order = [];
        for(let r = 0; r < rows.length; r++){
            let key = itemKey(rows[r].item);
            if(byItem[key] == null){
                byItem[key] = {item: rows[r].item, blocks: []};
                order.push(key);
            }
            byItem[key].blocks.push(rows[r].block);
        }

        for(let k = 0; k < order.length; k++){
            let entry = byItem[order[k]];
            let recipe = newRecipe("unit", unit, "unit:" + unit.name);
            recipe.origin = fromCard ? "unit" : "calc";
            add(recipe.out, "item", entry.item, unitRate(unit, entry.item));
            recipe.terrain = {type: "unit", names: names(entry.blocks, 3), blocks: entry.blocks};
            register(recipe);
        }
    }
}

function register(recipe){
    recipes.push(recipe);
    for(let j = 0; j < recipe.out.length; j++){
        let key = entryKey(recipe.out[j]);
        if(byOutput[key] == null) byOutput[key] = [];
        byOutput[key].push(recipe);
    }
}

/**
 * Forgets everything read so far. Drill cards only list ores present on the
 * current map, so the index is rebuilt for every new map.
 */
function reset(){
    built = false;
    recipes = [];
    let maps = [byOutput, ores, liquidFloors, buildableUnits];
    for(let m = 0; m < maps.length; m++){
        for(let key in maps[m]) delete maps[m][key];
    }
}

/** Scans all content once. Safe to call repeatedly. */
function build(){
    if(built) return;
    built = true;

    let blocks = Vars.content.blocks();

    //first pass: where things can be mined or pumped, which units exist
    for(let i = 0; i < blocks.size; i++){
        try{
            collectTerrain(blocks.get(i));
        }catch(e){
            Log.err("[production-calculator] skipped terrain " + blocks.get(i).name + ": " + e);
        }
    }

    //second pass: what every block's card says it makes
    for(let i = 0; i < blocks.size; i++){
        let block = blocks.get(i);
        if(excluded(block)) continue;
        try{
            let list = recipesFor(block);
            for(let j = 0; j < list.length; j++) register(list[j]);
        }catch(e){
            Log.err("[production-calculator] skipped block " + block.name + ": " + e);
        }
    }

    try{
        unitRecipes();
    }catch(e){
        Log.err("[production-calculator] skipped units: " + e);
    }
}

function producersOf(key){
    let list = byOutput[key];
    return list == null ? [] : list;
}

/** Per-second output of one building (or unit) for the given resource. */
function outputRate(recipe, key){
    for(let i = 0; i < recipe.out.length; i++){
        if(entryKey(recipe.out[i]) === key) return recipe.out[i].rate;
    }
    return 0;
}

function findRecipe(list, id){
    for(let i = 0; i < list.length; i++){
        if(String(list[i].id) === String(id)) return list[i];
    }
    return null;
}

function isExtraction(recipe){
    return recipe.kind !== "craft";
}

/**
 * Lower is better. Planet, availability and the current map dominate, then
 * simple recipes win; among extraction methods the fastest one wins, units
 * come last. `options`: {planet, onMap, expandExtraction}.
 */
function score(recipe, key, options){
    let planet = options == null ? null : options.planet;
    let value = 0;

    if(recipe.kind === "craft"){
        value += recipe.ins.length * 10;
        if(recipe.heat > 0) value += 5;
        if(recipe.power > 0) value += 1;
        if(recipe.unknown) value += 50;
    }
    if(recipe.random) value += 200;
    if(recipe.kind === "unit") value += 500;
    if(!onPlanet(recipe, planet)) value += 1000;
    if(unavailable(recipe) != null) value += 300;

    //ground the recipe needs: known from the map when planning for it,
    //otherwise rare ground (vents, oily sand, walls) is a small minus
    let present = options != null && options.onMap ? terrainOnMap(recipe) : null;
    if(present === false) value += 100;
    else if(present !== true && recipe.terrain != null && (recipe.terrain.type === "attribute" || recipe.terrain.type === "walls")) value += 20;

    if(isExtraction(recipe)){
        //deep water and similar bonus floors are not the common case
        if(recipe.variant !== 1) value += 0.5;
        value -= Math.min(outputRate(recipe, key), 999) / 1000;
    }
    return value;
}

/** Producers of a resource, best first. */
function ranked(key, options){
    let list = producersOf(key).slice();
    let scores = {};
    for(let i = 0; i < list.length; i++) scores[list[i].id] = score(list[i], key, options);
    list.sort((a, b) => scores[a.id] - scores[b.id]);
    return list;
}

/** Ways to mine or pump a resource, best first. */
function extractorsFor(key, options){
    let all = ranked(key, options);
    let out = [];
    for(let i = 0; i < all.length; i++){
        if(isExtraction(all[i])) out.push(all[i]);
    }
    return out;
}

/**
 * Default recipe for a resource. With extraction off, anything that can be
 * mined or pumped stays a raw input unless it is the target itself.
 */
function pick(key, list, options, forced){
    if(list.length === 0) return null;

    if(!forced && options != null && options.expandExtraction === false){
        for(let i = 0; i < list.length; i++){
            if(isExtraction(list[i])) return null;
        }
    }

    let best = null, bestScore = 0;
    for(let i = 0; i < list.length; i++){
        let value = score(list[i], key, options);
        if(best == null || value < bestScore){
            best = list[i];
            bestScore = value;
        }
    }
    return best;
}

// ------------------------------------------------------------------ solver

function addTotal(map, list, kind, content, rate){
    let key = prefix(kind) + content.name;
    let entry = map[key];
    if(entry == null){
        entry = map[key] = {kind: kind, c: content, rate: 0};
        list.push(entry);
    }
    entry.rate += rate;
}

function resolve(key, rate, depth, path, result, choices, options){
    let list = producersOf(key);
    let node = {
        key: key,
        kind: kindOf(key),
        c: contentOf(key),
        rate: rate,
        depth: depth,
        children: [],
        recipe: null,
        buildings: 0,
        raw: false,
        cycle: false,
        alternatives: list.length
    };

    result.nodes++;

    let looping = path.indexOf(key) >= 0;
    let choice = choices == null ? null : choices[key];
    let recipe = null;

    if(choice !== RAW && !looping && depth < maxDepth && result.nodes < maxNodes){
        if(choice != null) recipe = findRecipe(list, choice);
        if(recipe == null) recipe = pick(key, list, options, depth === 0);
    }

    if(recipe == null){
        node.raw = true;
        node.cycle = looping;
        if(result.nodes >= maxNodes) result.truncated = true;
        addTotal(result.raw, result.rawList, node.kind, node.c, rate);
        return node;
    }

    let perBuilding = outputRate(recipe, key);
    let count = perBuilding > 0 ? rate / perBuilding : 0;

    node.recipe = recipe;
    node.buildings = count;

    let id = (recipe.isUnit ? "unit:" : "") + recipe.source.name;
    let entry = result.blocks[id];
    if(entry == null){
        entry = result.blocks[id] = {source: recipe.source, isUnit: recipe.isUnit, count: 0};
        result.blockList.push(entry);
    }
    entry.count += count;

    result.power += recipe.power * count;
    result.powerOut += recipe.powerOut * count;
    result.heat += recipe.heat * count;

    //anything the recipe makes besides the requested resource
    for(let i = 0; i < recipe.out.length; i++){
        let output = recipe.out[i];
        if(entryKey(output) === key) continue;
        addTotal(result.byproducts, result.byproductList, output.kind, output.c, output.rate * count);
    }

    path.push(key);
    for(let i = 0; i < recipe.ins.length; i++){
        let input = recipe.ins[i];
        node.children.push(resolve(entryKey(input), input.rate * count, depth + 1, path, result, choices, options));
    }
    path.pop();

    return node;
}

function unitCost(unit){
    try{
        let cost = unit.getTotalRequirements();
        if(cost != null) return cost;
    }catch(e){}
    return null;
}

/**
 * Resolves the whole chain for `rate` units per second of `key`.
 * `choices` maps a resource key to a recipe id or RAW.
 * `options`: {planet, expandExtraction}.
 */
function solve(key, rate, choices, options){
    build();

    let result = {
        blocks: {}, blockList: [],
        raw: {}, rawList: [],
        byproducts: {}, byproductList: [],
        cost: {}, costList: [],
        power: 0, powerOut: 0, heat: 0, area: 0,
        nodes: 0, truncated: false,
        root: null
    };

    result.root = resolve(key, rate, 0, [], result, choices, options);

    //footprint and build cost use whole buildings/units
    for(let i = 0; i < result.blockList.length; i++){
        let entry = result.blockList[i];
        let whole = Math.ceil(entry.count - 0.0001);
        let requirements = entry.isUnit ? unitCost(entry.source) : entry.source.requirements;

        if(!entry.isUnit){
            let size = num(entry.source.size, 1);
            result.area += whole * size * size;
        }
        if(requirements == null) continue;
        for(let j = 0; j < requirements.length; j++){
            addTotal(result.cost, result.costList, "item", requirements[j].item, num(requirements[j].amount, 0) * whole);
        }
    }

    result.blockList.sort((a, b) => b.count - a.count);
    result.rawList.sort((a, b) => b.rate - a.rate);
    result.costList.sort((a, b) => b.rate - a.rate);

    return result;
}

exports.RAW = RAW;
exports.HEAT_KEY = HEAT_KEY;
exports.build = build;
exports.reset = reset;
exports.solve = solve;
exports.producersOf = producersOf;
exports.ranked = ranked;
exports.extractorsFor = extractorsFor;
exports.outputRate = outputRate;
exports.unavailable = unavailable;
exports.onPlanet = onPlanet;
exports.terrainOnMap = terrainOnMap;
exports.isExtraction = isExtraction;
exports.itemKey = itemKey;
exports.liquidKey = liquidKey;
exports.entryKey = entryKey;
exports.kindOf = kindOf;
exports.isItemKey = isItemKey;
exports.contentOf = contentOf;
exports.samePlanet = samePlanet;
exports.recipes = () => recipes;
