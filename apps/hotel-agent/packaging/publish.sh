#!/usr/bin/env bash
# Builds the self-contained hotel agent for one platform and packs it as the updater expects:
#   packaging/publish.sh <version> <linux-x64|win-x64> [out-dir]
# → <out>/hotella-agent-<version>-<rid>.zip (+ .sha256). No .NET is needed on the hotel machine.
set -euo pipefail
version="${1:?version, e.g. 0.10.2}"
rid="${2:?runtime id: linux-x64 or win-x64}"
out="${3:-$(pwd)/dist}"
here="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
dotnet publish "$here/src/Hotella.Agent/Hotella.Agent.csproj" -c Release -r "$rid" --self-contained \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:Version="$version" \
  -o "$stage" --nologo -v quiet
cp "$here/src/Hotella.Agent/agent.example.json" "$stage/"
mkdir -p "$out"
zip_file="$out/hotella-agent-$version-$rid.zip"
rm -f "$zip_file"
(cd "$stage" && zip -qr "$zip_file" .)
sha256sum "$zip_file" | cut -d' ' -f1 > "$zip_file.sha256"
echo "$zip_file"
