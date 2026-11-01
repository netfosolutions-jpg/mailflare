#!/usr/bin/env bash
# Bootstrap Mailflare on a fresh Ubuntu 24.04 EC2 instance. Safe to rerun.
#   FORK_URL=https://github.com/you/mailflare.git sudo -E bash bootstrap.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo -E bash bootstrap.sh)." >&2
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 git
systemctl enable --now docker
if id ubuntu >/dev/null 2>&1; then
  usermod -aG docker ubuntu
fi

if [ ! -d /opt/mailflare/.git ]; then
  git clone --branch storage-cap "${FORK_URL:?set FORK_URL to the git URL of your fork}" /opt/mailflare
fi

cd /opt/mailflare/deploy/aws

if [ ! -f .env.aws ]; then
  cp .env.aws.example .env.aws
  chmod 600 .env.aws
  echo "Created /opt/mailflare/deploy/aws/.env.aws. Edit it (S3 and SES values), then rerun this script." >&2
  exit 1
fi

docker compose -f docker-compose.aws.yml up -d --build
