#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

USAGE="Usage: $0 [--link] [--only EXTENSION...]

  --link, -l  Create symlinks from $REPO_DIR to $AGENT_DIR/extensions and $AGENT_DIR/configs
              (non-destructive; does not overwrite existing files)
  --only, -o  Install only the listed extensions. opl-footer, opl-input, and opl-modes
              are a bundle: selecting any one installs all three.
  --help      Show this help message and exit
  (no flag)   Install all extensions and configs (copy mode)"

MODE="copy"
ONLY=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help)
            echo "$USAGE"
            exit 0
            ;;
        --link|-l)
            MODE="symlink"
            shift
            ;;
        --only|-o)
            shift
            if [[ $# -eq 0 || "$1" == -* ]]; then
                echo "--only requires at least one extension name" >&2
                echo "$USAGE" >&2
                exit 1
            fi
            while [[ $# -gt 0 && "$1" != -* ]]; do
                ONLY+=("$1")
                shift
            done
            ;;
        *)
            echo "Unknown flag or extension: $1" >&2
            echo "$USAGE" >&2
            exit 1
            ;;
    esac
done

ALL_EXTENSIONS=(opl-browser opl-ctxtrim opl-footer opl-init opl-input opl-modes opl-questionnaire opl-simplebench opl-todo opl-webaccess)
BUNDLE=(opl-footer opl-input opl-modes)

contains() {
    local needle="$1"
    shift
    local value
    for value in "$@"; do
        [[ "$value" == "$needle" ]] && return 0
    done
    return 1
}

if [[ ${#ONLY[@]} -eq 0 ]]; then
    SELECTED=("${ALL_EXTENSIONS[@]}")
else
    SELECTED=()
    for extension in "${ONLY[@]}"; do
        if ! contains "$extension" "${ALL_EXTENSIONS[@]}"; then
            echo "Unknown extension: $extension" >&2
            echo "Available extensions: ${ALL_EXTENSIONS[*]}" >&2
            exit 1
        fi
    done

    for extension in "${ONLY[@]}"; do
        if contains "$extension" "${BUNDLE[@]}"; then
            SELECTED=("${BUNDLE[@]}")
            break
        fi
    done
    for extension in "${ONLY[@]}"; do
        if [[ ${#SELECTED[@]} -eq 0 ]] || ! contains "$extension" "${SELECTED[@]}"; then
            SELECTED+=("$extension")
        fi
    done
fi

# Configs mirror extension names. UI bundle extensions each have a config.
SELECTED_CONFIGS=()
for extension in "${SELECTED[@]}"; do
    config="$REPO_DIR/configs/$extension.json"
    [[ -f "$config" ]] && SELECTED_CONFIGS+=("$config")
done

echo "=== OPL Pi SHT Install ==="
echo "Mode: $MODE"
echo "Repo:  $REPO_DIR"
echo "Target: $AGENT_DIR"
echo "Extensions: ${SELECTED[*]}"
echo ""

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/configs"

if [[ "$MODE" == "symlink" ]]; then
    echo "[SYMLINK MODE] Creating symlinks..."
    echo ""

    for extension in "${SELECTED[@]}"; do
        dir="$REPO_DIR/extensions/$extension"
        dest="$AGENT_DIR/extensions/$extension"
        if [[ -e "$dest" || -L "$dest" ]]; then
            echo "  → $dest (exists, skipping)"
        else
            ln -s "$dir" "$dest"
            echo "  → $dest (symlinked)"
        fi
    done

    for file in "${SELECTED_CONFIGS[@]-}"; do
        [[ -n "$file" ]] || continue
        base=$(basename "$file")
        dest="$AGENT_DIR/configs/$base"
        if [[ -e "$dest" || -L "$dest" ]]; then
            echo "  → $dest (exists, skipping)"
        else
            ln -s "$file" "$dest"
            echo "  → $dest (symlinked)"
        fi
    done

    echo ""
    echo "Symlinks created."
else
    echo "[COPY MODE] Copying files..."
    echo ""

    for extension in "${SELECTED[@]}"; do
        dir="$REPO_DIR/extensions/$extension"
        dest="$AGENT_DIR/extensions/$extension"
        if [[ -d "$dest" ]]; then
            echo "  → $dest (exists, overwriting)"
            cp -R "$dir/." "$dest/"
        else
            cp -R "$dir" "$dest"
            echo "  → $dest (copied)"
        fi
    done

    for file in "${SELECTED_CONFIGS[@]-}"; do
        [[ -n "$file" ]] || continue
        base=$(basename "$file")
        dest="$AGENT_DIR/configs/$base"
        cp "$file" "$dest"
        echo "  → $dest (copied)"
    done

    echo ""
    echo "Files copied."
fi

echo ""
echo "Done. Extensions and configs are now available in $AGENT_DIR."
