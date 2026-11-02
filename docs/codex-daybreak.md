# Codex Daybreak

Daybreak is OpenAI's cyber access program for approved accounts. Codex agents show a Daybreak toggle (hat-glasses icon) next to Speed and Plan. Paseo offers Daybreak Blue only.

## What the toggle sends

The agent's `featureValues.daybreak` holds the choice. An absent key means Paseo has no choice yet, so a resumed thread's own choice applies to that agent. The adopted choice stays out of `featureValues`, so schedules and agents that copy this agent's settings do not inherit it. A choice made in Paseo survives model switches, restarts, schedules, and MCP `create_agent` settings. The composer also saves the choice as the Codex new-agent default, as it does for Plan. New Codex agents therefore start with the last choice. Speed works differently: new drafts always start at Normal.

| Codex request            | Field                                | Sent when                                                                                                                   |
| ------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `thread/start`           | `daybreakEnabled`                    | Paseo has a choice and the thread is persistent. Codex rejects the field on ephemeral threads.                              |
| `thread/metadata/update` | `daybreakEnabled`                    | The user changes the choice, a resumed thread disagrees with Paseo's choice, or rewind forks the thread. Failures only log. |
| `turn/start`             | `cyberAccessProgram: "daybreakBlue"` | The choice is on and the model is on the compatible list. Otherwise the field is omitted and Codex decides.                 |

The thread flag only stores the choice for other Codex clients. The turn's program is what requests access. OpenAI decides authorization. Its refusals arrive as normal turn errors.

Codex starts some turns itself: goal turns and a manual `/compact` (`thread/compact/start` takes only a thread id). Those turns carry no program from Paseo.

Switching the toggle posts "Daybreak is on for new turns." or "Daybreak is off." as a chat notice. An MCP call, a profile, or an older app can turn it on while the model is outside the list. In that case, the chat shows a warning that Daybreak is not available for that model. Codex history does not contain these rows. The session therefore keeps their timestamps in its persistence metadata (`daybreakNotices`). When Paseo rebuilds history, the session merges them back by time.

## Compatible models

`CODEX_DAYBREAK_MODEL_IDS` in `packages/server/src/server/agent/providers/codex-feature-definitions.ts` lists the models that accept Daybreak, matched on the exact model id. Every Codex model shows the toggle. On a model outside the list, the toggle is disabled and says why. Daybreak requires OpenAI, so custom Codex providers with their own endpoint never show it or send its fields.

The list is kept by hand because the model catalog lags. It is caller-specific, and on 2026-11-02 it listed only `standard` for every model while a Daybreak Blue turn on `gpt-6-sol` succeeded.

## Refresh the list on each Codex update

1. With the Codex binary Paseo runs, signed in to the approved account, print each model's cyber programs:

   ```bash
   codex debug models | jq -r '.models[] | "\(.slug)\t\(.available_access_programs.cyber // [] | join(","))"'
   ```

   `$CODEX_HOME/models_cache.json` holds the same data. Codex records its last refresh in the `fetched_at` field. Over the app-server, `model/list` with `includeHidden: true` returns it as `availableAccessPrograms.cyber` (an experimental field).

2. If the catalog lists Daybreak Blue for a model, add the model. The raw catalog spells it `daybreak_blue`, and `model/list` spells it `daybreakBlue`.
3. Do not remove a model because the catalog shows only `standard`. That is the lag described above. If Codex or OpenAI refuses Daybreak for a model, remove it. Codex 0.166 refuses Astra.
4. For a model you add without catalog proof, turn Daybreak on in a Paseo chat on that model and send one prompt. A refusal shows up as a turn error.
5. Confirm the wire fields still exist in the new Codex:

   ```bash
   codex app-server generate-ts --experimental --out /tmp/codex-ts
   grep -rl 'daybreakEnabled\|cyberAccessProgram' /tmp/codex-ts/v2
   ```

6. Update the list and the date in its comment, then run the Codex feature tests from `packages/server`:

   ```bash
   npx vitest run src/server/agent/providers/codex-app-server-agent.features.test.ts
   ```
