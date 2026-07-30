#!/usr/bin/env bash
set -euo pipefail

dist_dir="${MANAS_RELEASE_DIST_DIR:-dist}"
version="$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)')"
release_tag="${MANAS_RELEASE_TAG:-}"
target="${MANAS_RELEASE_TARGET:-all}"

if [[ -n "$release_tag" && "$release_tag" != "v$version" ]]; then
	printf 'Release tag %s does not match package version v%s\n' "$release_tag" "$version" >&2
	exit 1
fi

mkdir -p "$dist_dir"

case "$target" in
	all) targets=(darwin-arm64 darwin-x64) ;;
	darwin-arm64|darwin-x64) targets=("$target") ;;
	*) printf 'Unsupported release target: %s\n' "$target" >&2; exit 1 ;;
esac

bun run generate:version
bun run check:release-version
bun run check:literal-imports
bun run check:runtime-assets
artifacts=()
for target in "${targets[@]}"; do
	artifact="manas-$target"
	bun build src/cli.ts --compile --target="bun-$target" --outfile "$dist_dir/$artifact"
	artifacts+=("$artifact")
done

for artifact in "${artifacts[@]}"; do
	artifact="$dist_dir/$artifact"
	if [[ ! -s "$artifact" ]]; then
		printf 'Expected non-empty release artifact: %s\n' "$artifact" >&2
		exit 1
	fi
done

(
	cd "$dist_dir"
	shasum -a 256 "${artifacts[@]}" > SHA256SUMS
)
