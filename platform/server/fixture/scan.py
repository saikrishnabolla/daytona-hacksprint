"""Run a scoped OWASP ZAP active scan against the locally-running owned target.

The app and ZAP share one Daytona sandbox, so the scan targets http://127.0.0.1:<port>.

Environment:
  OWNED_TARGET_URL    required, the owned target base URL (usually http://127.0.0.1:3000)
  OWNED_TARGET_HOST   required, the host the target URL must resolve to
  ZAP_SCAN_SEEDS      comma-separated paths to seed ZAP with (default /)
  ZAP_SCAN_INCLUDE    regex of in-scope URLs (default: any path)
  ZAP_SCAN_RULES      comma-separated active-scan rule ids (default 40012)
  ZAP_SCAN_SECONDS    hard ceiling for the active scan in seconds (default 180)
  OWNED_LOGIN_PATH    optional, path of the login form for authenticated scanning
  OWNED_LOGIN_REQUEST optional, e.g. email={%username%}&password={%password%}
  OWNED_LOGIN_USER    optional, username for the authenticated scan
  OWNED_LOGIN_PASS    optional, password for the authenticated scan
  OWNED_LOGIN_INDICATOR optional, regex that appears only when logged in
"""
import http.cookiejar
import json
import os
import re
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urljoin, urlparse
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

BASE = "http://127.0.0.1:8080/JSON/"
TARGET = os.environ["OWNED_TARGET_URL"].rstrip("/")
EXPECTED_HOST = os.environ["OWNED_TARGET_HOST"]
if urlparse(TARGET).hostname != EXPECTED_HOST:
    raise RuntimeError("Target is outside the provisioned sandbox scope")

SEEDS = [s for s in os.environ.get("ZAP_SCAN_SEEDS", "/").split(",") if s]
INCLUDE = os.environ.get("ZAP_SCAN_INCLUDE", "/.*")
RULES = [rule.strip() for rule in os.environ.get("ZAP_SCAN_RULES", "40012").split(",") if rule.strip()]
MAX_SECONDS = int(os.environ.get("ZAP_SCAN_SECONDS", "180"))
LOGIN_PATH = os.environ.get("OWNED_LOGIN_PATH", "")
LOGIN_REQUEST = os.environ.get("OWNED_LOGIN_REQUEST", "")
LOGIN_USER = os.environ.get("OWNED_LOGIN_USER", "")
LOGIN_PASS = os.environ.get("OWNED_LOGIN_PASS", "")
LOGIN_INDICATOR = os.environ.get("OWNED_LOGIN_INDICATOR", "")
CONTEXT = "owned-target"
opener = build_opener(ProxyHandler({}))


def api(component, kind, action, **params):
    url = BASE + component + "/" + kind + "/" + action + "/?" + urlencode(params)
    try:
        with opener.open(url, timeout=30) as response:
            data = json.loads(response.read())
    except HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError("ZAP API error " + str(error.code) + ": " + detail[:400])
    if "code" in data and data.get("code") not in ("ok",):
        raise RuntimeError("ZAP API error: " + str(data))
    return data


def authenticate():
    """Log in over HTTP, returning a Cookie header the scanner and seeds can reuse."""
    jar = http.cookiejar.CookieJar()
    login_opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(jar))
    body = LOGIN_REQUEST.replace("{%username%}", LOGIN_USER).replace("{%password%}", LOGIN_PASS).encode()
    request = Request(
        urljoin(TARGET + "/", LOGIN_PATH.lstrip("/")),
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html"},
    )
    with login_opener.open(request, timeout=20) as response:
        page = response.read().decode("utf-8", "replace")
    cookies = "; ".join(cookie.name + "=" + cookie.value for cookie in jar)
    if not cookies:
        raise RuntimeError("login did not return a session cookie")
    # Confirm the session actually reaches the authenticated area.
    check = Request(urljoin(TARGET + "/", "dashboard"), headers={"Cookie": cookies, "Accept": "text/html"})
    with login_opener.open(check, timeout=20) as response:
        dash = response.read().decode("utf-8", "replace")
    if "Sign out" not in dash and "Sign out" not in page:
        raise RuntimeError("login succeeded but the dashboard did not look authenticated")
    return cookies


def seed(path, cookie=""):
    url = urljoin(TARGET + "/", path.lstrip("/"))
    parsed = urlparse(url)
    target = parsed.path + (("?" + parsed.query) if parsed.query else "")
    headers = "Host: " + parsed.netloc + "\r\nAccept: text/html\r\n"
    if cookie:
        headers += "Cookie: " + cookie + "\r\n"
    raw = "GET " + target + " HTTP/1.1\r\n" + headers + "Connection: close\r\n\r\n"
    api("core", "action", "sendRequest", request=raw)
    return url


# 1. Wait for the ZAP daemon.
version = None
for _ in range(120):
    try:
        version = api("core", "view", "version")["version"]
        break
    except Exception:
        time.sleep(1)
if version is None:
    raise RuntimeError("ZAP daemon did not become ready")
print("ZAP " + version + " ready", flush=True)

api("core", "action", "newSession", name="owned-run", overwrite="true")
api("ascan", "action", "disableAllScanners")
api("ascan", "action", "enableScanners", ids=",".join(RULES))

# 2. Context + scope.
context_id = api("context", "action", "newContext", contextName=CONTEXT)["contextId"]
api("context", "action", "includeInContext", contextName=CONTEXT, regex=re.escape(TARGET) + INCLUDE)
api("context", "action", "setContextInScope", contextName=CONTEXT, booleanInScope="true")

# 3. Log in and register a ZAP user so the active scan reaches authenticated areas.
session_cookie = ""
authenticated = False
if LOGIN_PATH and LOGIN_REQUEST and LOGIN_USER:
    try:
        session_cookie = authenticate()
        print("Logged in over HTTP; session cookie acquired", flush=True)
    except Exception as error:
        print("HTTP login failed: " + str(error), flush=True)
    def auth_step(label, action):
        try:
            result = action()
            print("Auth: " + label + " ok", flush=True)
            return result
        except Exception as error:
            print("Auth: " + label + " failed: " + str(error), flush=True)
            raise

    try:
        auth_config = "loginUrl=" + urljoin(TARGET + "/", LOGIN_PATH.lstrip("/")) + "&loginRequestData=" + quote(LOGIN_REQUEST, safe="")
        auth_step("method", lambda: api("authentication", "action", "setAuthenticationMethod", contextId=context_id, authMethodName="formBasedAuthentication", authMethodConfigParams=auth_config))
        if LOGIN_INDICATOR:
            auth_step("indicator", lambda: api("authentication", "action", "setLoggedInIndicator", contextId=context_id, loggedInIndicatorRegex=re.escape(LOGIN_INDICATOR)))
        authenticated = True
        print("Configured form-based authentication for " + LOGIN_USER + " (cookie-seeded scan)", flush=True)
    except Exception as error:
        print("Authentication framework setup skipped: " + str(error), flush=True)

# 4. Seed the target URLs into the Sites tree (with the session cookie when available).
for path in ["/"] + SEEDS:
    try:
        seed(path, session_cookie)
    except Exception as error:
        print("Seed failed for " + path + ": " + str(error), flush=True)
known = api("core", "view", "urls", baseurl=TARGET).get("urls", [])
print("Seeded; ZAP now knows " + str(len(known)) + " url(s)", flush=True)

# 5. Spider first so logged-in pages we did not seed land in the tree.
try:
    spider_id = api("spider", "action", "scan", url=TARGET + "/", contextName=CONTEXT, recurse="true", maxChildren="10")["scan"]
    deadline = time.time() + 75
    while time.time() < deadline:
        if int(api("spider", "view", "status", scanId=spider_id)["status"]) >= 100:
            break
        time.sleep(1)
    known = api("core", "view", "urls", baseurl=TARGET).get("urls", [])
    print("Spider complete; ZAP now knows " + str(len(known)) + " url(s)", flush=True)
except Exception as error:
    print("Spider skipped: " + str(error), flush=True)

# 6. Active scan every in-scope URL under the target.
scan_id = api("ascan", "action", "scan", url=TARGET + "/", recurse="true", inScopeOnly="true", contextId=context_id)["scan"]
print("Active scan " + str(scan_id) + " started; rules " + ",".join(RULES) + "; scope " + INCLUDE, flush=True)
deadline = time.time() + MAX_SECONDS
while time.time() < deadline:
    if int(api("ascan", "view", "status", scanId=scan_id)["status"]) == 100:
        break
    time.sleep(2)
else:
    api("ascan", "action", "stop", scanId=scan_id)
    print("Active scan hit the " + str(MAX_SECONDS) + "s ceiling; collecting partial results", flush=True)

alerts = api("core", "view", "alerts", baseurl=TARGET, start=0, count=200)["alerts"]
for alert in alerts:
    if urlparse(alert.get("url", "")).hostname != EXPECTED_HOST:
        raise RuntimeError("ZAP returned an alert outside the owned scope")
    message_id = alert.get("messageId")
    if message_id:
        alert["message"] = api("core", "view", "message", id=message_id).get("message", {})

report = {"scanner": "OWASP ZAP", "version": version, "scanId": scan_id, "ruleIds": RULES, "authenticated": authenticated, "target": TARGET, "seeds": SEEDS, "completed": True, "alerts": alerts}
with open("/tmp/owned-zap-report.json", "w") as output:
    json.dump(report, output)
top = sorted({str(alert.get("pluginId")) for alert in alerts})
print("Scan complete: " + str(len(alerts)) + " alerts; rule ids " + (",".join(top) or "none"), flush=True)
