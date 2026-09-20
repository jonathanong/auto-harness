variable "sentry_organization" {
  type        = string
  description = "Existing Sentry organization slug."
  default     = "vouchington"
}

variable "platform_team_slug" {
  type        = string
  description = "Existing Sentry team slug that owns these projects."
  default     = "platform"
}

variable "github_organization" {
  type        = string
  description = "Existing GitHub organization name used to look up the connected Sentry integration."
  default     = "jonathanong"
}
