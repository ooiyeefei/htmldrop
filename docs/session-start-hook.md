# SessionStart hook for edit-mode sessions

Run `htmldrop edit ls --json` when a new agent session starts so the agent can immediately see any local edit-mode review sessions that are waiting for attention.

## Claude Code hook

Add a `SessionStart` hook to `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "htmldrop edit ls --json"
          }
        ]
      }
    ]
  }
}
```

Your harness may use a different settings file or hook schema; adapt the same command to whatever startup hook it provides.

## Agent-agnostic usage

This is not Claude-specific. Any agent runner can execute:

```sh
htmldrop edit ls --json
```

at startup and inspect the returned summary before beginning work.

## Example output

```json
{
  "sessions": [
    {
      "file": "report.html",
      "path": "/home/alex/project/report.html",
      "status": "open",
      "pendingMessages": 1,
      "undeliveredComments": 2,
      "pendingQuestion": false,
      "totalComments": 5,
      "updatedAt": "2026-05-25T18:42:10.123Z",
      "url": "http://127.0.0.1:49152/s/abcd1234ef567890/"
    }
  ],
  "summary": {
    "total": 1,
    "needsAttention": 1
  }
}
```

If `summary.needsAttention` is greater than `0`, the agent should inspect the sessions where `status` is `open` and at least one of `pendingMessages`, `undeliveredComments`, or `pendingQuestion` is non-zero/true, then poll or reply as appropriate.
