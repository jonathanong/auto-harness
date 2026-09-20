output "public_dsn_by_environment" {
  description = "Public DSNs grouped by deployment environment and exact Sentry project name."
  value = {
    for environment in local.environments : environment => {
      for project_key, project in local.projects : project.name => nonsensitive(sentry_key.environment["${project_key}_${environment}"].dsn["public"])
    }
  }
}

output "github_integration_id" {
  description = "Reference-only ID of the existing jonathanong GitHub Sentry integration."
  value       = data.sentry_organization_integration.github.id
}

output "platform_team_slug" {
  description = "Reference-only slug of the existing platform team."
  value       = data.sentry_team.platform.slug
}
