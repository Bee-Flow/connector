#!/usr/bin/env bash
# Pre-flight check for an App Store release.
#
# Mirrors the verifications the .github/workflows/release.yml job runs after
# a tag is pushed, so failures surface locally before the tag is published.
#
#   ./scripts/preflight.sh                  # uses <version> from info.xml
#   ./scripts/preflight.sh 0.1.2            # explicit version override
#   SIGNING_KEY=~/.nextcloud/certificates/bee_flow.key ./scripts/preflight.sh
#       └─ also dry-runs the tarball build + signature

set -euo pipefail

cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
amber() { printf '\033[33m%s\033[0m\n' "$*"; }

xml_ver=$(grep -oPm1 '(?<=<version>)[^<]+' appinfo/info.xml)
ver="${1:-$xml_ver}"

if [ "$xml_ver" != "$ver" ]; then
    red "✗ info.xml <version> ($xml_ver) does not match requested ($ver)"
    exit 1
fi
green "✓ info.xml version: $ver"

if ! grep -qE "^## \[?${ver}\]?" CHANGELOG.md; then
    red "✗ CHANGELOG.md has no '## [$ver]' heading"
    exit 1
fi
green "✓ CHANGELOG entry present"

# Schema requires id, name, summary, description, version, licence, author,
# category, dependencies. Screenshots are required for stable but not nightly.
for tag in id name summary description version licence author category dependencies; do
    if ! grep -q "<$tag" appinfo/info.xml; then
        red "✗ info.xml missing <$tag>"
        exit 1
    fi
done
green "✓ info.xml required elements present"

if ! grep -q "<screenshot>" appinfo/info.xml; then
    amber "⚠ No <screenshot> entries — fine for nightly, required before promoting to stable"
fi

# Dockerfile sanity — must declare both target platforms.
if ! grep -q "linux/amd64" .github/workflows/release.yml \
    || ! grep -q "linux/arm64" .github/workflows/release.yml; then
    red "✗ release.yml does not build for both amd64 + arm64"
    exit 1
fi
green "✓ Multi-arch build configured"

if [ -n "${SIGNING_KEY:-}" ]; then
    if [ ! -r "$SIGNING_KEY" ]; then
        red "✗ SIGNING_KEY=$SIGNING_KEY not readable"
        exit 1
    fi
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' EXIT
    mkdir -p "$tmpdir/staging/bee_flow" "$tmpdir/dist"
    cp -r appinfo img CHANGELOG.md README.md LICENSE "$tmpdir/staging/bee_flow/"
    tar -czf "$tmpdir/dist/bee_flow.tar.gz" -C "$tmpdir/staging" bee_flow
    openssl dgst -sha512 -sign "$SIGNING_KEY" "$tmpdir/dist/bee_flow.tar.gz" \
        | openssl base64 -A > "$tmpdir/dist/bee_flow.tar.gz.sig"
    size=$(stat -c%s "$tmpdir/dist/bee_flow.tar.gz")
    sig_bytes=$(wc -c < "$tmpdir/dist/bee_flow.tar.gz.sig")
    green "✓ Tarball built: $size bytes"
    green "✓ Signature produced: $sig_bytes base64 bytes"
fi

green ""
green "All pre-flight checks passed for v$ver."
echo  "Next:"
echo  "  git tag v$ver && git push origin v$ver"
