"""Parses the search box syntax into reviews.search() arguments. The SQL
function itself only takes structured filters.

  title:x  author:x  genre:x  reviewer:x   field contains x, any case;
                                           quote values with spaces:
                                           author:"le guin"
  -genre:x                                 field doesn't contain x
  rating:5  rating:>=4  rating:<3          stars (=, >, >=, <, <=)

Everything else is left as free text for websearch_to_tsquery, including
"quoted phrases" (a filter inside one stays part of the phrase), unknown
fields ("foo:bar"), negated ratings and ratings that aren't 1-5.
"""

import re

TEXT_FIELDS = ("title", "author", "genre", "reviewer")

# One token: an optional "-", an optional "field:", then a "quoted value" (an
# unclosed quote runs to the end) or a run of non-space characters.
_TOKEN = re.compile(r'(-?)(?:([a-z]+):)?("[^"]*(?:"|\Z)|\S+)', re.IGNORECASE)
_RATING = re.compile(r"(>=|<=|>|<|=)?([1-5])\Z")


def parse_search(text: str) -> dict:
    """Keyword arguments for reviews.search(); filters that weren't used are
    left out."""
    args: dict = {}
    rest: list[str] = []

    i = 0
    while i < len(text):
        if text[i].isspace():
            i += 1
            continue
        m = _TOKEN.match(text, i)  # always matches at a non-space character
        i = m.end()
        raw, neg, field, value = m.group(0), m.group(1), (m.group(2) or "").lower(), _unquote(m.group(3))

        if field in TEXT_FIELDS and value:
            if neg:
                args.setdefault(f"exclude_{field}s", []).append(value)
            else:
                args[field] = value  # a repeated field: the last one wins
        elif not (field == "rating" and not neg and _apply_rating(args, value)):
            rest.append(raw)

    if rest:
        args["query"] = " ".join(rest)
    return args


def _unquote(v: str) -> str:
    if not v.startswith('"'):
        return v
    return (v[1:-1] if v.endswith('"') and len(v) > 1 else v[1:]).strip()


def _apply_rating(args: dict, value: str) -> bool:
    """Narrows the rating range; several rating filters intersect. Returns
    False for a value that isn't a comparison with 1-5, so it stays as text."""
    m = _RATING.match(value)
    if not m:
        return False
    n = int(m.group(2))
    lo, hi = {">=": (n, 5), ">": (n + 1, 5), "<=": (1, n), "<": (1, n - 1), "=": (n, n)}[m.group(1) or "="]
    args["min_rating"] = max(args.get("min_rating", 1), lo)
    args["max_rating"] = min(args.get("max_rating", 5), hi)
    return True
