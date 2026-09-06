#!/bin/sh
# One command from a bare machine to Tizen Homebrew on the television:
#
#   curl -fsSL https://sushydev.github.io/tizen-homebrew/install.sh | sh
#
# It downloads the installer for this platform and runs it. The installer carries its own runtime,
# so nothing has to be installed first and nothing is left behind.

set -eu

REPO=SushyDev/tizen-homebrew

case "$(uname -s)" in
    Darwin) platform=macos ;;
    Linux) platform=linux ;;
    *) echo "This installer covers macOS, Linux and Windows. For Windows use PowerShell:" >&2
       echo "  irm https://sushydev.github.io/tizen-homebrew/install.ps1 | iex" >&2
       exit 1 ;;
esac

case "$(uname -m)" in
    arm64|aarch64) cpu=arm64 ;;
    x86_64|amd64) cpu=x64 ;;
    *) echo "No installer is built for $(uname -m)." >&2; exit 1 ;;
esac

asset="tizen-homebrew-installer-$platform-$cpu"

directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT INT TERM

echo "Downloading the installer for $platform-$cpu..."

if ! curl -fL --progress-bar "https://github.com/$REPO/releases/latest/download/$asset" -o "$directory/installer"; then
    echo "Could not download $asset from the latest release." >&2
    exit 1
fi

chmod +x "$directory/installer"

# Piped into sh, this script's stdin is the pipe rather than the keyboard, and the installer asks
# questions. The terminal itself is still there to be read from.
if [ -t 0 ]; then
    "$directory/installer" "$@"
elif [ -r /dev/tty ]; then
    "$directory/installer" "$@" < /dev/tty
else
    echo "Nothing to type on: run the installer from a terminal." >&2
    exit 1
fi
