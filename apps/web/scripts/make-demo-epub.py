"""Builds public/demo/sample.epub, a tiny original story used by demo mode and screenshots.

Run: python3 apps/web/scripts/make-demo-epub.py
"""
import pathlib
import zipfile

OUT = pathlib.Path(__file__).resolve().parent.parent / "public" / "demo" / "sample.epub"

CHAPTERS = [
    (
        "The Missing Page",
        [
            "Barnaby the raccoon lived in the attic of the old town library, between a stack of atlases and a box of forgotten bookmarks.",
            "Every night, when the last lamp clicked off, he pushed his round glasses up his nose, tiptoed down the spiral stairs, and chose a book.",
            "Tonight he chose a story about a lighthouse. He read about the keeper, the fog, and the little boat lost at sea. He turned the page with a careful paw, ready to find out what happened next.",
            "But the next page was not there.",
            "Someone had torn it out, neatly, right along the spine. Barnaby gasped so loudly that a moth flew out of the encyclopedia.",
            "“A story with a hole in it,” he whispered, “is like a bridge with a plank missing. You can see the other side, but you can't get there.”",
        ],
    ),
    (
        "Clues in the Stacks",
        [
            "Barnaby was a careful raccoon. He did not panic. He made a list.",
            "First, he checked the return cart. Nothing there but a cookbook with flour on its cover.",
            "Next, he checked under the big reading table, where children sometimes dropped crayons and secrets. He found three crayons and a note that said I LIKE DINOSAURS.",
            "Then he noticed something in the moonlight: a tiny trail of paper crumbs leading toward the window.",
            "He followed the crumbs past the poetry shelf, past the comics, past the tall shelf of books about storms, until he reached the window ledge.",
            "There, curled up asleep on a folded piece of paper, was a very small mouse.",
        ],
    ),
    (
        "A Bed Made of Words",
        [
            "“Excuse me,” said Barnaby softly. “I think you are sleeping on my story.”",
            "The mouse opened one eye. “It's the warmest page in the whole library,” she said. “It has a lighthouse on it. Lighthouses are warm.”",
            "Barnaby thought about this. Then he climbed back up to the attic and came down with the softest thing he owned: a knitted scarf with books stitched along the edge.",
            "“Trade you,” he said.",
            "The mouse tried the scarf. She wriggled. She sighed. She smiled.",
            "Barnaby smoothed the page flat, slipped it back into the lighthouse book, and read the ending out loud, so the mouse could hear it too.",
            "The boat came home. The fog lifted. And from that night on, the library had two readers after dark.",
        ],
    ),
]

STYLE = "body{font-family:serif;margin:0 5%;line-height:1.5} h1{text-align:center;margin:2em 0 1em} p{text-indent:1.5em;margin:0 0 .4em}"


def xhtml(title: str, body: str) -> str:
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>{title}</title><link rel="stylesheet" href="style.css"/></head>
<body>{body}</body></html>"""


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        manifest, spine, nav = [], [], []
        for i, (title, paras) in enumerate(CHAPTERS, 1):
            body = f"<section epub:type=\"chapter\"><h1>Chapter {i}<br/>{title}</h1>" + "".join(f"<p>{p}</p>" for p in paras * 3) + "</section>"
            z.writestr(f"OEBPS/ch{i}.xhtml", xhtml(title, body), compress_type=zipfile.ZIP_DEFLATED)
            manifest.append(f'<item id="ch{i}" href="ch{i}.xhtml" media-type="application/xhtml+xml"/>')
            spine.append(f'<itemref idref="ch{i}"/>')
            nav.append(f'<li><a href="ch{i}.xhtml">Chapter {i}: {title}</a></li>')
        z.writestr("OEBPS/style.css", STYLE)
        z.writestr(
            "OEBPS/nav.xhtml",
            xhtml("Contents", f'<nav epub:type="toc"><h1>Contents</h1><ol>{"".join(nav)}</ol></nav>'),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        z.writestr(
            "OEBPS/content.opf",
            f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:9b1c6a52-bookbandit-demo</dc:identifier>
<dc:title>Barnaby and the Missing Page</dc:title><dc:creator>BookBandit</dc:creator><dc:language>en</dc:language>
<meta property="dcterms:modified">2026-11-14T00:00:00Z</meta>
</metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>{"".join(manifest)}</manifest>
<spine>{"".join(spine)}</spine>
</package>""",
            compress_type=zipfile.ZIP_DEFLATED,
        )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
