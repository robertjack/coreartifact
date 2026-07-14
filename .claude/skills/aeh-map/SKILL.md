---
name: aeh-map
description: Chart a foggy scope as a fog-of-war map of tickets, resolve them one at a time, and graduate into a PRD when the route is clear.
argument-hint: "the loose idea to chart, or path to an existing map"
disable-model-invocation: true
---

# aeh-map

Some scopes arrive PRD-shaped; this skill is for the ones that arrive as fog — too big or too unknown for `/aeh-prd` to grill directly. Chart what you can see, resolve one question at a time, and **don't chart what you can't yet see**: pre-slicing fog into ticket-sized pieces is planning theater.

The map lives at `docs/maps/<slug>.md`. It is an **index, not a store** — decisions are gisted in one line each and detailed where they were resolved.

```markdown
## Notes            <!-- domain, standing preferences, skills every session should consult -->
## Decisions so far <!-- one line per resolved ticket: gist + pointer -->
## Tickets          <!-- ### T-3: <name> · [research|prototype|grill|task] · [open|blocked by T-1|done]
                         body: the question, sized to one session; resolution appended when closed -->
## Fog              <!-- the dim view: suspected questions you cannot yet phrase sharply -->
```

**Fog or ticket?** The test is whether you can state the question precisely now — not whether you can answer it. Sharp question → ticket, even if blocked. Can't phrase it sharply → fog, in whatever resolution the view allows.

**Ticket types**, each with its move:
- **research** — the answer lives outside this repo. Delegate to a background agent against *primary sources only* (official docs, source code, specs — never a secondary write-up); every claim cites the source that owns it. Findings land as a linked markdown asset.
- **prototype** — "how should it look/behave" is the question. Throwaway code that answers it: UI variants for look, a tiny interactive terminal app for state-model feel. One command to run, state surfaced after every action, deleted or absorbed when the answer is captured. The *answer* is the only keepable part.
- **grill** — the default: a decision resolvable by interview. One question at a time, recommended answer attached; sharpen terms into `CONTEXT.md` as they land.
- **task** — literal work that must happen before discussion can continue (sign up for a service, move data, provision access). Automate what you can; hand the operator a precise checklist for the rest; record resulting facts later tickets depend on.

**Working the map:** load the map (low-res — zoom into ticket detail only as needed), take the first open unblocked ticket or the one the operator names, resolve it, append the resolution to the ticket, add a one-line gist to Decisions so far. Then graduate: any fog the answer made sharply phrasable becomes a new ticket and leaves the Fog section; any ticket the answer invalidated is updated or deleted. Resolve tickets one at a time — the map update *is* the deliverable, not ticket throughput.

**Graduation:** when the remaining tickets are all "task" or empty and the route to the goal reads clearly from Decisions so far, the map's job is done — hand off to `/aeh-prd`, whose grilling starts from the Decisions as pre-answered questions. A map that never graduates is exploring for its own sake; put a ticket-count or budget bound in Notes at charting time.

Done (per session) when: exactly the worked tickets carry resolutions, Decisions so far indexes them, graduated fog left the Fog section, and the map still reads at a glance — names, never bare ticket numbers, in everything the operator sees.
