#!/bin/sh

# --- Configuration via Environment Variables ---

# API URL (with a default for staging (for now) if not specified)
API_URL="${VIKTOR_API_URL:-https://api.viktor.staging.marmotz.dev}"

# Checking mandatory variables
if [ -z "$VIKTOR_APP_ID" ]; then
    echo "ERROR: The VIKTOR_APP_ID environment variable must be defined."
    exit 1
fi

if [ -z "$VIKTOR_APP_SECRET" ]; then
    echo "ERROR: The VIKTOR_APP_SECRET environment variable must be defined."
    exit 1
fi

if [ -z "$CI_MERGE_REQUEST_IID" ]; then
    echo "ERROR: The CI_MERGE_REQUEST_IID environment variable must be defined (Job launched outside MR?)."
    exit 1
fi


# --- 1. Execute API call ---

echo "Starting semantic analysis for MR #$CI_MERGE_REQUEST_IID on application $VIKTOR_APP_ID..."

RESPONSE=$(curl -s -w "\n%{http_code}\n%{time_total}" \
    --request POST \
    --header "Content-Type: application/json" \
    --data "{ \"appSecret\": \"$VIKTOR_APP_SECRET\", \"mergeRequestId\": \"$CI_MERGE_REQUEST_IID\" }" \
    "$API_URL/semantic-analyze/$VIKTOR_APP_ID")

# --- 2. Processing and Displaying Results ---

BODY=$(echo "$RESPONSE" | sed -n '1p')
STATUS=$(echo "$RESPONSE" | sed -n '2p')
TIME=$(echo "$RESPONSE" | sed -n '3p')
TIME_MS=$(echo "$TIME * 1000" | bc | cut -d'.' -f1)
TOKENS=$(echo "$BODY" | jq -r '.tokensUsed // 0')

echo "--- Results ---"
echo "Response in $TIME_MS ms - $TOKENS token(s) used"

if [ "$STATUS" -eq 200 ]; then
    MESSAGE=$(echo "$BODY" | jq -r '.message')
    echo "✅ OK: $MESSAGE"
    exit 0
elif [ "$STATUS" -eq 204 ]; then
    echo "⚠️ SKIPPED"
    exit 0 # Success (skipped)
else
    ERROR_MESSAGE=$(echo "$BODY" | jq -r '.message')
    echo "❌ Analysis failed (Status $STATUS): $ERROR_MESSAGE"
    # Adding error detail for debugging
    # echo "Full response body: $BODY"
    exit 1 # Job failure
fi