# opendesign-usage

Shows the OpenDesign (AMR) coding-plan allowance windows in the footer:

```
~/project (main) · 42.3%/200k · 5h:99% 7d:100% · (amr-link) deepseek-v4.1-flash
```

Percentages are **remaining** quota (`remainingCredits / limitCredits`), matching the OpenDesign console. Only displayed while a model from one of the configured providers (default: `amr-link`) is active.

## How it works

Reads `~/.pi/agent/opendesign-usage.json`, resolves the workspace, then polls:

```
GET {apiUrl}/api/v1/workspaces/{workspaceId}/billing/preflight?modelId={currentModel}
```

with the **control key** (`vela_ctrl_…`). The response's `codingPlan.windows[]` carries `durationSeconds`, `usedCredits`, `limitCredits`, `remainingCredits` and `resetsAt`; `18000s` renders as `5h` and `604800s` as `7d`. Results are published via `setStatus("opendesign-usage")`.

The workspace ID is auto-resolved from `GET /api/v1/workspaces/current` (`activeWorkspaceId`) and cached, so the config only needs the control key.

Refreshes on session start, on model switches, after agent runs (throttled to once a minute), and on a timer (default 5 minutes).

## Configuration

`~/.pi/agent/opendesign-usage.json` (local-only, never commit it):

```json
{
  "controlKey": "vela_ctrl_…",
  "apiUrl": "https://amr-api.open-design.ai",
  "providers": ["amr-link"],
  "refreshIntervalMs": 300000
}
```

| Field | Required | Meaning |
|---|---|---|
| `controlKey` | yes | Control key (`vela_ctrl_…`). Also accepts `$ENV_VAR`; a leading `!command` is never executed |
| `apiUrl` | no | Control-plane origin, must be `https:` (default `https://amr-api.open-design.ai`) |
| `providers` | no | Provider IDs that own the account (default `["amr-link"]`) |
| `workspaceId` | no | Skip the `/workspaces/current` lookup with a fixed workspace ID |
| `refreshIntervalMs` | no | Poll interval, minimum 30000 (default 300000) |

Environment fallbacks: `OPENDESIGN_CONTROL_KEY`, `OPENDESIGN_API_URL`.

A missing or invalid config never blocks pi: the extension silently shows nothing.

## Getting a control key

A runtime key (`sk-amr_…`) cannot read billing. Use the same device-authorization flow as the official CLI:

1. Create an authorization:

   ```bash
   curl -s -X POST https://amr-api.open-design.ai/api/v1/cli/device-authorizations \
     -H 'content-type: application/json' \
     -d '{"host":"pi","profile":"prod","cliVersion":"0.0.0"}'
   ```

2. Open the returned `activationUrl` and approve the `userCode`.
3. Poll for the keys:

   ```bash
   curl -s -X POST https://amr-api.open-design.ai/api/v1/cli/device-authorizations/<deviceId>/token \
     -H 'content-type: application/json' \
     -d '{"deviceSecret":"<deviceSecret>"}'
   ```

   The approved frame carries `controlKey` (`vela_ctrl_…`) and `runtimeKey` (`sk-amr_…`). Put the control key in the config above. Approving also creates a runtime key in the account — revoke it in the console if you don't need it.

## Notes

- `…/billing/coding-plan-usage` is the console SPA's route and only accepts the browser session (`Cookie` + `x-vela-workspace-id`, no `Authorization`); every key shape answers `401`. `billing/preflight` exposes the same windows to the control key, which is why this extension uses it.
- Failed polls keep the last good status; switching to a non-configured provider, or a plan with no windows, clears it.
- The status turns yellow when any window is at or below 10%, and red at 0%.
- Requires a footer that renders extension statuses (e.g. compact-footer).
