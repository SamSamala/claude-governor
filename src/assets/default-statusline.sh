#!/bin/bash
# Governor default status line — installed only when the user had none of their own.
# Order: current dir | model name | context usage (bar) | 5h rate limit (bar) | git branch/status

# --- Colors (ANSI escape codes) ---
RESET=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
GRAY=$'\033[90m'
CYAN=$'\033[36m'
MAGENTA=$'\033[35m'
BLUE=$'\033[34m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'

BAR_WIDTH=9

# Renders a colored "[bar] NN%" string for a given percentage (0-100).
# Color reflects fill level: red at/above $2 (default 80), yellow at/above
# $3 (default 50), green below. Callers can pass a lower red threshold, e.g.
# the context bar goes red earlier for models with smaller usable windows.
render_bar() {
  local pct_raw="$1"
  local red_at="${2:-80}"
  local yellow_at="${3:-50}"
  local pct
  pct=$(printf '%.0f' "$pct_raw" 2>/dev/null)
  [ -z "$pct" ] && pct=0
  (( pct < 0 )) && pct=0
  (( pct > 100 )) && pct=100

  local color
  if (( pct >= red_at )); then
    color="$RED"
  elif (( pct >= yellow_at )); then
    color="$YELLOW"
  else
    color="$GREEN"
  fi

  local filled=$(( (pct * BAR_WIDTH + 50) / 100 ))
  (( filled > BAR_WIDTH )) && filled=$BAR_WIDTH
  local empty=$(( BAR_WIDTH - filled ))

  local bar_filled bar_empty
  bar_filled=$(printf '%*s' "$filled" '' | tr ' ' '█')
  bar_empty=$(printf '%*s' "$empty" '' | tr ' ' '░')

  printf '%s[%s%s%s%s]%s %d%%' "$color" "$bar_filled" "$GRAY" "$bar_empty" "$RESET" "$color" "$pct"
  printf '%s' "$RESET"
}

# Seconds -> compact duration: 3d4h, 2h14m, 47m, <1m
fmt_dur() {
  local s="$1"
  (( s < 0 )) && s=0
  local d=$(( s / 86400 ))
  local h=$(( (s % 86400) / 3600 ))
  local m=$(( (s % 3600) / 60 ))
  if   (( d > 0 )); then printf '%dd%dh' "$d" "$h"
  elif (( h > 0 )); then printf '%dh%02dm' "$h" "$m"
  elif (( m > 0 )); then printf '%dm' "$m"
  else printf '<1m'
  fi
}

# Renders " · <time left>" for a rate-limit reset epoch. resets_at arrives as a
# unix timestamp; tolerate a millisecond-scale value in case that ever changes.
render_reset() {
  local raw="${1%%.*}"
  [ -z "$raw" ] && return 0
  case "$raw" in (*[!0-9]*) return 0 ;; esac
  (( raw > 100000000000 )) && raw=$(( raw / 1000 ))
  local left=$(( raw - $(date +%s) ))
  (( left < 0 )) && left=0
  printf ' %s·%s %s%s%s' "$GRAY" "$RESET" "$DIM" "$(fmt_dur "$left")" "$RESET"
}

input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir')
dir="$cwd"
case "$dir" in
  "$HOME"/*) dir="~${dir#"$HOME"}" ;;
  "$HOME") dir="~" ;;
esac
model=$(echo "$input" | jq -r '.model.display_name')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
five=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
five_reset=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')

segments=()

# Directory segment (full absolute path, with ~ substitution for $HOME)
segments+=("${GRAY}Dir${RESET} ${BOLD}${CYAN}${dir}${RESET}")

# Model segment
segments+=("${GRAY}Model${RESET} ${MAGENTA}${model}${RESET}")

# Context usage segment.
# Red threshold depends on the model: Opus goes red past 25%, Sonnet past 50%,
# anything else keeps the default 80%. Yellow warns at ~3/5 of the red mark.
if [ -n "$used" ]; then
  model_lc=$(printf '%s' "$model" | tr '[:upper:]' '[:lower:]')
  case "$model_lc" in
    *opus*)   ctx_red=25 ;;
    *sonnet*) ctx_red=50 ;;
    *)        ctx_red=80 ;;
  esac
  ctx_yellow=$(( ctx_red * 3 / 5 ))
  segments+=("${GRAY}Ctx${RESET} $(render_bar "$used" "$ctx_red" "$ctx_yellow")")
fi

# 5-hour rate limit, with a countdown to reset
if [ -n "$five" ]; then
  segments+=("${GRAY}5h${RESET} $(render_bar "$five")$(render_reset "$five_reset")")
fi

# Git segment: only shown when cwd is inside a git repository (checked dynamically at render time)
if git -C "$cwd" --no-optional-locks rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)
  dirty=""
  if [ -n "$(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null)" ]; then
    dirty="${YELLOW}*${RESET}"
  fi
  segments+=("${GRAY}git${RESET} ${BLUE}${branch}${RESET}${dirty}")
fi

sep=" ${GRAY}|${RESET} "
out=""
for i in "${!segments[@]}"; do
  if [ "$i" -eq 0 ]; then
    out="${segments[$i]}"
  else
    out="${out}${sep}${segments[$i]}"
  fi
done

printf '%s' "$out"
