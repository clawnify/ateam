"""A control plane for Modal boxes that runs in the user's own Modal workspace. The prototype behind the
"small app" in docs/providers/modal.md.

    modal deploy docs/providers/modal_control.py

`sleep_box` and `wake_box` run modal_box.py's own sleep and wake inside Modal, so they share its box record
(the Modal Dict `ateam-boxes`). An SDK caller or a scheduled function calls them directly. Everyone else
goes through two private web endpoints that wrap them. Both need a Proxy Token, sent as
`Authorization: Bearer wk-….ws-…` (or as `Modal-Key` and `Modal-Secret` headers). A Proxy Token opens web
endpoints and can't be used as an API token, so the token that can snapshot and restore sandboxes never
leaves Modal:

    POST <wake url>?box=<name>    wake the box if it sleeps; answers "<host> <port>" of its ssh tunnel
    POST <sleep url>?box=<name>   snapshot the box and end it; answers the timings

With it, a box's ssh alias needs no Modal SDK, only curl and nc:

    ProxyCommand sh -c 'set -- $(curl -fsS -X POST -H "Authorization: Bearer $MODAL_PROXY_TOKEN" "<wake url>?box=<name>"); exec nc "$1" "$2"'
"""

import modal

app = modal.App("ateam-control")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi[standard]", "modal==1.6.3")
    .add_local_python_source("modal_box")
)


@app.function(image=image)
def wake_box(box: str) -> str:
    """Wake the box if it sleeps, and answer "<host> <port>" once its sshd does, so a plain `nc` on the
    other side never meets a tunnel with nothing behind it yet."""
    import time

    import modal_box

    sb, _ = modal_box.wake(box)
    tn = sb.tunnels()[22]
    modal_box.connect(tn.unencrypted_host, tn.unencrypted_port, time.time() + 30)[0].close()
    return f"{tn.unencrypted_host} {tn.unencrypted_port}"


@app.function(image=image)
def sleep_box(box: str) -> dict:
    import modal_box

    return modal_box.sleep(box)


@app.function(image=image)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
def wake(box: str):
    from fastapi.responses import PlainTextResponse

    try:
        return PlainTextResponse(wake_box.local(box) + "\n")
    except SystemExit as e:  # modal_box's way of saying there's no such box
        return PlainTextResponse(f"{e}\n", status_code=404)


@app.function(image=image)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
def sleep(box: str):
    from fastapi.responses import PlainTextResponse

    try:
        return sleep_box.local(box)
    except SystemExit as e:
        return PlainTextResponse(f"{e}\n", status_code=404)
