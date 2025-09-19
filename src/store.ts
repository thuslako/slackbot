export type EventItem = {
    ts: number;
    source: "sentry" | "gitlab";
    project: string;
    kind: string;
    title: string;
    url?: string;
    details?: unknown;
  };
  
  const EVENTS: EventItem[] = [];
  
  export function addEvent(e: EventItem) {
    EVENTS.push(e);
  }
  
  export function getEvents(sinceMinutes = 120) {
    const cutoff = Date.now() - sinceMinutes * 60_000;
    const items = EVENTS.filter(e => e.ts >= cutoff);
    // group by project for nicer prompts
    const byProject: Record<string, EventItem[]> = {};
    for (const e of items) (byProject[e.project] ??= []).push(e);
    return byProject;
  }
  