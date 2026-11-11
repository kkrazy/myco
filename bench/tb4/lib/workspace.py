# tb4/lib/workspace.py — materialize a TB4 task's /app workspace on the host.
#
# Each task's environment image (tasks/<name>/environment/Dockerfile) sets up
# the initial task state under `/app` (data + sources). We build that image once
# per task and `docker cp` its /app contents out to a host seed dir, which the
# harness then copies into per-agent workspaces (single/, n2/). Docker is used
# ONLY for workspace materialization + verification — the agents themselves run
# on the host (bench user decision).
import os
import re
import shlex
import shutil
import subprocess
import tempfile


def sh(cmd, timeout=None):
    """Run a shell command, return CompletedProcess (captured)."""
    return subprocess.run(cmd, shell=True, capture_output=True, text=True,
                          timeout=timeout)


def image_exists(tag):
    return sh(f'docker image inspect {tag} >/dev/null 2>&1').returncode == 0


def _proxy():
    """Proxy for BuildKit RUN steps.

    The docker daemon pulls base images through its OWN system proxy (so
    `docker pull` works on this host even though direct curl is blocked), but
    `docker build` RUN steps do NOT inherit it — worse, BuildKit's own base-image
    metadata fetch times out. So we: (1) pre-pull base refs via `docker pull`
    (daemon proxy), and (2) pass the proxy as a build-arg so in-image installs
    (uv/pip/conda/apt hitting pypi/npm/conda) can reach the internet.

    Set the proxy URL in TB4_BUILD_PROXY, or rely on HTTPS_PROXY/HTTP_PROXY.
    """
    return (os.environ.get('TB4_BUILD_PROXY')
            or os.environ.get('HTTPS_PROXY')
            or os.environ.get('HTTP_PROXY')) or None


def _base_images(dockerfile_dir):
    """FROM / COPY --from refs a build needs (also COPY --from multi-stage)."""
    refs = set()
    try:
        with open(os.path.join(dockerfile_dir, 'Dockerfile'), encoding='utf-8') as f:
            for line in f:
                # Note: some Dockerfiles write `COPY --from=<img>` with no space
                # between `=` and the image ref (e.g. the uv bootstrap image
                # `COPY --from=ghcr.io/astral-sh/uv@sha256:...`). Use `\s*` so
                # those atomic refs are caught and pre-pulled like FROM refs.
                m = re.match(r'\s*(?:FROM|COPY --from=)\s*"?([^\s"]+)"?', line)
                if m:
                    refs.add(m.group(1))
    except OSError:
        pass
    return refs


def _enterprise_ca_certs():
    """Locate the corporate/proxy CA certs installed on the HOST trust store.

    On this host the internet is only reachable through an enterprise proxy that
    terminates TLS with its own "Huawei Web Secure Internet Gateway CA" -- the
    HOST trusts it (files dropped in /usr/local/share/ca-certificates/), but a
    build container does NOT, so `uv sync`/`git` clones of github deps fail with
    `invalid peer certificate: UnknownIssuer`. Return a list of cert paths to
    inject into build containers so in-image installs can validate the proxy.
    """
    cert_dirs = ['/usr/local/share/ca-certificates',
                 os.environ.get('MYCO_CA_CERT_DIR', '')]
    certs = []
    for d in cert_dirs:
        if not d or not os.path.isdir(d):
            continue
        for n in sorted(os.listdir(d)):
            if n.lower().endswith('.crt'):
                p = os.path.join(d, n)
                if os.path.isfile(p) and p not in certs:
                    certs.append(p)
    return certs


def _patched_context(build_dir, proxy):
    """Return (build_dir, dockerfile_name) for a docker build.

    When building over the proxy, copy the task's build dir into a fresh temp
    context and patch the Dockerfile to trust the corporate CA (COPY the host's
    CA certs + update-ca-certificates + point uv/git at the system bundle), so
    `RUN` steps that hit github/pypi through the MITM proxy don't fail TLS
    validation. Without a proxy (or without host CA certs) this is a no-op and
    the original dir/Dockerfile are used unchanged, keeping offline builds
    byte-identical.
    """
    dockerfile = os.path.join(build_dir, 'Dockerfile')
    if not proxy or not _enterprise_ca_certs():
        return build_dir, dockerfile
    ctx = tempfile.mkdtemp(prefix='tb4-ctx-')
    for f in os.listdir(build_dir):
        p = os.path.join(build_dir, f)
        dst = os.path.join(ctx, f)
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.copytree(p, dst)
        else:
            shutil.copy2(p, dst, follow_symlinks=True)
    ca_dir = os.path.join(ctx, 'ca')
    os.makedirs(ca_dir, exist_ok=True)
    for i, c in enumerate(_enterprise_ca_certs()):
        shutil.copy2(c, os.path.join(ca_dir, f'ca{i}.crt'))

    # Insert the trust setup right after the LAST FROM line (multi-stage builds
    # can COPY --from later, but every FROM defines a stage whose RUN steps need
    # the trust; injecting after the first FROM covers the deps stage we care
    # about). We add it after the first FROM so the deps RUN step sees it.
    lines = []
    inserted = False
    certs = _enterprise_ca_certs()
    copy_line = ('COPY ca/ /usr/local/share/ca-certificates/\n'
                 if len(certs) > 4 else
                 'COPY ' + ' '.join(f'ca/ca{i}.crt' for i in range(len(certs)))
                 + ' /usr/local/share/ca-certificates/\n')
    with open(dockerfile, encoding='utf-8') as f:
        for line in f:
            lines.append(line)
            if not inserted and line.lstrip().startswith('FROM '):
                lines += [
                    copy_line,
                    'RUN sh -c \'command -v update-ca-certificates >/dev/null 2>&1 '
                    '&& update-ca-certificates || '
                    '(apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq ca-certificates >/dev/null 2>&1 '
                    '&& update-ca-certificates) || true\'\n',
                    'ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt\n',
                    'ENV UV_SYSTEM_CERTS=1\n',
                ]
                inserted = True
    patched = os.path.join(ctx, 'Dockerfile')
    with open(patched, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    return ctx, patched


def _build_cmd(proxy, refs, tag, dockerfile, build_dir):
    """Compose a docker build invocation: pre-pull base refs (daemon proxy so
    they land locally and BuildKit doesn't time out fetching metadata), then
    build with proxy build-args so RUN steps can reach the network.
    When proxy + host CA certs are present, `build_dir`/`dockerfile` are swapped
    for a CA-trusting patched context (see _patched_context)."""
    ctx_dir, ctx_dockerfile = _patched_context(build_dir, proxy)
    for ref in refs:
        sh(f'docker pull {shlex.quote(ref)}', timeout=900)
    args = ['docker', 'build']
    if proxy:
        for k in ('HTTP_PROXY', 'HTTPS_PROXY'):
            args += ['--build-arg', f'{k}={proxy}']
        args += ['--build-arg',
                 f'NO_PROXY={os.environ.get("NO_PROXY", "localhost,127.0.0.1")}']
    args += ['-t', tag, '-f', ctx_dockerfile, ctx_dir]
    return ' '.join(shlex.quote(a) for a in args)


def _rmtree_contents(d):
    for f in os.listdir(d):
        p = os.path.join(d, f)
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.remove(p)


def build_env_image(task, tag, build_timeout=900):
    """Build the task's environment image to `tag` if not already present."""
    if image_exists(tag):
        return
    cmd = _build_cmd(_proxy(), _base_images(task['env_dir']), tag,
                     os.path.join(task['env_dir'], 'Dockerfile'),
                     task['env_dir'])
    r = sh(cmd, timeout=build_timeout)
    if r.returncode != 0:
        raise RuntimeError(f'[tb4:workspace] build {task["name"]} env failed:\n'
                           + (r.stdout + r.stderr)[-2500:])


def materialize_workspace(task, seed_dir, tag, build_timeout=900):
    """Extract the task's /app into `seed_dir` (re-creating its contents)."""
    build_env_image(task, tag, build_timeout)
    r = sh(f'docker create {tag}', timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f'[tb4:workspace] docker create {tag} failed:\n'
                           + (r.stdout + r.stderr)[-1200:])
    cid = r.stdout.strip().splitlines()[-1]
    try:
        os.makedirs(seed_dir, exist_ok=True)
        _rmtree_contents(seed_dir)
        r = sh(f'docker cp {cid}:/app/. "{seed_dir}/"', timeout=600)
        if r.returncode != 0:
            raise RuntimeError(f'[tb4:workspace] docker cp /app failed:\n'
                               + (r.stdout + r.stderr)[-1200:])
    finally:
        sh(f'docker rm {cid} >/dev/null 2>&1')


def copy_workspace(seed_dir, dest_dir):
    """Copy a materialized seed workspace into a per-agent workspace."""
    os.makedirs(dest_dir, exist_ok=True)
    _rmtree_contents(dest_dir)
    for f in os.listdir(seed_dir):
        src = os.path.join(seed_dir, f)
        dst = os.path.join(dest_dir, f)
        if os.path.isdir(src) and not os.path.islink(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst, follow_symlinks=True)
