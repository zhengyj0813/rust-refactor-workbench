pub(super) fn score(value: String) -> usize {
    value.split_whitespace().map(str::len).sum()
}
