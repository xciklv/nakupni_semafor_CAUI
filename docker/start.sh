#!/bin/sh
# Spouštěcí skript kontejneru: sestaví workflow, vytvoří credential z ANTHROPIC_API_KEY, naimportuje a zapne obě workflow a spustí n8n.
set -eu
cd /opt/semafor

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Chybí ANTHROPIC_API_KEY. Zkopírujte .env.example na .env a vyplňte klíč." >&2
  exit 1
fi

# Pevné ID credentialu, na které míří sestavená workflow. Klíč se do souboru zapisuje jen dočasně.
export ANTHROPIC_CRED_ID="${ANTHROPIC_CRED_ID:-nakupniSemaforKey}"
export ANTHROPIC_CRED_NAME="Anthropic"

node build/build-workflow.js

node -e '
const fs = require("fs");
fs.writeFileSync("/tmp/semafor-credential.json", JSON.stringify([{
  id: process.env.ANTHROPIC_CRED_ID, name: process.env.ANTHROPIC_CRED_NAME, type: "anthropicApi",
  data: { apiKey: process.env.ANTHROPIC_API_KEY, url: "https://api.anthropic.com", header: false },
}]), { mode: 0o600 });
'
n8n import:credentials --input=/tmp/semafor-credential.json
rm -f /tmp/semafor-credential.json

n8n import:workflow --input=workflow.json
n8n import:workflow --input=workflow-web.json

API_ID=$(node -p 'require("./build/build-workflow").WORKFLOW_API.id')
WEB_ID=$(node -p 'require("./build/build-workflow").WORKFLOW_WEB.id')
n8n publish:workflow --id="$WEB_ID"
n8n publish:workflow --id="$API_ID"

exec n8n start
