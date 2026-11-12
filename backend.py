"""Backend entrypoint: google-ads-mcp over streamable HTTP on loopback.

server.js spawns this and fronts it with the OAuth 2.1 proxy. Upstream's own
entrypoint (`google-ads-mcp`, ads_mcp.server:run_server) only serves HTTP when
GOOGLE_ADS_MCP_OAUTH_CLIENT_ID/_SECRET are set, and then puts FastMCP's own
Google OAuth in front of /mcp, which clashes with the proxy. So this runs the
same `mcp` object over plain HTTP, bound to 127.0.0.1 only.

Google auth is Application Default Credentials only: GOOGLE_APPLICATION_CREDENTIALS
pointing at an `authorized_user` file mounted read-only. Nothing here reads it
at startup; google.auth.default() runs lazily on the first tool call.
"""

import asyncio
import os
import sys

# Upstream switches to FastMCP's Google OAuth when both of these are set, and
# coordinator.py reads them at import time. server.js already strips them from
# the child environment; this is the second fence, before any ads_mcp import.
for _var in (
    "GOOGLE_ADS_MCP_OAUTH_CLIENT_ID",
    "GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET",
    "GOOGLE_ADS_MCP_JWT_SIGNING_KEY",
):
    os.environ.pop(_var, None)

# The read-only tools_config.yaml shipped in the image. An explicit path makes
# ads_mcp.config raise if it is missing, instead of falling back to the bundled
# default that enables the write tools.
os.environ.setdefault(
    "GOOGLE_ADS_MCP_TOOLS_CONFIG",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools_config.yaml"),
)
os.environ.setdefault("FASTMCP_CHECK_FOR_UPDATES", "off")

from starlette.requests import Request  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402

# Importing ads_mcp.server mounts the tools (coordinator.py) and registers the
# resources (discovery, metrics, release_notes, segments).
from ads_mcp.server import mcp  # noqa: E402

READ_ONLY_TOOLS = {"list_accessible_customers", "search", "get_resource_metadata"}


async def _assert_read_only() -> None:
    names = {t.name for t in await mcp.list_tools()}
    if names != READ_ONLY_TOOLS:
        print(
            f"[backend] refusing to start: tool set {sorted(names)} "
            f"!= read-only allowlist {sorted(READ_ONLY_TOOLS)}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)


@mcp.custom_route("/health", methods=["GET"])
async def health(_request: Request) -> JSONResponse:
    return JSONResponse({"status": "healthy"})


def main() -> None:
    asyncio.run(_assert_read_only())
    mcp.run(
        transport="streamable-http",
        host="127.0.0.1",
        port=int(os.environ.get("BACKEND_PORT", "8080")),
        path="/mcp",
        # The proxy opens a short-lived exchange per call; stateless means the
        # backend keeps no session map that could grow without bound.
        stateless_http=True,
        show_banner=False,
        uvicorn_config={"access_log": False},
    )


if __name__ == "__main__":
    main()
