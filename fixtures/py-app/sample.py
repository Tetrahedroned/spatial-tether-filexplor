"""Sample Python module for fixture tests."""

DEFAULT_TIMEOUT = 30
_INTERNAL_BUFFER = 1024


def public_helper(x: int) -> int:
    return x * 2


def _private_helper(x: int) -> int:
    return x + 1


class Connection:
    """A toy connection class with a method and a class-level constant."""

    DEFAULT_PORT = 5432

    def __init__(self, host: str) -> None:
        self.host = host

    def query(self, sql: str) -> str:
        return f"executing on {self.host}: {sql}"

    def _close(self) -> None:
        pass
