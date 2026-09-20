# ------------------------------------------------------------------ cognito --
# Production identity for the public sign-up funnel (src/console/cognito.ts).
# The console calls SignUp/InitiateAuth server-side with the ECS task role
# (SigV4, no SDK, no client secret); the ALB and the app's own session cookie
# are unchanged. Local dev and self-hosted runs never see any of this — the
# integration is env-gated and off unless VITAL_COGNITO_* is set.

resource "aws_cognito_user_pool" "public" {
  name                     = "${local.name}-public"
  username_attributes      = ["email"]
  auto_verified_attribute_names = ["email"]
  mfa_configuration        = "OFF"

  # Mirrors MIN_PASSWORD_LENGTH in src/core/auth.ts (12) so the pool never
  # accepts what the console would reject, or vice versa.
  password_policy {
    minimum_length    = 12
    require_uppercase = true
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
  }

  policies {
    # The funnel signs users up through the SignUp API. With this true the
    # API refuses every non-admin call outright, so it must be false; the
    # hosted self-service UI stays unused (no domain is attached).
    allow_admin_create_user_only = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "EMAIL_ONLY"
      priority = 1
    }
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  tags = { Project = var.project }
}

resource "aws_cognito_user_pool_client" "funnel" {
  name         = "${local.name}-funnel"
  user_pool_id = aws_cognito_user_pool.public.id

  # Server-side caller: no secret to hide, password auth flow only.
  generate_secret = false
  explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  # Uniform "user doesn't exist" answers instead of enumeration signals.
  prevent_user_existence_errors = "ENABLED"

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  tags = { Project = var.project }
}
