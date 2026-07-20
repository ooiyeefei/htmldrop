# HTMLDrop — OpenAI Build Week narration

**Video (master):** `artifacts/openai-build-week/htmldrop-journey-final.mp4`
**Video (upload):** `artifacts/openai-build-week/htmldrop-journey-final-youtube.mp4` — 1920×1080
**Runtime:** 2:51.72 (cap is 3:00 — 8s of margin)
**Source of timings:** `artifacts/openai-build-week/beats.json`, measured from the
encoded MP4, not from planned waits. Deriving them from planned waits is what caused
the drift in the previous cut.

**Voice:** conversational, unhurried, decisive. Small pause at each slide boundary.

## Paste into StoryFlow

```text
Slide 1 | 0:02–0:09 | AI lets us all write proposals faster than anyone can read them. So everyone generates. And few truly read.
Slide 2 | 0:09–0:17 | So the document forks before anyone answers it. htmldrop starts earlier, while the draft is still local and nobody else has seen it.
Slide 3 | 0:17–0:31 | Maya's agent has already turned her rough brief into something people can argue with. A working interface, the evidence behind it, and one trade-off she hasn't settled. She picks the sentence she wants changed and comments on it.
Slide 4 | 0:31–0:41 | The agent replies, then edits the file. htmldrop is watching that file, so the page reloads where she left it and the trade-off card is simply there.
Slide 5 | 0:41–0:52 | The artifact is the deliverable. That interface is real, and so are the diagrams. The agent wrote them against htmldrop's design contract, which pins Mermaid rather than hand-built boxes.
Slide 6 | 0:52–0:58 | The split is deliberate. Agents draft and synthesize, htmldrop hosts and anchors, and the deciding stays with a person.
Slide 7 | 0:58–1:08 | One command publishes it. The link is encrypted, and the password is generated and then stored nowhere. You can also enable the feedback mode by default.
Slide 8 | 1:08–1:19 | A teammate opens the same link and unlocks it. There is no account to make and no second copy to reconcile. The conversation sits on the document itself.
Slide 9 | 1:19–1:30 | Sam reads it. The comments already there are attached to the exact claims they argue with, so clicking one takes him straight to the sentence in question.
Slide 10 | 1:30–1:42 | Now he adds his own. He selects the rollout order and argues it should be inverted, with internal documents going first. His objection lives on that sentence instead of in a chat thread.
Slide 11 | 1:42–1:56 | Then he does something you cannot do in a comment thread. He drags a box over the architecture diagram and leaves a note on the picture itself, asking for the converge box to say proposes instead.
Slide 12 | 1:56–2:06 | That is four comments from two reviewers on one document. Maya's agent pulls the whole thread, and every comment still carries the thing it was attached to.
Slide 13 | 2:06–2:21 | Then converge sends it to GPT-5.6 Luna through the OpenAI Responses API. It reads all four comments, including the one drawn on the diagram, and writes a revised HTML document for Maya to review.
Slide 14 | 2:21–2:31 | The vague metric now has a baseline: eighteen clarification loops a week, cut by half. The rollout order flipped to internal documents first, which is what Sam asked for.
Slide 15 | 2:31–2:36 | The diagram changed too, because Sam drew on it. That box now says proposes edits.
Slide 16 | 2:36–2:52 | The trade-off nobody had evidence for, it left alone. That one is still Maya's call. Codex and GPT-5.6 built all of this: edit mode, converge, the feedback loop, and the recording you just watched. One link. One decision.
```

## Pacing

Twenty-four visual beats merged into sixteen narration slides. Every slot is between
5.5 and 15.7 seconds, and every slide sits between 2.2 and 3.1 words per second
(2.74 average across 450 words), so none should trip StoryFlow's silence or density
flags the way the previous script did.

The wording was passed through the humanizer skill (blader/humanizer, based on
Wikipedia's "Signs of AI writing"). Removed: em dashes throughout, staccato triples
("No account. No export. No second copy."), tailing negations ("never hand-built
boxes", "A proposal, not a decision"), authority tropes ("This is the part people
underestimate"), and the aphorism "That distinction is the whole product". Two things
were deliberately kept: "Everyone generates. Few truly read." is the author's own line
from the htmldrop blog, and "One link. One decision." is the tagline printed on the
closing card.

| Slide | Window | Length | Words | w/s |
|---|---|---|---|---|
| 1 | 0:02–0:09 | 7.4s | 19 | 2.57 |
| 2 | 0:09–0:17 | 8.2s | 23 | 2.80 |
| 3 | 0:17–0:31 | 14s | 38 | 2.71 |
| 4 | 0:31–0:41 | 9.3s | 27 | 2.90 |
| 5 | 0:41–0:52 | 10.9s | 29 | 2.66 |
| 6 | 0:52–0:58 | 6.4s | 19 | 2.97 |
| 7 | 0:58–1:08 | 9.7s | 28 | 2.89 |
| 8 | 1:08–1:19 | 10.9s | 28 | 2.57 |
| 9 | 1:19–1:30 | 11s | 27 | 2.45 |
| 10 | 1:30–1:42 | 11.9s | 33 | 2.77 |
| 11 | 1:42–1:56 | 14.2s | 36 | 2.54 |
| 12 | 1:56–2:06 | 9.9s | 27 | 2.73 |
| 13 | 2:06–2:21 | 14.8s | 34 | 2.30 |
| 14 | 2:21–2:31 | 10s | 29 | 2.90 |
| 15 | 2:31–2:36 | 5.5s | 15 | 2.73 |
| 16 | 2:36–2:52 | 15.7s | 38 | 2.42 |

## The closing card

The take itself ends at 2:44.20 on a fade to black, but slide 16 is still being
spoken past that point. `scripts/demo/append-closing.mjs` renders
`docs/demo/closing-card.html` and appends it as a 7.5s hold that fades up out of
that same black, taking the video to 2:51.72. Slide 16's window is widened to
2:36–2:52 so the line always has picture under it wherever the voice lands.

The card carries the live URL and password, which is the rules' "way for judges to
test your project". **If you re-stage, the password rotates — update
`docs/demo/closing-card.html` before re-appending, or the card will show a dead one.**

## Accuracy constraints — do not soften these

Every claim below was checked against the code or the converged document, so a judge
can verify it from the repository.

- **HTMLDrop does not generate the design or the diagrams.** The agent authors the
  HTML; HTMLDrop prints the contract (`htmldrop design`, `htmldrop playbook diagram`),
  serves it live, publishes it, anchors the feedback, and synthesizes it. Slide 5 says
  exactly this.
- **GPT-5.6 proposes; it does not decide.** Slide 13 ends on "writes a revised HTML document for
  Maya to review", which carries the same claim without the slogan.
- **What converge actually did**, verified in `decision-brief.converged.html`: it applied
  all four comments — measurable baseline, inverted rollout, named owner, and the diagram
  edit — and left the open speed-versus-audit-trail trade-off untouched. Slides 14–16
  follow the document, not the other way round.
- **Slide 15 is the strongest proof point.** A comment drawn as a box over the diagram
  caused GPT-5.6 to edit that diagram's Mermaid source: the node that read
  `Converge / GPT-5.6 Luna` now reads `Converge / proposes edits`. This is region
  anchoring and agent synthesis in one visible result — lead with it if anything is cut.
- **The password on screen is real** and the link is live, which is how a judge tests the
  project without rebuilding it.
- Do not add music without clear rights. The YouTube upload must be public and under
  three minutes.

## Where Codex and GPT-5.6 appear on screen

The rules require the audio to cover both. Both are also visible, not merely narrated:

- **GPT-5.6** — the converge terminal at 2:06 shows `Synthesizing feedback via openai
  (gpt-5.6-luna)` in real command output, and 2:21–2:44 shows the document it produced.
- **Codex** — credited in slide 16. Use the Codex session where the core functionality
  was built for the submission form's session-ID field.

## Reproducing

```bash
set -a; . ./.env.local; set +a          # OPENAI_API_KEY
node scripts/demo/stage.mjs             # publish, clear, seed two comments
node scripts/demo/record.mjs            # one continuous take + beats.json
node scripts/demo/append-closing.mjs    # closing card -> final master + YouTube cut
```

`stage.mjs` rotates the password on every run, so re-record and re-read the password
from `docs/demo/.demo-manifest.json` (gitignored) before publishing the video.
