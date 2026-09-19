/*
 * All visible text lives in bundles/bundle*.properties so it can be translated
 * without touching the code.
 */

const prefix = "prodcalc.";

/** Localized string for a key, or the key itself when a translation is missing. */
function t(key){
    return String(Core.bundle.get(prefix + key, prefix + key));
}

exports.t = t;
