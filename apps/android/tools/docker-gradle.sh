#!/usr/bin/env bash
# Run Gradle inside the JDK 21 + Android SDK 37 image (no local JDK/SDK needed).
# Reuses upstream's checksum-verified image definition.
# Usage: tools/docker-gradle.sh [gradle args]   (default: :app:assembleDebug testDebugUnitTest)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="baliza-android-dev:21.0.11"
GRADLE_HOME="$PROJECT_ROOT/.gradle-docker-home"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: Docker is required" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- :app:assembleDebug testDebugUnitTest
fi

mkdir -p "$GRADLE_HOME"

docker build \
  --platform linux/amd64 \
  --file "$SCRIPT_DIR/reproducible-builds/Dockerfile" \
  --tag "$IMAGE_NAME" \
  "$PROJECT_ROOT"

docker run \
  --rm \
  --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --env GRADLE_USER_HOME=/gradle-home \
  --env HOME=/tmp/build-home \
  --volume "$PROJECT_ROOT:/workspace" \
  --volume "$GRADLE_HOME:/gradle-home" \
  --entrypoint ./gradlew \
  "$IMAGE_NAME" \
  "$@"
