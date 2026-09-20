data "sentry_team" "platform" {
  organization = var.sentry_organization
  slug         = var.platform_team_slug
}

# Reference-only: the repository integration is managed in Sentry, not by this
# stack. Keeping the lookup here makes the connected GitHub organization
# explicit without importing or mutating OSS repository configuration.
data "sentry_organization_integration" "github" {
  organization = var.sentry_organization
  provider_key = "github"
  name         = var.github_organization
}

locals {
  projects = {
    control_plane_lambda = {
      name     = "auto-harness-control-plane-lambda"
      platform = "node-awslambda"
    }
    control_plane_web = {
      name     = "auto-harness-control-plane-web"
      platform = "javascript-nextjs"
    }
    host_plane_backend = {
      name     = "auto-harness-host-plane-backend"
      platform = "node"
    }
    host_plane_web = {
      name     = "auto-harness-host-plane-web"
      platform = "javascript-nextjs"
    }
  }

  environments = toset(["staging", "production"])

  project_environments = {
    for item in flatten([
      for project_key, project in local.projects : [
        for environment in local.environments : {
          key         = "${project_key}_${environment}"
          project_key = project_key
          environment = environment
          project     = project
        }
      ]
    ]) : item.key => item
  }
}

resource "sentry_project" "app" {
  for_each = local.projects

  organization  = var.sentry_organization
  teams         = [data.sentry_team.platform.slug]
  name          = each.value.name
  slug          = each.value.name
  platform      = each.value.platform
  default_key   = false
  default_rules = false

  lifecycle {
    prevent_destroy = true
  }
}

# Keep staging and production keys distinct so DSNs can be rotated or disabled
# independently without recreating projects. Key secrets are never output.
resource "sentry_key" "environment" {
  for_each = local.project_environments

  organization = var.sentry_organization
  project      = sentry_project.app[each.value.project_key].slug
  name         = "${each.value.project.name}-${each.value.environment}"

  lifecycle {
    prevent_destroy = true
  }
}
