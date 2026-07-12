#!/usr/bin/env python3
"""Extract yellow-highlighted text (= changes from prior year) from the ODFW
Big Game Synopsis PDF, with surrounding paragraph context.

Usage: python3 scrape-synopsis.py <synopsis.pdf>
Prints a JSON array to stdout:
  [{"p": pageNum, "h": "nearest bold heading or null",
    "hl": ["highlighted text", ...], "ctx": "surrounding paragraph"}]

Detection: the synopsis marks year-over-year changes with a yellow fill
rectangle behind the text (vector shape, not an annotation). We find those
rects by color, then collect the words they cover, then expand to the
enclosing lines for context. Ads/graphics are filtered by rect size and by
requiring the rect to actually cover words of body-text size.
"""
import sys, json, re
import pdfplumber


def is_yellow(color):
    """True for yellow-ish fills in RGB (3-tuple) or CMYK (4-tuple).
    Yellow = high red, high green, low blue. Kept distinct from the salmon/
    orange 'private lands' bars (those have lower green relative to red)."""
    if color is None:
        return False
    try:
        c = tuple(float(x) for x in color)
    except (TypeError, ValueError):
        return False
    if len(c) == 1:  # grayscale can't be yellow
        return False
    if len(c) == 3:
        r, g, b = c
        return r > 0.80 and g > 0.68 and b < 0.60 and (g - b) > 0.20 and (r - b) > 0.20
    if len(c) == 4:
        cy, m, y, k = c
        return cy < 0.30 and m < 0.38 and y > 0.45 and k < 0.25
    return False


def rect_words(rect, words):
    """Words whose center falls inside the rect (slightly expanded)."""
    x0, top, x1, bottom = rect["x0"] - 1, rect["top"] - 1, rect["x1"] + 1, rect["bottom"] + 1
    out = []
    for w in words:
        cx = (w["x0"] + w["x1"]) / 2
        cy = (w["top"] + w["bottom"]) / 2
        if x0 <= cx <= x1 and top <= cy <= bottom:
            out.append(w)
    return out


def cluster_rects(rects):
    """Merge rects that are vertically adjacent in the same column
    (multi-line highlights come through as one rect per line)."""
    rects = sorted(rects, key=lambda r: (r["top"], r["x0"]))
    clusters = []
    for r in rects:
        placed = False
        for cl in clusters:
            # same column (x overlap) and small vertical gap
            xov = min(cl["x1"], r["x1"]) - max(cl["x0"], r["x0"])
            vgap = r["top"] - cl["bottom"]
            if xov > 6 and -4 <= vgap <= 8:
                cl["x0"] = min(cl["x0"], r["x0"]); cl["x1"] = max(cl["x1"], r["x1"])
                cl["top"] = min(cl["top"], r["top"]); cl["bottom"] = max(cl["bottom"], r["bottom"])
                cl["rects"].append(r)
                placed = True
                break
        if not placed:
            clusters.append({"x0": r["x0"], "x1": r["x1"], "top": r["top"],
                             "bottom": r["bottom"], "rects": [r]})
    return clusters


def group_lines(words, tol=2.5, gutter=18):
    """Group words into lines by top coordinate, then split each visual line
    at large horizontal gaps so multi-column pages don't merge into one line."""
    rows = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if rows and abs(w["top"] - rows[-1][0]) <= tol:
            rows[-1][1].append(w)
        else:
            rows.append([w["top"], [w]])
    lines = []
    for _, ws in rows:
        ws.sort(key=lambda w: w["x0"])
        seg = [ws[0]]
        for w in ws[1:]:
            if w["x0"] - seg[-1]["x1"] > gutter:
                lines.append(seg); seg = [w]
            else:
                seg.append(w)
        lines.append(seg)
    out = []
    for seg in lines:
        out.append({"top": min(w["top"] for w in seg),
                    "bottom": max(w["bottom"] for w in seg),
                    "x0": seg[0]["x0"], "x1": seg[-1]["x1"],
                    "words": seg,
                    "text": " ".join(w["text"] for w in seg)})
    out.sort(key=lambda l: (l["top"], l["x0"]))
    return out


def line_in_column(line, col_x0, col_x1):
    """Does this line belong to the column x-range? (>=50% overlap)"""
    ov = min(line["x1"], col_x1) - max(line["x0"], col_x0)
    return ov > 0.5 * min(line["x1"] - line["x0"], col_x1 - col_x0)


BULLET_RE = re.compile(r"^(\(cid:\d+\)|[•●▪·>-])\s|^[A-Z][a-z]+.*:$")


def extract(pdf_path, debug=False):
    out = []
    with pdfplumber.open(pdf_path) as pdf:
        for pno, page in enumerate(pdf.pages, 1):
            # Yellow highlights show up in different PDF primitives depending on
            # how the layout tool drew them: rectangles, filled curves/paths, or
            # (rarely) highlight annotations. Gather candidates from all three.
            shapes = list(page.rects) + list(page.curves)
            yrects = []
            for r in shapes:
                col = r.get("non_stroking_color")
                if col is None:
                    col = r.get("fill") if isinstance(r.get("fill"), (list, tuple)) else None
                if not is_yellow(col):
                    continue
                h = r["bottom"] - r["top"]; wdt = r["x1"] - r["x0"]
                if not (3 <= h <= 40 and 6 <= wdt <= page.width * 0.85):
                    continue  # graphics / ad blocks / page bands
                yrects.append({"x0": r["x0"], "x1": r["x1"], "top": r["top"], "bottom": r["bottom"]})
            # highlight annotations (subtype 'Highlight') carry a quadpoint rect
            for a in (page.annots or []):
                sub = (a.get("data", {}) or {}).get("Subtype")
                sub = getattr(sub, "name", sub)
                if str(sub) == "Highlight":
                    yrects.append({"x0": a["x0"], "x1": a["x1"], "top": a["top"], "bottom": a["bottom"]})

            n_raw = len(yrects)
            if not yrects:
                if debug:
                    ny = sum(1 for r in shapes if is_yellow(r.get("non_stroking_color")))
                    print(f"[dbg] pg {pno}: 0 highlight rects (shapes={len(shapes)}, yellow-but-filtered={ny})", file=sys.stderr)
                continue
            words = page.extract_words(extra_attrs=["fontname", "size"])
            body_words = [w for w in words if 5.5 <= w.get("size", 10) <= 18]
            yrects = [r for r in yrects if rect_words(r, body_words)]
            if debug:
                print(f"[dbg] pg {pno}: {n_raw} raw -> {len(yrects)} over-text highlight rects", file=sys.stderr)
            if not yrects:
                continue
            lines = group_lines(body_words)
            med_lh = 12.0
            gaps = [b["top"] - a["bottom"] for a, b in zip(lines, lines[1:])
                    if 0 < b["top"] - a["bottom"] < 30]
            if gaps:
                gaps.sort(); med_lh = max(6.0, gaps[len(gaps) // 2]) + 10

            for cl in cluster_rects(yrects):
                hl_words = []
                for r in cl["rects"]:
                    hl_words.extend(rect_words(r, body_words))
                if not hl_words:
                    continue
                seen = set(); uniq = []
                for w in sorted(hl_words, key=lambda w: (w["top"], w["x0"])):
                    k = (round(w["top"]), round(w["x0"]))
                    if k in seen: continue
                    seen.add(k); uniq.append(w)
                hl_text = re.sub(r"\(cid:\d+\)\s*", "", " ".join(w["text"] for w in uniq)).strip()
                if len(hl_text) < 3:
                    continue

                # column bounds = extent of the lines the highlight sits on
                hl_keys = {(round(w["top"]), round(w["x0"])) for w in uniq}
                hl_line_idx = [i for i, ln in enumerate(lines)
                               if any((round(w["top"]), round(w["x0"])) in hl_keys for w in ln["words"])]
                if not hl_line_idx:
                    continue
                col_x0 = min(lines[i]["x0"] for i in hl_line_idx) - 8
                col_x1 = max(lines[i]["x1"] for i in hl_line_idx) + 8

                # work within THIS column only (multi-column pages interleave
                # line segments left-to-right at each height)
                col_idx = [i for i, ln in enumerate(lines)
                           if line_in_column(ln, col_x0, col_x1)]
                pos = [col_idx.index(i) for i in hl_line_idx if i in col_idx]
                if not pos:
                    continue
                lo, hi = min(pos), max(pos)
                for _ in range(5):
                    if lo == 0: break
                    prev, cur = lines[col_idx[lo - 1]], lines[col_idx[lo]]
                    if cur["top"] - prev["bottom"] > med_lh: break
                    lo -= 1
                    if BULLET_RE.match(prev["text"]): break
                for _ in range(5):
                    if hi >= len(col_idx) - 1: break
                    nxt, cur = lines[col_idx[hi + 1]], lines[col_idx[hi]]
                    if nxt["top"] - cur["bottom"] > med_lh: break
                    if BULLET_RE.match(nxt["text"]): break
                    hi += 1
                ctx = " ".join(lines[col_idx[k]]["text"] for k in range(lo, hi + 1))
                ctx = re.sub(r"\(cid:\d+\)", "•", ctx)
                ctx = re.sub(r"\s+", " ", ctx).strip()

                # nearest bold heading above, same column, within 300pt
                heading = None
                first_top = lines[col_idx[lo]]["top"]
                for k in reversed(col_idx[:lo]):
                    ln = lines[k]
                    if first_top - ln["bottom"] > 300: break
                    fonts = [w.get("fontname", "") for w in ln["words"]]
                    if fonts and sum(1 for f in fonts if re.search(r"bold|black|semib|heavy", f, re.I)) >= max(1, len(fonts) // 2):
                        heading = re.sub(r"\(cid:\d+\)\s*", "", ln["text"]).strip()
                        break

                out.append({"p": pno, "h": heading, "hl": hl_text, "ctx": ctx})

    # de-duplicate identical entries (same highlight + context)
    seen = set(); final = []
    for e in out:
        k = (e["hl"], e["ctx"][:80])
        if k in seen: continue
        seen.add(k); final.append(e)
    return final


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    debug = "--debug" in sys.argv
    if len(args) != 1:
        print("usage: scrape-synopsis.py [--debug] <pdf>", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(extract(args[0], debug=debug)))
