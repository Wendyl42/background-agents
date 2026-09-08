# External, self-hosted OpenSandbox. This configuration does not provision its host.
variable "opensandbox_api_url" {
  description = "OpenSandbox server origin reachable from the control-plane Worker, without /v1."
  type        = string
  default     = ""
  validation {
    condition     = var.sandbox_provider != "opensandbox" || can(regex("^https://[^/]+/?$", var.opensandbox_api_url))
    error_message = "opensandbox_api_url must be an HTTPS origin when sandbox_provider = 'opensandbox'."
  }
}

variable "opensandbox_api_key" {
  description = "API key for the external OpenSandbox server."
  type        = string
  sensitive   = true
  default     = ""
  validation {
    condition     = var.sandbox_provider != "opensandbox" || length(trimspace(var.opensandbox_api_key)) > 0
    error_message = "opensandbox_api_key is required for OpenSandbox."
  }
}

variable "opensandbox_image" {
  description = "Image available on the OpenSandbox Docker host, containing OpenInspect runtime."
  type        = string
  default     = ""
  validation {
    condition     = var.sandbox_provider != "opensandbox" || length(trimspace(var.opensandbox_image)) > 0
    error_message = "opensandbox_image is required for OpenSandbox."
  }
}
