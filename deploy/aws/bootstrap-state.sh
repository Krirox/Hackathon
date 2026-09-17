#!/usr/bin/env sh
# One-time remote-state bootstrap (F22): creates the versioned, encrypted
# state bucket + lock table, then prints the exact init command. Needs AWS
# credentials in the environment (SSO or env vars) — nothing here runs
# without them, by design. Safe to re-run (create calls tolerate existing
# resources only where AWS makes them idempotent — see notes).
set -eu
REGION="${AWS_REGION:-eu-central-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="vital-tfstate-${ACCOUNT}"
TABLE="vital-tfstate-locks"

if [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null || true
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=${REGION}" 2>/dev/null || true
fi
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws dynamodb create-table --table-name "$TABLE" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region "$REGION" 2>/dev/null || true

cat <<EOF
State backend ready. Uncomment the backend block in main.tf, then:
  terraform init -backend-config="bucket=${BUCKET}" \\
    -backend-config="key=vital/terraform.tfstate" \\
    -backend-config="region=${REGION}" \\
    -backend-config="encrypt=true" \\
    -backend-config="dynamodb_table=${TABLE}"
Then `terraform plan` must show no changes (state import of existing
resources is a separate, deliberate step — never let init create seconds).
EOF
