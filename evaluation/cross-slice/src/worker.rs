pub(super) fn count(values: Vec<u8>) -> usize {
    values.iter().filter(|&&value| value % 2 == 0).count()
}
