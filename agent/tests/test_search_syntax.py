from src.search_syntax import parse_search


def test_plain_text_passes_through_untouched():
    q = '"father and son" -weir rocky or estraven'
    assert parse_search(q) == {"query": q}


def test_empty_and_whitespace_only_input():
    assert parse_search("") == {}
    assert parse_search("   ") == {}


def test_field_filters_come_out_of_the_text():
    assert parse_search("genre:horror hotel") == {"query": "hotel", "genre": "horror"}


def test_field_names_are_case_insensitive_values_kept_as_typed():
    assert parse_search("Author:Le-Guin") == {"author": "Le-Guin"}


def test_quoted_values():
    assert parse_search('author:"le guin" space') == {"author": "le guin", "query": "space"}


def test_an_unclosed_quote_runs_to_the_end():
    assert parse_search('space author:"le guin') == {"query": "space", "author": "le guin"}


def test_a_filter_inside_a_quoted_phrase_stays_part_of_the_phrase():
    assert parse_search('"the author:x"') == {"query": '"the author:x"'}


def test_negated_filters_collect_into_a_list():
    assert parse_search("-genre:horror -genre:romance -reviewer:sam") == {
        "exclude_genres": ["horror", "romance"],
        "exclude_reviewers": ["sam"],
    }


def test_a_repeated_field_keeps_the_last_value():
    assert parse_search("author:a author:b") == {"author": "b"}


def test_unknown_fields_and_empty_values_stay_as_text():
    assert parse_search("foo:bar title:") == {"query": "foo:bar title:"}


def test_rating_comparisons():
    def rng(s):
        args = parse_search(s)
        return args["min_rating"], args["max_rating"]

    assert rng("rating:5") == (5, 5)
    assert rng("rating:=3") == (3, 3)
    assert rng("rating:>=4") == (4, 5)
    assert rng("rating:>3") == (4, 5)
    assert rng("rating:<=2") == (1, 2)
    assert rng("rating:<3") == (1, 2)
    assert rng("rating:>=2 rating:<5") == (2, 4)


def test_bad_or_negated_ratings_stay_as_text():
    q = "rating:great rating:6 -rating:5"
    assert parse_search(q) == {"query": q}
