"""Typed provider errors exposed through the data-plane API."""


class SandboxImageUnavailableError(RuntimeError):
    """The requested image was confirmed missing during image resolution."""
