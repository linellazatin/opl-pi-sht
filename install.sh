#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# Pi's own resolver is PI_CODING_AGENT_DIR else ~/.pi/agent (dist/config.js getAgentDir()).
# PI_AGENT_DIR is accepted as a legacy alias for scripts written against older releases.
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
case "$AGENT_DIR" in
    "~/"*) AGENT_DIR="$HOME/${AGENT_DIR#\~/}" ;;
esac
AGENT_DIR_SOURCE="PI_CODING_AGENT_DIR"
[[ -n "${PI_CODING_AGENT_DIR:-}" ]] || AGENT_DIR_SOURCE="${PI_AGENT_DIR:+PI_AGENT_DIR (legacy alias)}"
[[ -n "${AGENT_DIR_SOURCE}" ]] || AGENT_DIR_SOURCE="default (~/.pi/agent)"

USAGE="Usage: $0 [--link] [--only EXTENSION...] [--force-configs] [--no-prune]

  --link, -l        Create symlinks from $REPO_DIR to \$AGENT_DIR/extensions and \$AGENT_DIR/configs
                    (non-destructive; does not overwrite existing files)
  --only, -o        Install only the listed extensions. opl-footer, opl-input, and opl-modes
                    are a bundle: selecting any one installs all three.
  --force-configs   Overwrite config files that already exist in \$AGENT_DIR/configs.
  --no-prune        Keep extension directories recorded by a previous install of this
                    collection even when this release no longer ships them.
  --help            Show this help message and exit
  (no flag)         Install all extensions and configs (copy mode)

Configs come from configs/<extension>.json when the repo carries one, otherwise from
configs/<extension>.json.sample (the shipped default). An existing file in
\$AGENT_DIR/configs is never overwritten unless --force-configs is given."

MODE="copy"
FORCE_CONFIGS=0
PRUNE=1
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
        --force-configs)
            FORCE_CONFIGS=1
            shift
            ;;
        --no-prune)
            PRUNE=0
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

ALL_EXTENSIONS=(opl-browser opl-ctxtrim opl-footer opl-guardian opl-init opl-input opl-modes opl-questionnaire opl-simplebench opl-todo opl-webaccess)
BUNDLE=(opl-footer opl-input opl-modes)
# Extensions that ship no config file.
CONFIGLESS=(opl-ctxtrim)

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
    for extension in "${ONLY[@]}"; do
        if ! contains "$extension" "${ALL_EXTENSIONS[@]}"; then
            echo "Unknown extension: $extension" >&2
            echo "Available extensions: ${ALL_EXTENSIONS[*]}" >&2
            exit 1
        fi
    done

    SELECTED=()
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

MANIFEST="$AGENT_DIR/extensions/.opl-pi-sht.installed"

# Resolve the config file to install for an extension: live config, then shipped sample.
config_source() {
    local extension="$1"
    local live="$REPO_DIR/configs/$extension.json"
    local sample="$REPO_DIR/configs/$extension.json.sample"
    if [[ -f "$live" ]]; then
        echo "$live"
    elif [[ -f "$sample" ]]; then
        echo "$sample"
    else
        echo ""
    fi
}

echo "=== OPL Pi SHT Install ==="
echo "Mode: $MODE"
echo "Repo:   $REPO_DIR"
echo "Target: $AGENT_DIR  ($AGENT_DIR_SOURCE)"
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

    for extension in "${SELECTED[@]}"; do
        contains "$extension" "${CONFIGLESS[@]}" && continue
        source_file=$(config_source "$extension")
        base="$extension.json"
        dest="$AGENT_DIR/configs/$base"
        if [[ -z "$source_file" ]]; then
            echo "  ! no config for $extension in $REPO_DIR/configs (skipped)" >&2
            continue
        fi
        if [[ -e "$dest" || -L "$dest" ]]; then
            echo "  → $dest (exists, skipping)"
        else
            ln -s "$source_file" "$dest"
            echo "  → $dest (symlinked $(basename "$source_file"))"
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

    for extension in "${SELECTED[@]}"; do
        contains "$extension" "${CONFIGLESS[@]}" && continue
        source_file=$(config_source "$extension")
        base="$extension.json"
        dest="$AGENT_DIR/configs/$base"
        if [[ -z "$source_file" ]]; then
            echo "  ! no config for $extension in $REPO_DIR/configs (skipped)" >&2
            continue
        fi
        if [[ -e "$dest" && "$FORCE_CONFIGS" -eq 0 ]]; then
            echo "  → $dest (exists, keeping it)"
            continue
        fi
        cp "$source_file" "$dest"
        chmod 600 "$dest"
        if [[ "$source_file" == *.sample ]]; then
            echo "  → $dest (copied, shipped default)"
        else
            echo "  → $dest (copied)"
        fi
    done

    echo ""
    echo "Files copied."
fi

# Record what this collection installed, then drop leftovers from earlier releases.
# pi auto-discovers $AGENT_DIR/extensions/*/index.ts, so an un-pruned directory from an
# older release keeps loading beside the new one (duplicate commands and tools).
previous=()
if [[ -f "$MANIFEST" ]]; then
    while IFS= read -r line; do
        [[ -z "$line" || "$line" == \#* ]] && continue
        previous+=("$line")
    done < "$MANIFEST"
fi

# The record is "what this collection has installed here": the selection just installed, plus
# anything an earlier run recorded that this release still ships (an extension installed by a
# previous --only run). Names this release no longer ships are pruned below and forgotten.
merged=("${SELECTED[@]}")
for name in "${previous[@]-}"; do
    contains "$name" "${ALL_EXTENSIONS[@]}" || continue
    contains "$name" "${merged[@]}" || merged+=("$name")
done

TMP_MANIFEST="$MANIFEST.tmp"
echo "# Installed by install.sh — one extension directory per line." > "$TMP_MANIFEST"
for name in "${merged[@]}"; do
    echo "$name" >> "$TMP_MANIFEST"
done
mv "$TMP_MANIFEST" "$MANIFEST"

if [[ "$PRUNE" -eq 1 ]]; then
    for name in "${previous[@]-}"; do
        [[ -z "$name" ]] && continue
        contains "$name" "${ALL_EXTENSIONS[@]}" && continue
        stale="$AGENT_DIR/extensions/$name"
        if [[ -L "$stale" || -d "$stale" ]]; then
            rm -rf "$stale"
            echo "  - pruned $stale (not shipped by this release)"
        fi
        stale_config="$AGENT_DIR/configs/$name.json"
        if [[ -e "$stale_config" || -L "$stale_config" ]]; then
            echo "  ! $stale_config belongs to a pruned extension; remove it if it was not added by hand" >&2
        fi
    done
fi

echo ""
echo "Done. Extensions and configs are now available in $AGENT_DIR."
