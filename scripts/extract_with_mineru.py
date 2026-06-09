#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from html.parser import HTMLParser
from pathlib import Path


STRUCTURE_KEYS = ("para_blocks", "blocks", "lines", "spans")
IGNORE_KEYS = {
    "bbox",
    "score",
    "cls_id",
    "index",
    "page_idx",
    "page_size",
    "position",
    "type",
    "block_id",
    "line_id",
    "span_id",
}


class TableHtmlParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.current_row = []
        self.current_cell = []
        self.in_cell = False

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.current_row = []
        elif tag in ("td", "th"):
            self.in_cell = True
            self.current_cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            cell = "".join(self.current_cell).strip()
            self.current_row.append(re.sub(r"\s+", " ", cell))
            self.current_cell = []
            self.in_cell = False
        elif tag == "tr" and self.current_row:
            self.rows.append(self.current_row)
            self.current_row = []

    def handle_data(self, data):
        if self.in_cell:
            self.current_cell.append(data)


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", text)).strip()


def html_table_to_markdown(html: str) -> str:
    parser = TableHtmlParser()
    parser.feed(html)
    rows = [row for row in parser.rows if any(cell.strip() for cell in row)]
    if not rows:
      return normalize_whitespace(re.sub(r"<[^>]+>", " ", html))

    width = max(len(row) for row in rows)
    padded = [row + [""] * (width - len(row)) for row in rows]
    header = padded[0]
    separator = ["---"] * width
    body = padded[1:] if len(padded) > 1 else []
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(separator) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in body)
    return "\n".join(lines)


def format_latex(value: str) -> str:
    text = normalize_whitespace(value)
    if not text:
        return ""
    if "\n" in text or len(text) > 48:
        return f"$$\n{text}\n$$"
    return f"${text}$"


def format_block_text(block_type: str | None, content: str) -> str:
    if not content:
        return ""
    normalized = normalize_whitespace(content)
    if not normalized:
        return ""

    heading_types = {"doc_title", "title", "section_title", "page_title"}
    bullet_types = {"list", "list_item", "unordered_list", "bullet_list"}
    ordered_types = {"ordered_list", "enum_list"}
    quote_types = {"quote", "blockquote"}

    if block_type in heading_types:
        if normalized.startswith("#"):
            return normalized
        return f"## {normalized}"
    if block_type in bullet_types:
        return f"- {normalized.lstrip('- ').strip()}"
    if block_type in ordered_types:
        return f"1. {normalized.lstrip('0123456789. ').strip()}"
    if block_type in quote_types:
        return f"> {normalized}"
    return normalized


def extract_text(node, seen: set[str] | None = None) -> str:
    if seen is None:
        seen = set()

    if node is None:
        return ""
    if isinstance(node, str):
        text = normalize_whitespace(node)
        if not text or text in seen:
            return ""
        seen.add(text)
        return text
    if isinstance(node, list):
        parts = [extract_text(item, seen) for item in node]
        return normalize_whitespace("\n\n".join(part for part in parts if part))
    if not isinstance(node, dict):
        return ""

    block_type = node.get("type")

    if isinstance(node.get("html"), str) and "<table" in node["html"].lower():
        table_md = html_table_to_markdown(node["html"])
        if table_md and table_md not in seen:
            seen.add(table_md)
            return table_md

    if isinstance(node.get("latex"), str):
        latex = format_latex(node["latex"])
        if latex and latex not in seen:
            seen.add(latex)
            return latex

    for key in ("md", "markdown", "content", "text"):
        value = node.get(key)
        if isinstance(value, str):
            formatted = format_block_text(block_type, value)
            if formatted and formatted not in seen:
                seen.add(formatted)
                return formatted

    parts = []
    for key in STRUCTURE_KEYS:
        if key in node:
            nested = extract_text(node[key], seen)
            if nested:
                parts.append(nested)

    if parts:
        return normalize_whitespace("\n\n".join(parts))

    for key, value in node.items():
        if key in IGNORE_KEYS:
            continue
        nested = extract_text(value, seen)
        if nested:
            parts.append(nested)

    return normalize_whitespace("\n\n".join(parts))


def build_pages_from_middle_json(middle_json: dict) -> list[dict]:
    pages = []
    pdf_info = middle_json.get("pdf_info", [])
    for page in pdf_info:
        page_idx = page.get("page_idx", len(pages))
        page_parts = []
        seen = set()

        for key in ("para_blocks", "tables", "images", "interline_equations"):
            if key in page:
                value = extract_text(page[key], seen)
                if value:
                    page_parts.append(value)

        text = normalize_whitespace("\n\n".join(part for part in page_parts if part))
        pages.append(
            {
                "pageNumber": int(page_idx) + 1,
                "text": text,
            }
        )
    return pages


def find_first(path: Path, pattern: str) -> Path | None:
    matches = sorted(path.rglob(pattern))
    return matches[0] if matches else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--mineru-bin", default=os.environ.get("MINERU_BIN", "mineru"))
    parser.add_argument("--backend", default=os.environ.get("MINERU_BACKEND", "hybrid-auto-engine"))
    parser.add_argument("--method", default=os.environ.get("MINERU_METHOD", "auto"))
    args = parser.parse_args()

    if shutil.which(args.mineru_bin) is None:
        print(
            json.dumps(
                {
                    "error": f"MinerU command not found: {args.mineru_bin}. Install MinerU and ensure the command is available in PATH."
                }
            )
        )
        return 2

    with tempfile.TemporaryDirectory(prefix="paper-reader-mineru-") as temp_dir:
        env = os.environ.copy()
        process = subprocess.run(
            [
                args.mineru_bin,
                "-p",
                args.pdf,
                "-o",
                temp_dir,
                "-b",
                args.backend,
                "-m",
                args.method,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )

        if process.returncode != 0:
            print(
                json.dumps(
                    {
                        "error": "MinerU parsing failed.",
                        "stdout": process.stdout,
                        "stderr": process.stderr,
                    }
                )
            )
            return process.returncode

        output_dir = Path(temp_dir)
        middle_json_path = find_first(output_dir, "*_middle.json")
        markdown_path = find_first(output_dir, "*.md")

        if middle_json_path is None:
            print(
                json.dumps(
                    {
                        "error": "MinerU output did not contain a *_middle.json file.",
                        "stdout": process.stdout,
                        "stderr": process.stderr,
                    }
                )
            )
            return 3

        middle_json = json.loads(middle_json_path.read_text())
        pages = build_pages_from_middle_json(middle_json)
        markdown = markdown_path.read_text() if markdown_path and markdown_path.exists() else ""

        print(
            json.dumps(
                {
                    "pageCount": len(pages),
                    "pages": pages,
                    "markdown": markdown,
                    "backend": middle_json.get("_backend", ""),
                }
            )
        )
        return 0


if __name__ == "__main__":
    sys.exit(main())
