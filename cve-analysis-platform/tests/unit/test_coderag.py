from pathlib import Path

from apps.coderag.indexer import build_index, IndexerConfig
from apps.coderag.retriever import Retriever, RetrievalConfig
from apps.coderag.file_fetch import grep_keyword_windows, fetch_exact_window


def _make_repo(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "ssl_handler.py").write_text(
        "import ssl\n\nclass OpenSSLHandler:\n    def verify(self, cert):\n"
        "        # NOTE: openssl verification path\n        return True\n"
    )
    (tmp_path / "src" / "unrelated.py").write_text("def add(a, b):\n    return a + b\n")
    return tmp_path


def test_index_and_retrieve(tmp_path: Path):
    repo = _make_repo(tmp_path)
    out = tmp_path / "index"
    meta = build_index(repo, out, IndexerConfig(chunk_lines=20, chunk_overlap=5))
    assert meta["chunks"] >= 1

    r = Retriever(RetrievalConfig(max_files_per_query=5, fallback_score_threshold=0.05))
    res = r.retrieve(
        index_dir=out,
        repo_root=repo,
        component_name="openssl",
        cve_id="CVE-2024-1234",
    )
    assert res["source"] in ("index", "file_fetch")
    assert any("ssl_handler.py" in h["path"] for h in res["hits"])


def test_file_fetch_fallback_when_no_index(tmp_path: Path):
    repo = _make_repo(tmp_path)
    hits = grep_keyword_windows(repo, ["openssl"], window_lines=10, max_files=3)
    assert any("ssl_handler.py" in h["path"] for h in hits)


def test_fetch_exact_window_is_path_safe(tmp_path: Path):
    repo = _make_repo(tmp_path)
    assert fetch_exact_window(repo, "../etc/passwd", 1, 5) is None
    got = fetch_exact_window(repo, "src/ssl_handler.py", 1, 3)
    assert got is not None
    assert "import ssl" in got["snippet"]
