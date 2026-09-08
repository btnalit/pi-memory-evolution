#!/usr/bin/env bash
set -euo pipefail
# Pinned tool and checksum; never execute an unverified curl|sh installer.
version=1.7.12
checksum=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --location --retry 2 --max-time 60 \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz" \
  --output "$work/actionlint.tar.gz"
printf '%s  %s\n' "$checksum" "$work/actionlint.tar.gz" | sha256sum --check --status
tar -xzf "$work/actionlint.tar.gz" -C "$work" actionlint
"$work/actionlint" -color
