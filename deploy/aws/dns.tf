# ------------------------------------------------------ domain + certificate ----
# Optional, and entirely driven by var.domain_name. With it empty everything
# here plans to nothing, so a stack that has never set a domain produces the
# same plan it did before this file existed.
#
# Two routes to HTTPS, and they compose:
#   var.domain_name         -> this file creates the ACM certificate and the DNS
#   var.acm_certificate_arn -> a certificate you already own (another account,
#                              another region, or a hand-validated one)
# An explicit acm_certificate_arn wins if both are set; the DNS records below
# are still created, since naming the host and holding the certificate are
# independent decisions.
#
# The hosted zone is *looked up*, never created (data.aws_route53_zone). An apply
# therefore cannot take over a domain's DNS, and records in that zone this stack
# does not manage are never touched.
#
# Region matters: an ALB can only present a certificate from its own region, so
# the cert is created in var.region (eu-central-1 by default). Only add a
# us-east-1 certificate if CloudFront is introduced in front of the ALB.

locals {
  dns_enabled = var.domain_name != "" ? 1 : 0

  # Every name on the certificate. Derived from the *variables*, never from
  # aws_acm_certificate.domain_validation_options: that attribute is unknown
  # until the certificate exists, and for_each keys must be known at plan time —
  # building the map from it fails the first apply with "keys cannot be
  # determined until apply". The record values below are read from the resource
  # per name instead.
  certificate_domains = distinct(concat([var.domain_name], var.subject_alternative_names))

  # One flag owns "do we serve HTTPS", so the HTTP listener, the HTTPS listener
  # and the Buzz host rule can never disagree about which listener exists. It
  # reads variables only, which keeps it known at plan time — required, because
  # it drives `count`.
  tls_enabled = var.acm_certificate_arn != "" || var.domain_name != "" ? 1 : 0

  # The ARN the HTTPS listener presents. `one()` (not [0]) so the empty case
  # yields null instead of an index error while the listener plans to zero.
  certificate_arn = var.acm_certificate_arn != "" ? var.acm_certificate_arn : one(aws_acm_certificate.console[*].arn)
}

data "aws_route53_zone" "main" {
  count        = local.dns_enabled
  zone_id      = var.hosted_zone_id
  private_zone = false
}

resource "aws_acm_certificate" "console" {
  count                     = local.dns_enabled
  domain_name               = var.domain_name
  subject_alternative_names = var.subject_alternative_names
  validation_method         = "DNS"

  # An ALB holds one certificate, so a rename would otherwise fail on the
  # in-use certificate: create the replacement before destroying the old one.
  lifecycle { create_before_destroy = true }

  tags = { Name = "${local.name}-cert" }
}

# One validation record per name on the certificate, keyed by the name (not by
# index) so adding a SAN later does not rewrite the records that already
# validated. ACM hands back one option per name; the three lookups below pick
# the one matching this record's key.
#
# Every record is written to the single zone looked up above, which is why all
# subject_alternative_names must live in that zone.
resource "aws_route53_record" "cert_validation" {
  for_each = toset(local.dns_enabled == 1 ? local.certificate_domains : [])

  zone_id = data.aws_route53_zone.main[0].zone_id
  name = one([
    for dvo in aws_acm_certificate.console[0].domain_validation_options :
    dvo.resource_record_name if dvo.domain_name == each.value
  ])
  type = one([
    for dvo in aws_acm_certificate.console[0].domain_validation_options :
    dvo.resource_record_type if dvo.domain_name == each.value
  ])
  records = [one([
    for dvo in aws_acm_certificate.console[0].domain_validation_options :
    dvo.resource_record_value if dvo.domain_name == each.value
  ])]
  ttl             = 60
  allow_overwrite = true
}

# Blocks until ACM has actually seen the records. The HTTPS listener depends on
# this, because an ALB cannot attach a certificate that is still PENDING_VALIDATION
# — without the dependency the first apply fails on a usable-looking plan.
resource "aws_acm_certificate_validation" "console" {
  count                   = local.dns_enabled
  certificate_arn         = aws_acm_certificate.console[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# Alias, not CNAME: it is legal at the apex (where a CNAME is not), it is free to
# query, and it follows the ALB if AWS changes its addresses.
resource "aws_route53_record" "console" {
  count   = local.dns_enabled
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

# No AAAA record on purpose: the ALB here is IPv4-only (no ip_address_type =
# "dualstack"), and an AAAA alias pointing at a single-stack ALB answers with
# nothing. Add both the ALB attribute and the record together, or neither.
