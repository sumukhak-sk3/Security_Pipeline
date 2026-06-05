#!/usr/bin/env python3
"""
NIOS SBOM Pipeline v3 — Jenkins-Ready + Findings Export
1. Fetches YAML SBOMs
2. Converts to CycloneDX 1.4
3. Uploads to Dependency-Track
4. (Optional) Waits for enrichment and downloads vulnerability findings as JSON

Usage:
  python3 Dependency_Track_Final_2.py \
    --sbom-url "http://build-storage.inca.infoblox.com/.../sbom-.../" \
    --dtrack-url "http://54.215.67.129:8081" \
    --dtrack-api-key "YOUR_KEY" \
    --output-findings-json "vulns.json" \
    --wait-minutes 40
"""

import argparse
import base64
import csv
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML not installed. Run: pip install pyyaml")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("ERROR: requests not installed. Run: pip install requests")
    sys.exit(1)

from html.parser import HTMLParser

# =============================================================================
# CONSTANTS
# =============================================================================
CYCLONEDX_SPEC_VERSION = "1.5"
BOM_FORMAT = "CycloneDX"

TYPE_TO_PURL = {
    "deb": "deb", "debian": "deb", "rpm": "rpm", "apk": "apk",
    "gem": "gem", "pip": "pypi", "python": "pypi",
    "go": "golang", "go-module": "golang",
    "npm": "npm", "java-archive": "maven", "jar": "maven",
}
OS_TO_DISTRO = {
    "Ubuntu": "ubuntu", "Alpine": "alpine", "Debian": "debian",
    "CentOS": "centos", "RedHat": "redhat",
}
MONTH_MAP = {
    "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
    "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
    "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
}

# =============================================================================
# BUILD INFO EXTRACTOR
# =============================================================================
def extract_build_info(url):
    match = re.search(
        r'NIOS_(\d+\.\d+\.\d+)_(\d+)_([a-f0-9]+)_(\d{4})-(\d{2})-(\d{2})', url
    )
    if match:
        ver, build, commit, yr, mo, dy = match.groups()
        date_str = f"{int(dy):02d}-{MONTH_MAP.get(mo, mo)}-{yr}"
        return {
            "nios_version": ver, "build_number": build, "commit": commit,
            "date_str": date_str,
            "project_name": f"NIOS_{build}",
            "project_version": f"{ver}_{build}_{date_str}",
        }
    return None

# =============================================================================
# HTML DIRECTORY PARSER
# =============================================================================
class BuildStorageIndexParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self._in_a = False
        self._href = None

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            for k, v in attrs:
                if k == "href":
                    self._href = v
                    self._in_a = True

    def handle_endtag(self, tag):
        if tag == "a":
            self._in_a = False
            self._href = None

    def handle_data(self, data):
        if self._in_a and self._href:
            if self._href.endswith((".yaml", ".yml")):
                self.links.append(self._href)
            elif self._href.endswith("/") and not self._href.startswith(("?", "/")):
                self.links.append(self._href)

# =============================================================================
# FILE DISCOVERY (with multithreaded YAML download)
# =============================================================================
def discover_and_group_yaml_urls(base_url, session):
    grouped = {}
    if not base_url.endswith("/"):
        base_url += "/"
    try:
        resp = session.get(base_url, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f" WARNING: Cannot access {base_url}: {e}")
        return grouped

    parser = BuildStorageIndexParser()
    parser.feed(resp.text)

    for link in parser.links:
        full_url = base_url + link
        if link.endswith((".yaml", ".yml")):
            group = _guess_group(link)
            grouped.setdefault(group, []).append(full_url)
        elif link.endswith("/") and not link.startswith(("?", "/", "..")):
            group = link.rstrip("/")
            subs = _find_yamls(full_url, session)
            if subs:
                grouped.setdefault(group, []).extend(subs)
    return grouped

def discover_and_group_yaml_files(sbom_dir):
    grouped = {}
    for yf in Path(sbom_dir).rglob("*.yaml"):
        parts = yf.relative_to(sbom_dir).parts
        group = parts[0] if len(parts) > 1 else _guess_group(yf.name)
        grouped.setdefault(group, []).append(str(yf))
    return grouped

def _find_yamls(url, session):
    urls = []
    try:
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
    except requests.RequestException:
        return urls
    p = BuildStorageIndexParser()
    p.feed(resp.text)
    for link in p.links:
        full = url + link
        if link.endswith((".yaml", ".yml")):
            urls.append(full)
        elif link.endswith("/") and not link.startswith(("?", "/", "..")):
            urls.extend(_find_yamls(full, session))
    return urls

def _guess_group(fn):
    fn = fn.lower()
    for key, group in [
        ("nios-", "nios"), ("ibra", "splunk"), ("splunk", "splunk"),
        ("swatp", "suricata"), ("suricata", "suricata"),
        ("dpdk", "6windgate"), ("6wind", "6windgate"),
        ("alpine", "alpine"), ("cloud", "cloud_discovery"),
        ("discovery", "cloud_discovery"), ("grpc", "grpc"),
        ("heka", "docker_images"), ("scout", "docker_images"),
        ("noa", "docker_images"), ("ti_", "threat_insight"),
        ("threat", "threat_insight"), ("postgres", "postgres"),
        ("lgui", "lwg"), ("aslan", "lwg"), ("lwg", "lwg"),
        ("webui", "webui"), ("netmri", "netmri_ni"), ("ni-", "netmri_ni"),
    ]:
        if key in fn:
            if key == "nios-" and "grpc" in fn:
                continue
            return group
    return "other"

# =============================================================================
# MULTITHREADED YAML FETCHER
# =============================================================================
def fetch_yaml_content(url, session):
    """Fetch a single YAML file — used by ThreadPoolExecutor."""
    try:
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
        return url, resp.text, None
    except requests.RequestException as e:
        return url, None, str(e)

def fetch_all_yamls_parallel(grouped_files, session, max_workers=10):
    """Fetch all YAML files in parallel using threads."""
    all_urls = []
    for group, urls in grouped_files.items():
        for url in urls:
            all_urls.append((group, url))

    results = {}  # {group: [(source_name, content), ...]}
    total = len(all_urls)
    done = 0

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_info = {}
        for group, url in all_urls:
            future = executor.submit(fetch_yaml_content, url, session)
            future_to_info[future] = (group, url)

        for future in as_completed(future_to_info):
            group, url = future_to_info[future]
            url_result, content, error = future.result()
            done += 1

            if error:
                print(f" WARNING: Cannot download {url.split('/')[-1]}: {error}")
                continue

            source_name = url.split("/")[-1]
            if group not in results:
                results[group] = []
            results[group].append((source_name, content))

            if done % 5 == 0 or done == total:
                print(f" Downloaded {done}/{total} YAML files...")

    return results

# =============================================================================
# YAML PARSER
# =============================================================================
def parse_nios_yaml(content, source="unknown"):
    deps = []
    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError as e:
        print(f" WARNING: YAML parse error in {source}: {e}")
        return deps
    if not data or not isinstance(data, dict):
        return deps
    for key, dtype in [("referenced-dependencies", "referenced"),
                       ("vendored-dependencies", "vendored")]:
        for dep in (data.get(key) or []):
            if isinstance(dep, dict) and dep.get("name"):
                dep["_dep_type"] = dtype
                dep["_source"] = source
                deps.append(dep)
    return deps


def infer_package_type(dep):
    pkg_type = str(dep.get("type", "")).strip().lower()
    if pkg_type and pkg_type != "unknown":
        return pkg_type

    path_value = dep.get("path", "")
    if isinstance(path_value, list):
        path_value = " ".join(str(item) for item in path_value)
    path_value = str(path_value).lower()

    if path_value.endswith(".deb"):
        return "deb"
    if path_value.endswith(".rpm"):
        return "rpm"
    if path_value.endswith(".apk"):
        return "apk"

    if any(path_value.endswith(ext) for ext in (".whl", ".tar.gz", ".tgz", ".zip")):
        if "python" in path_value or str(dep.get("name", "")).lower().startswith(("py", "python-")):
            return "python"

    return pkg_type or "unknown"

# =============================================================================
# PURL GENERATOR
# =============================================================================
def generate_purl(dep):
    name = dep.get("name", "").strip()
    version = str(dep.get("version", "")).strip().strip('"')
    pkg_type = infer_package_type(dep)
    os_name = str(dep.get("os", "")).strip()
    os_ver = str(dep.get("osVersion", "")).strip().strip('"')
    arch = str(dep.get("arch", dep.get("architecture", ""))).strip()

    if not name:
        return None

    purl_type = TYPE_TO_PURL.get(pkg_type, "generic")
    ns = ""
    quals = {}

    if purl_type == "deb":
        ns = OS_TO_DISTRO.get(os_name, "ubuntu")
        if arch and arch != "<no value>":
            quals["arch"] = arch
        if os_name and os_ver:
            quals["distro"] = f"{OS_TO_DISTRO.get(os_name, os_name.lower())}-{os_ver}"
    elif purl_type == "apk":
        ns = OS_TO_DISTRO.get(os_name, "alpine")
        if arch and arch != "<no value>":
            quals["arch"] = arch
    elif purl_type == "rpm":
        ns = OS_TO_DISTRO.get(os_name, "linux")
        if arch and arch != "<no value>":
            quals["arch"] = arch

    pn = name.lower().replace(" ", "-")
    if purl_type == "pypi":
        pn = re.sub(r"[-_.]+", "-", pn)
    pv = version.replace(":", "%3A") if version and ":" in version else version

    purl = f"pkg:{purl_type}/{ns}/{pn}" if ns else f"pkg:{purl_type}/{pn}"
    if pv and pv not in ("UNKNOWN", "<no value>", "None", ""):
        purl += f"@{pv}"
    if quals:
        purl += "?" + "&".join(f"{k}={v}" for k, v in sorted(quals.items()))
    return purl

# =============================================================================
# CYCLONEDX 1.4 CONVERTER
# =============================================================================
def convert_to_cyclonedx(component_deps, project_name, project_version):
    components = []
    seen = set()

    for group, deps in sorted(component_deps.items()):
        for dep in deps:
            name = dep.get("name", "").strip()
            version = str(dep.get("version", "")).strip().strip('"')
            if not name:
                continue
            if version in ("UNKNOWN", "<no value>", "None", ""):
                version = "0.0.0-unknown"

            purl = generate_purl(dep)
            key = f"{group}:{purl}" if purl else f"{group}:{name}@{version}"
            if key in seen:
                continue
            seen.add(key)

            comp = {
                "type": "library", "group": group,
                "name": name, "version": version,
                "bom-ref": str(uuid.uuid4()),
            }
            if purl:
                comp["purl"] = purl

            props = [
                {"name": "infoblox:component", "value": group},
                {"name": "infoblox:dependency-type", "value": dep.get("_dep_type", "referenced")},
                {"name": "infoblox:source-manifest", "value": dep.get("_source", "unknown")},
            ]
            for k, v in [("repository", "infoblox:repository"), ("branch", "infoblox:branch"),
                         ("commit", "infoblox:commit"), ("os", "infoblox:os"), ("osVersion", "infoblox:osVersion")]:
                if dep.get(k):
                    props.append({"name": v, "value": str(dep[k])})
            if dep.get("path"):
                pv = dep["path"]
                if isinstance(pv, list):
                    pv = ", ".join(str(p) for p in pv)
                props.append({"name": "infoblox:path", "value": str(pv)})

            comp["properties"] = props
            components.append(comp)

    return {
        "bomFormat": BOM_FORMAT, "specVersion": CYCLONEDX_SPEC_VERSION,
        "serialNumber": f"urn:uuid:{uuid.uuid4()}", "version": 1,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tools": [{"vendor": "Infoblox PSE", "name": "nios-sbom-pipeline", "version": "3.0.0"}],
            "component": {"type": "application", "name": project_name,
                          "version": project_version, "bom-ref": str(uuid.uuid4())}
        },
        "components": components
    }

# =============================================================================
# DEPENDENCY-TRACK CLIENT (with retry + enrichment wait + findings download)
# =============================================================================
class DTrackClient:
    def __init__(self, base_url, api_key, verify_ssl=False):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.verify_ssl = verify_ssl
        self.session = requests.Session()
        self.session.headers.update({"X-Api-Key": api_key, "Content-Type": "application/json"})
        self.session.verify = verify_ssl

    def upload_bom(self, project_name, project_version, bom_json, max_retries=3, project_uuid=None):
        """Upload BOM using PUT with base64-encoded JSON body (standard DTrack API)."""
        bom_str = json.dumps(bom_json)
        bom_b64 = base64.b64encode(bom_str.encode("utf-8")).decode("utf-8")

        payload = {"bom": bom_b64}
        if project_uuid:
            payload["project"] = project_uuid
        else:
            payload["projectName"] = project_name
            payload["projectVersion"] = project_version
            payload["autoCreate"] = True

        for attempt in range(1, max_retries + 1):
            try:
                print(f" Upload attempt {attempt}/{max_retries}...")
                resp = self.session.put(
                    f"{self.base_url}/api/v1/bom",
                    json=payload,
                    timeout=300
                )
                if resp.status_code == 200:
                    bom_token = None
                    try:
                        bom_token = resp.json().get("token")
                        print(f" ✅ BOM uploaded successfully (token: {bom_token})")
                    except Exception:
                        print(f" ✅ BOM uploaded successfully")
                    return True, bom_token
                else:
                    print(f" ❌ Upload failed: {resp.status_code} {resp.text[:300]}")
                    if attempt < max_retries:
                        print(f" ⏳ Retrying in 30 seconds...")
                        time.sleep(30)

            except requests.RequestException as e:
                print(f" ⚠️ Connection error: {e}")
                if attempt < max_retries:
                    print(f" ⏳ Retrying in 30 seconds...")
                    time.sleep(30)

        print(f" ❌ Upload failed after {max_retries} attempts")
        return False, None

    def lookup_project(self, name, version, max_wait=120):
        """Retry lookup for up to max_wait seconds — DTrack needs time to index large BOMs."""
        print(f" Looking up project '{name}' v'{version}' (retrying up to {max_wait}s)...")
        deadline = time.time() + max_wait
        attempt = 0
        while time.time() < deadline:
            attempt += 1
            wait = min(10 * attempt, 30)
            time.sleep(wait)
            try:
                # Primary: exact lookup by name + version
                resp = self.session.get(
                    f"{self.base_url}/api/v1/project/lookup",
                    params={"name": name, "version": version}, timeout=30
                )
                if resp.status_code == 200:
                    p = resp.json()
                    if isinstance(p, dict) and "uuid" in p:
                        print(f" Attempt {attempt}: found via lookup")
                        return p["uuid"]
                elif resp.status_code == 404:
                    print(f" Attempt {attempt}: 404 — not indexed yet, retrying in {min(10*(attempt+1),30)}s...")
                else:
                    print(f" Attempt {attempt}: unexpected HTTP {resp.status_code}")

                # Fallback: search by name across all projects
                resp2 = self.session.get(
                    f"{self.base_url}/api/v1/project",
                    params={"name": name, "excludeInactive": "false"}, timeout=30
                )
                if resp2.status_code == 200:
                    for p in (resp2.json() or []):
                        if p.get("name") == name and p.get("version") == version:
                            print(f" Attempt {attempt}: found via project search")
                            return p["uuid"]

            except Exception as e:
                print(f" Attempt {attempt}: lookup error — {e}")
        return None

    def add_tags(self, project_uuid, tags):
        try:
            resp = self.session.patch(
                f"{self.base_url}/api/v1/project/{project_uuid}",
                json={"uuid": project_uuid, "tags": [{"name": t} for t in tags]},
                timeout=30
            )
            if resp.status_code == 200:
                print(f" 🏷️ Tags: {', '.join(tags)}")
                return True
            else:
                print(f" ⚠️ Could not add tags (HTTP {resp.status_code})")
        except requests.RequestException as e:
            print(f" ⚠️ Could not add tags: {e}")
        return False

    def project_exists(self, project_uuid):
        """Return True when the provided project UUID exists and is accessible."""
        try:
            resp = self.session.get(
                f"{self.base_url}/api/v1/project/{project_uuid}",
                timeout=30
            )
            return resp.status_code == 200
        except requests.RequestException:
            return False

    def get_vuln_count(self, project_uuid):
        """Check current vulnerability count for a project."""
        try:
            resp = self.session.get(
                f"{self.base_url}/api/v1/project/{project_uuid}",
                timeout=30
            )
            if resp.status_code == 200:
                metrics = resp.json().get("metrics", {})
                return metrics.get("vulnerabilities", 0)
        except:
            pass
        return 0

    def wait_for_enrichment(self, project_uuid, wait_minutes=40, bom_token=None):
        """Wait for CVE enrichment for up to wait_minutes minutes."""
        print(f"\n ⏳ Waiting {wait_minutes} minutes for CVE enrichment (ingestion + enrichment run in parallel)...")
        last_count = 0
        for i in range(wait_minutes):
            time.sleep(60)
            current_count = self.get_vuln_count(project_uuid)
            print(f" {i+1}/{wait_minutes} min")
            last_count = current_count

        print(f" ✅ {wait_minutes} min wait complete")
        return last_count

    def download_findings(self, project_uuid):
        seen = {}
        offset = 0
        page_size = 5000
        stale = 0
        prev = 0

        while True:
            try:
                resp = self.session.get(
                    f"{self.base_url}/api/v1/finding/project/{project_uuid}",
                    params={"limit": page_size, "offset": offset}, timeout=120
                )
                if resp.status_code != 200:
                    break
                batch = resp.json()
                if not batch:
                    break

                for f in batch:
                    v = f.get("vulnerability", {})
                    c = f.get("component", {})
                    key = f"{v.get('vulnId','')}|{c.get('name','')}|{c.get('group','')}"
                    if key not in seen:
                        seen[key] = {"vulnerability": v, "component": c}

                cur = len(seen)
                print(f" Processed {offset + len(batch)} rows → {cur} unique CVE+component pairs")

                if cur == prev:
                    stale += 1
                    if stale >= 2:
                        break
                else:
                    stale = 0
                    prev = cur

                if len(batch) < page_size:
                    break
                offset += page_size

            except requests.RequestException as e:
                print(f" ❌ ERROR: {e}")
                break

        return seen

# =============================================================================
# MAIN
# =============================================================================
def main():
    parser = argparse.ArgumentParser(description="NIOS SBOM Pipeline v3 — Jenkins-Ready")

    input_group = parser.add_mutually_exclusive_group()
    input_group.add_argument("--sbom-url", help="SBOM directory URL on build-storage.inca")
    input_group.add_argument("--sbom-dir", help="Local SBOM directory")
    input_group.add_argument("--sbom-file", help="Path to a single SBOM YAML file")

    parser.add_argument("--dtrack-url", required=True, help="Dependency-Track API URL")
    parser.add_argument("--dtrack-api-key", required=True, help="Dependency-Track API key")

    parser.add_argument("--project-name", default=None, help="Override project name")
    parser.add_argument("--project-version", default=None, help="Override project version")
    parser.add_argument("--project-uuid", default=None, help="Upload to existing project by UUID (skips auto-create)")
    parser.add_argument("--dry-run", action="store_true", help="Generate CycloneDX but don't upload")
    parser.add_argument("--retry", type=int, default=3,
                        help="Retry upload N times on failure (default: 3)")
    parser.add_argument("--threads", type=int, default=10,
                        help="Threads for parallel YAML download (default: 10)")
    parser.add_argument("--output-json", default=None, help="Save CycloneDX JSON to file")
    parser.add_argument("--verify-ssl", action="store_true", default=False)

    # NEW: Export vulnerability findings JSON after enrichment
    parser.add_argument(
        "--output-findings-json",
        default=None,
        help="If set, download vulnerability findings from Dependency-Track and save them to this JSON file"
    )

    parser.add_argument(
        "--wait-minutes",
        type=int,
        default=40,
        help="Minutes to wait for Dependency-Track CVE enrichment before downloading findings (default: 40)"
    )

    args = parser.parse_args()

    if not args.sbom_url and not args.sbom_dir and not args.sbom_file:
        parser.error("--sbom-url, --sbom-dir, or --sbom-file required")

    session = requests.Session()
    session.verify = args.verify_ssl
    client = DTrackClient(args.dtrack_url, args.dtrack_api_key, args.verify_ssl)

    if args.project_uuid and not client.project_exists(args.project_uuid):
        print(f" ❌ Provided --project-uuid not found in this Dependency-Track instance: {args.project_uuid}")
        print(" Hint: remove --project-uuid to let Dependency-Track auto-create/lookup the project,")
        print("       or use a UUID from this instance and API key.")
        sys.exit(1)

    project_name = args.project_name
    project_version = args.project_version
    bom_token = None
    build_info = None

    # =========================================================================
    # PHASE 1: SBOM → CycloneDX → Dependency-Track (upload only)
    # =========================================================================
    source = args.sbom_url or args.sbom_dir or args.sbom_file
    build_info = extract_build_info(source) if source else None

    if build_info and not project_name:
        project_name = build_info["project_name"]
        project_version = build_info["project_version"]
        print(f"\n 📋 Auto-detected: {project_name} v{project_version}")
        print(f" Build: {build_info['build_number']} | Commit: {build_info['commit']} | Date: {build_info['date_str']}")
    else:
        project_name = project_name or "NIOS"
        project_version = project_version or "unknown"

    # Step 1: Discover YAMLs
    print(f"\n{'='*60}\nSTEP 1: Discovering YAML SBOM files...\n{'='*60}")
    if args.sbom_file:
        fname = os.path.basename(args.sbom_file)
        group = _guess_group(fname)
        grouped = {group: [args.sbom_file]}
    elif args.sbom_url:
        grouped = discover_and_group_yaml_urls(args.sbom_url, session)
    else:
        grouped = discover_and_group_yaml_files(args.sbom_dir)

    if not grouped:
        print(" ❌ No YAML files found!")
        sys.exit(1)

    total_files = sum(len(f) for f in grouped.values())
    print(f" Found {total_files} files in {len(grouped)} groups:")
    for g, f in sorted(grouped.items()):
        print(f" 📁 {g}/ → {len(f)} file(s)")

    # Step 2: Parse YAMLs (multithreaded for URL mode)
    print(f"\n{'='*60}\nSTEP 2: Parsing YAML manifests (parallel)...\n{'='*60}")
    component_deps = {}

    if args.sbom_url:
        fetched = fetch_all_yamls_parallel(grouped, session, max_workers=args.threads)
        for group, file_contents in fetched.items():
            deps = []
            for source_name, content in file_contents:
                deps.extend(parse_nios_yaml(content, source_name))
            if deps:
                ref = sum(1 for d in deps if d["_dep_type"] == "referenced")
                ven = sum(1 for d in deps if d["_dep_type"] == "vendored")
                print(f" 📁 {group}: {len(deps)} ({ref} referenced, {ven} vendored)")
                component_deps[group] = deps
    else:
        for group, files in sorted(grouped.items()):
            deps = []
            for src in files:
                try:
                    with open(src) as f:
                        deps.extend(parse_nios_yaml(f.read(), os.path.basename(src)))
                except IOError:
                    continue
            if deps:
                ref = sum(1 for d in deps if d["_dep_type"] == "referenced")
                ven = sum(1 for d in deps if d["_dep_type"] == "vendored")
                print(f" 📁 {group}: {len(deps)} ({ref} referenced, {ven} vendored)")
                component_deps[group] = deps

    total_deps = sum(len(d) for d in component_deps.values())
    print(f"\n Total: {total_deps} dependencies across {len(component_deps)} components")

    if not component_deps:
        print(" ❌ No dependencies found!")
        sys.exit(1)

    # Step 3: Convert to CycloneDX
    print(f"\n{'='*60}\nSTEP 3: Converting to CycloneDX 1.4...\n{'='*60}")
    bom = convert_to_cyclonedx(component_deps, project_name, project_version)
    num_comp = len(bom["components"])

    group_counts = {}
    for c in bom["components"]:
        g = c.get("group", "?")
        group_counts[g] = group_counts.get(g, 0) + 1
    print(f" {num_comp} components:")
    for g, n in sorted(group_counts.items()):
        print(f" 🏷️ {g}: {n}")

    if args.output_json:
        with open(args.output_json, "w") as f:
            json.dump(bom, f, indent=2)
        print(f" Saved: {args.output_json}")

    # Step 4: Upload
    if args.dry_run:
        print(f"\n ⚠️ DRY RUN — skipping upload")
    else:
        print(f"\n{'='*60}\nSTEP 4: Uploading to Dependency-Track...\n{'='*60}")
        print(f" Project: {project_name} v{project_version} ({num_comp} components)")

        uploaded, bom_token = client.upload_bom(project_name, project_version, bom, max_retries=args.retry, project_uuid=args.project_uuid)

        if not uploaded:
            print(" ❌ Upload failed — exiting")
            sys.exit(1)

        print(f" ✅ BOM submitted to DTrack — enrichment runs in background")

        # STEP 5: Optional – wait for enrichment and download findings as JSON
        if args.output_findings_json:
            print(f"\n{'='*60}\nSTEP 5: Waiting for enrichment and downloading findings...\n{'='*60}")

            # Look up the project we just uploaded to
            if args.project_uuid:
                project_uuid = args.project_uuid
                print(f" Using provided project UUID: {project_uuid}")
            else:
                project_uuid = client.lookup_project(
                    project_name, project_version,
                    max_wait=args.wait_minutes * 60
                )
            if not project_uuid:
                print(" ⚠️ Could not find project in Dependency-Track to download findings.")
            else:
                # Wait for CVE enrichment
                client.wait_for_enrichment(project_uuid, wait_minutes=args.wait_minutes, bom_token=bom_token)

                # Download findings
                findings = client.download_findings(project_uuid)

                # Write to JSON file
                try:
                    findings_payload = {
                        "project": {
                            "name": project_name,
                            "version": project_version,
                            "uuid": project_uuid,
                        },
                        "findings": list(findings.values()),
                        "meta": {
                            "generated_at": datetime.now(timezone.utc).isoformat(),
                            "source": "dependency_track",
                            "total_unique_findings": len(findings),
                            "dtrack_url": args.dtrack_url,
                        },
                    }
                    with open(args.output_findings_json, "w") as f:
                        json.dump(findings_payload, f, indent=2)
                    print(f" ✅ Saved vulnerability findings to: {args.output_findings_json}")
                    print(f" Findings written: {len(findings)}")
                except IOError as e:
                    print(f" ❌ Could not write findings JSON: {e}")

    # =========================================================================
    # SUMMARY
    # =========================================================================
    print(f"\n{'='*60}\nSUMMARY\n{'='*60}")
    print(f" Project: {project_name} v{project_version}")
    print(f" Components: {num_comp}")
    print(f" Groups: {', '.join(sorted(component_deps.keys()))}")
    if build_info:
        print(f" Build: {build_info['build_number']} | {build_info['date_str']}")
    print(f" DTrack: {args.dtrack_url}/projects (check in ~{args.wait_minutes} min)")
    print("=" * 60)

if __name__ == "__main__":
    main()