"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addEvent = addEvent;
exports.getEvents = getEvents;
const EVENTS = [];
function addEvent(e) {
    EVENTS.push(e);
}
function getEvents(sinceMinutes = 120) {
    var _a;
    const cutoff = Date.now() - sinceMinutes * 60000;
    const items = EVENTS.filter(e => e.ts >= cutoff);
    // group by project for nicer prompts
    const byProject = {};
    for (const e of items)
        (byProject[_a = e.project] ?? (byProject[_a] = [])).push(e);
    return byProject;
}
