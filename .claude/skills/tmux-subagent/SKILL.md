---
name: tmux-subagent
description: Use when a parent agent needs to run independent child agents in parallel, keep an Agent CLI alive across terminal or coordinator restarts, or inspect and resume a delegated task through tmux. 中文触发:tmux 子agent、tmux 子代理、tmux 多agent、并行子任务、后台 agent、一个 tmux 一个 agent、子智能体编排。English triggers: tmux subagent, tmux child agent, parallel subagents, persistent agent CLI, one tmux session per agent, delegate tasks with tmux.
---

# tmux Subagent

## Overview

Use tmux as the runtime container for a child Agent CLI. The parent agent owns the delegation, while each child agent gets an isolated tmux session that can survive the parent terminal or coordinator process restarting.

The primary mapping is:

```text
parent agent
├── tmux session: subagent-<task-id>-<role>
│   └── child Agent CLI
└── tmux session: subagent-<task-id>-<role>
    └── child Agent CLI
```

One tmux **session** maps to one child agent. A tmux window or pane is not a separate agent.

## When to Use

Use this skill when:

- A parent agent has two or more independent tasks to delegate.
- A child Agent CLI may run longer than the current turn or terminal connection.
- The parent needs to inspect output, send a follow-up, pause, resume, or stop a child agent.
- Child agents need separate working directories, branches, or file ownership.

Do not use tmux for a short command that can finish synchronously. Do not start parallel child agents when they may edit the same files without an explicit ownership plan.

## Core Rules

1. **One child agent, one session.** Never place multiple Agent CLIs in one session.
2. **Use exact names.** Use `subagent-<task-id>-<role>` and target the complete name. Do not use prefix matching or `kill-server`.
3. **Assign before launching.** Give each child a bounded task, working directory, owned files, constraints, and completion criteria.
4. **Verify each transition.** After creating a session, starting an agent, sending a follow-up, or stopping an agent, inspect the session and pane output.
5. **Persist results outside tmux.** Pane output is an observation channel, not the task record.
6. **Do not duplicate uncertain work.** If a session disappears or a command times out, inspect the worktree and result files before restarting the child.
7. **Bound retries.** Retry at most once automatically. Escalate when execution may already have produced side effects.
8. **Auto-clean completed sessions.** Start the completion watcher when launching a child. It may clean up only after the parent has recorded `accepted` feedback and the child task state is terminal.

## Task Contract

Use a task-specific directory. The default layout is:

```text
.agent/tasks/<task-id>/<role>/
├── assignment.md
├── status
├── result.md
├── events.jsonl
└── parent-feedback.md
```

Allowed `status` values:

```text
starting
running
blocked
needs_input
completed
failed
cancelled
unknown
```

The parent should write `assignment.md` before launch. The child should:

- Set `status` to `running` after it starts.
- Set `blocked` or `needs_input` instead of guessing through missing information.
- Write `result.md` with changed files, checks run, failures, and next action.
- Append a structured event to `events.jsonl` when it starts, blocks, completes, or fails.
- Set `completed` only after the requested work and verification are finished.

## Child-to-Parent Communication

tmux output is not a reliable message channel. It can be truncated, lost when a pane is replaced, or missed while the parent is disconnected. Use files as the durable mailbox and tmux as the wake-up and inspection channel.

The child reports these events:

```json
{"type":"task.started","taskId":"task-42/backend","state":"running","at":"2026-08-09T12:00:00Z"}
{"type":"task.blocked","taskId":"task-42/backend","state":"needs_input","at":"2026-08-09T12:05:00Z","reason":"需要确认 API 方案"}
{"type":"task.completed","taskId":"task-42/backend","state":"completed","at":"2026-08-09T12:20:00Z","resultPath":".agent/tasks/task-42/backend/result.md"}
{"type":"task.failed","taskId":"task-42/backend","state":"failed","at":"2026-08-09T12:20:00Z","reason":"focused test failed"}
```

Each event must include `type`, `taskId`, `state`, and an ISO timestamp in `at`. Completion and failure events must include either `resultPath` or `reason`.

The child must publish a completion report in `result.md` before setting `status` to `completed`:

```markdown
# Result

## Summary
What changed and why.

## Changed Files
- `path/to/file`: short description

## Verification
- `command`: pass/fail and relevant output

## Risks or Follow-up
Known gaps, blockers, or recommended next step.
```

Write the result first, append the event second, and update `status` last. For larger reports, write a temporary file in the same directory and rename it into place.

There are two notification modes:

1. **Durable mailbox:** the parent polls `status` and `events.jsonl`. This is the source of truth and works after either process restarts.
2. **Wake-up notification:** the child or an agent hook notifies the parent through the project's hook/gateway integration, or the parent receives a lightweight tmux signal. The notification only says "reread the task directory"; it does not replace the files.

If no hook or callback exists, the child cannot directly inject a message into the parent Agent CLI. It must still write the mailbox, and the parent must poll it at bounded intervals or after other delegated work completes.

## Parent Feedback

The parent must acknowledge every terminal or blocking report with one of these decisions:

| Feedback | Meaning | Next action |
|---|---|---|
| `accepted` | Result meets the assignment | Record the summary and stop the session |
| `changes_requested` | Work is usable but incomplete | Write exact requested changes and send one follow-up |
| `blocked` | Parent cannot resolve the blocker alone | Ask the user or another agent for the missing decision |
| `retry` | Execution failed before a duplicate side effect was possible | Restart at most once with the same task ID |
| `failed` | Work cannot be accepted | Preserve evidence and stop the session |
| `cancelled` | Parent no longer needs the task | Tell the child to stop and clean up its session |

Write feedback to `parent-feedback.md` before sending a tmux follow-up. The file is the durable instruction; `send-keys` only wakes the child:

```markdown
decision: changes_requested
task_id: task-42/backend
reviewed_at: 2026-08-09T12:00:00Z

Findings:
- `packages/api/src/foo.ts`: handle the timeout branch.

Required next step:
Run the focused test, update `result.md`, and report the exit code.
```

An accepted result should leave an audit-friendly record:

```markdown
decision: accepted
task_id: task-42/backend
reviewed_at: 2026-08-09T12:30:00Z

Checked:
- Changed files match `assignment.md`.
- Focused tests passed.
- No unrelated worktree changes were introduced.

Next step:
Stop and clean up the exact tmux session.
```

The parent should not reply with only “收到” or “完成”. It must state what was checked, whether the result was accepted, and what happens next. Acceptance is a parent verification decision, not a status string chosen by the child.

## Automatic Cleanup

The default lifecycle is:

```text
child writes result.md
→ child appends task.completed/task.failed
→ child updates status
→ parent verifies result and worktree
→ parent writes parent-feedback.md with accepted/failed/cancelled
→ watcher captures pane.log and kills the exact session
```

Automatic cleanup is deliberately gated by the parent's durable feedback. A child must not kill its own session immediately after writing `completed`, because the parent still needs to inspect the result and may request changes. `running`, `starting`, `blocked`, `needs_input`, and `unknown` are never auto-cleaned.

After launching a child, run a watcher in the parent shell or another durable process. The watcher must use exact task/session names and should be started once per task:

```bash
WATCH_INTERVAL=5
while tmux has-session -t "=$SESSION" 2>/dev/null; do
  state=$(tr -d '\n' < "$STATE_DIR/status" 2>/dev/null || true)
  decision=$(awk -F': ' '$1 == "decision" { print $2; exit }' \
    "$STATE_DIR/parent-feedback.md" 2>/dev/null || true)

  case "$state:$decision" in
    completed:accepted|failed:failed|cancelled:cancelled)
      tmux capture-pane -p -J -t "=$SESSION:0.0" -S -1000 \
        > "$STATE_DIR/pane.log"
      tmux kill-session -t "=$SESSION"
      break
      ;;
  esac
  sleep "$WATCH_INTERVAL"
done
```

The parent must inspect `status`, `result.md`, `events.jsonl`, the worktree, and `pane.log` before writing terminal feedback. If a watcher exits because the session disappeared, preserve the task files and follow the Recovery rules; do not relaunch automatically.

### Parent Handling Loop

```text
收到 task.completed / task.failed / task.blocked
→ 读取 status、result.md、events.jsonl 和 pane 输出
→ 检查子 agent 的改动、测试和产物
→ 写入 parent-feedback.md
→ accepted: 汇总结果并清理 session
→ changes_requested: 发送一条明确的返工指令
→ blocked: 补充信息或询问用户
→ retry: 仅在确认没有重复副作用时重启一次
→ failed/cancelled: 保存证据并停止 session
```

## Launch Workflow

### 1. Split and assign

Create one task ID per delegated task. Define file ownership before launching parallel workers:

```text
task-42/backend  -> packages/api/**
task-42/frontend -> packages/web/**
task-42/review   -> read-only review
```

If ownership overlaps, run the tasks sequentially or make the shared boundary explicit.

### 2. Create the session

```bash
TASK_ID="task-42"
ROLE="backend"
WORKDIR="/path/to/project"
SESSION="subagent-${TASK_ID}-${ROLE}"
STATE_DIR=".agent/tasks/${TASK_ID}/${ROLE}"

mkdir -p "$STATE_DIR"

if tmux has-session -t "=$SESSION" 2>/dev/null; then
  printf 'session already exists: %s\n' "$SESSION"
  exit 1
fi

tmux new-session -d -s "$SESSION" -c "$WORKDIR"
```

The exact-match form `=$SESSION` prevents a similarly named session from being mistaken for the target.

### 3. Start the child Agent CLI

Use the project-approved Agent CLI and pass the assignment explicitly. Keep the command fixed and inspectable; do not construct it from untrusted model output.

```bash
AGENT_COMMAND="opencode"

tmux send-keys -l -t "=$SESSION:0.0" "$AGENT_COMMAND"
tmux send-keys -t "=$SESSION:0.0" Enter

tmux capture-pane -p -J -t "=$SESSION:0.0" -S -40
```

Then provide the assignment through the CLI's supported input mechanism. The assignment must include:

```text
Task ID: task-42/backend
Working directory: /path/to/project
Owned files: packages/api/**
Do not edit: packages/web/**
Completion criteria: tests pass and result.md is written
Result path: .agent/tasks/task-42/backend/result.md
```

Do not treat “command sent” as “agent started”. Confirm that the Agent CLI is actually running and has received the assignment.

### 4. Start the completion watcher

Start the watcher only after the session and task directory exist, and after the Agent CLI has been verified. Run it outside the child pane so it survives the child CLI exiting:

```bash
(
  WATCH_INTERVAL=5
  while tmux has-session -t "=$SESSION" 2>/dev/null; do
    state=$(tr -d '\n' < "$STATE_DIR/status" 2>/dev/null || true)
    decision=$(awk -F': ' '$1 == "decision" { print $2; exit }' \
      "$STATE_DIR/parent-feedback.md" 2>/dev/null || true)
    case "$state:$decision" in
      completed:accepted|failed:failed|cancelled:cancelled)
        tmux capture-pane -p -J -t "=$SESSION:0.0" -S -1000 \
          > "$STATE_DIR/pane.log"
        tmux kill-session -t "=$SESSION"
        break
        ;;
    esac
    sleep "$WATCH_INTERVAL"
  done
) &
WATCHER_PID=$!
```

Record `WATCHER_PID` if the parent may need to stop it. On `changes_requested`, leave the session alive and send one follow-up. After the child publishes a new result, the parent must rewrite `parent-feedback.md` with the new decision; the watcher then performs cleanup.

## Monitor and Communicate

Inspect both the persisted state and the pane:

```bash
cat "$STATE_DIR/status"
cat "$STATE_DIR/result.md" 2>/dev/null || true
tmux list-panes -t "=$SESSION" \
  -F 'pane=#{pane_id} pid=#{pane_pid} dead=#{pane_dead} cmd=#{pane_current_command}'
tmux capture-pane -p -J -t "=$SESSION:0.0" -S -100
```

Send a follow-up only after reading the current state. Send one instruction, then verify its effect:

```bash
FOLLOW_UP="Run the focused test and update result.md with the exit code."
tmux send-keys -l -t "=$SESSION:0.0" "$FOLLOW_UP"
tmux send-keys -t "=$SESSION:0.0" Enter
tmux capture-pane -p -J -t "=$SESSION:0.0" -S -60
```

If the child reports `needs_input`, stop and ask the user or parent agent for the missing decision. Do not invent credentials, product choices, or confirmation for an irreversible action.

## Recovery

When the parent or coordinator restarts:

1. Read the task directory and existing `status`.
2. Check the exact session with `tmux has-session -t "=$SESSION"`.
3. Capture the last pane output.
4. Check `result.md` and the worktree before sending any command.
5. Resume an existing live agent instead of starting a duplicate.
6. Restart only when the session is gone, the task is not completed, and duplicate side effects have been ruled out.

Interpret these cases conservatively:

| Evidence | Action |
|---|---|
| Session exists and status is `running` | Observe; do not relaunch |
| Session exists and status is `needs_input` | Ask for the missing input |
| Session is gone and `completed` plus result exists | Collect the result; do not relaunch |
| Session is gone and status is `unknown` | Inspect worktree and logs before deciding |
| Pane is dead but result is absent | Mark `failed` or `unknown`; inspect exit output |
| RPC/terminal call timed out | Do not assume the child stopped; inspect first |

## Stop and Clean Up

Normally the completion watcher performs cleanup after accepted terminal feedback. For manual cleanup, stop only the exact child session after preserving its result:

```bash
tmux capture-pane -p -J -t "=$SESSION:0.0" -S -1000 \
  > "$STATE_DIR/pane.log"

tmux send-keys -t "=$SESSION:0.0" C-c
tmux kill-session -t "=$SESSION"
```

Never run `tmux kill-server` for task cleanup. It can terminate unrelated agents and the parent process. Do not kill a session merely because its pane is quiet; first inspect status, process state, and the last output.

If a task is accepted but the watcher is unavailable, use the manual cleanup block above and record `decision: accepted` first. If the watcher is still running after manual cleanup, stop that watcher process as well; never leave a polling process behind.

## Common Failure Modes

| Failure | Correct response |
|---|---|
| Two tasks use the same session name | Stop and create a unique task ID; do not attach to the existing session |
| A follow-up appears to have no effect | Capture the pane, verify focus and process state, then retry once |
| A worker exits during an RPC timeout | Inspect output and result files; do not immediately rerun |
| A worker edits another worker's files | Stop or pause the worker and resolve ownership before continuing |
| The parent restarts while workers continue | Reconcile sessions and task files before issuing new commands |
| User asks to “清理 tmux” | Clean only sessions created for the current task |

## Completion Checklist

- [ ] Each delegated task has one exact tmux session.
- [ ] Each child has a bounded assignment and file ownership.
- [ ] The Agent CLI was verified after launch.
- [ ] Follow-ups were sent only after reading current state.
- [ ] `result.md` contains verification evidence.
- [ ] Unknown or blocked work is reported explicitly.
- [ ] No duplicate child was started after a timeout or restart.
- [ ] A completion watcher was started for each child, or its absence was explicitly handled.
- [ ] Terminal feedback was written before cleanup.
- [ ] Cleanup targeted only the current task's sessions and left no watcher process behind.
