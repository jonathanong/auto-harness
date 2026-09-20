terraform {
  required_version = ">= 1.8.0"

  # The bucket, key, locking, and credentials are deliberately supplied by the
  # operator with `tofu init -backend-config=...`; this stack never invents a
  # state location.
  backend "s3" {}

  required_providers {
    sentry = {
      source  = "jianyuan/sentry"
      version = "= 0.15.7"
    }
  }
}

provider "sentry" {}
