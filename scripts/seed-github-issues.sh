#!/usr/bin/env bash
# Seed the scratch GitHub repo with the demo issue set. Idempotent: skips titles that already exist.
#   scripts/seed-github-issues.sh <owner/repo>            (uses your gh login)
# Mix: 5 good, 2 duplicates (created AFTER their originals), 2 out of scope, 2 vague, 1 support question.
set -euo pipefail
REPO=${1:?usage: seed-github-issues.sh <owner/repo>}
EXISTING=$(gh issue list -R "$REPO" --state all --limit 100 --json title --jq '.[].title')
add() { # title  body
  if printf '%s\n' "$EXISTING" | grep -qxF "$1"; then echo "  exists : $1"; return; fi
  gh issue create -R "$REPO" --title "$1" --body "${2:-}" >/dev/null && echo "  created: $1"; sleep 2   # distinct timestamps
}
add "Persist chat history so a user who rejoins a session sees the last 50 messages" "When a user reconnects to a session they currently see an empty chat. Store the last 50 messages per session on the server and send them on join."
add "Show the list of users currently connected to the session" "Add a sidebar listing everyone connected to the session, updated live as people join and leave."
add "Reconnect the websocket automatically with exponential backoff after a dropped connection" "Today a dropped connection requires a page refresh. Retry with exponential backoff (1s, 2s, 4s, max 30s) and resend queued messages."
add "Add a typing indicator when another user in the session is typing" "Show 'Alex is typing...' under the message list while another participant is typing."
add "Escape HTML in messages to prevent script injection" "Messages are rendered with innerHTML. Escape user content so a message like <img onerror=...> cannot run script."
add "Display who is online in the current session" "It would be nice to see which people are online right now in this chat."
add "Show a 'user is typing...' hint when someone else in the chat is typing" "Let me know when the other person is typing a reply."
add "Add a blockchain-based payment system for premium accounts" "Premium users should pay with a custom token on our own chain."
add "Migrate the company payroll system to SAP" "Move payroll to SAP by Q4."
add "Improve the chat" ""
add "Make it faster" ""
add "How do I deploy this?" "Is there a guide for deploying to production?"
echo "repo $REPO now has $(gh issue list -R "$REPO" --state all --limit 100 --json number --jq length) issues"
